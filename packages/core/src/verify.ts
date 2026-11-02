import bs58 from "bs58";
import { checkAttestation, checkRequestBinding } from "./attestation.js";
import { KNOWN_VAULT_CODE_HASHES } from "./code-hashes.js";
import { NETWORKS, WITHDRAW_MEMO_PREFIX } from "./constants.js";
import { canonicalJson } from "./hash.js";
import { bytesToHex, ZERO_HEX32 } from "./hex.js";
import {
  computeBodyHash,
  computeLink,
  computeNonce,
  verifyEntrySignature,
  ZERO_LINK,
} from "./ledger.js";
import { KNOWN_SYSTEM_PROMPT_HASHES, type KnownSystemPrompt } from "./proposal-request.js";
import type {
  CheckId,
  CheckResult,
  Hex32,
  LedgerEntry,
  LedgerEntryBody,
  MandateView,
  ProposalRequestInputs,
  Snapshot,
  VerifyReport,
} from "./types.js";

export const CHECK_NAMES: Readonly<Record<CheckId, string>> = {
  a: "ledger-signatures",
  b: "hash-links",
  c: "anchors",
  d: "spends-have-decisions",
  e: "attestations",
  f: "vault-locked",
  g: "intents-keys",
  h: "burn-memos",
  i: "factory-version",
};

const CHECK_IDS = Object.keys(CHECK_NAMES) as CheckId[];

function result(
  id: CheckId,
  status: CheckResult["status"],
  detail: string,
  seq?: number,
  lastSeq?: number,
): CheckResult {
  const base = { id, name: CHECK_NAMES[id], status, detail };
  const named = seq === undefined ? base : { ...base, firstBrokenSeq: seq };
  return lastSeq === undefined ? named : { ...named, lastUnprovenSeq: lastSeq };
}
const pass = (id: CheckId, detail: string): CheckResult => result(id, "pass", detail);
const fail = (id: CheckId, detail: string, seq?: number, lastSeq?: number): CheckResult =>
  result(id, "fail", detail, seq, lastSeq);
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A ledger entry as far as the checks need it: an object with an object `body`. Anything else is malformed. */
function isEntry(value: unknown): value is LedgerEntry {
  return isRecord(value) && isRecord(value.body);
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** A U64 nanosecond string (the contract's JSON form), or null when it is anything else. */
function nanoseconds(value: unknown): bigint | null {
  return typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : null;
}

/** sha256 of 32 zero bytes: what NEAR reports for an account without contract code ("1111…1" in base58). */
const ZERO_CODE_HASH = ZERO_HEX32;

/** Code hashes arrive as base58 (NEAR RPC) or hex (some build tools); compare them as lowercase hex. */
export function normalizeCodeHash(hash: string): string | null {
  if (typeof hash !== "string") return null;
  if (/^[0-9a-fA-F]{64}$/.test(hash)) return hash.toLowerCase();
  try {
    const raw = bs58.decode(hash);
    return raw.length === 32 ? bytesToHex(raw) : null;
  } catch {
    return null;
  }
}

function isAnchorOnlyKey(s: Snapshot, publicKey: string): boolean {
  const permission = s.chain.access_keys.find((k) => k?.public_key === publicKey)?.permission;
  return (
    isRecord(permission) &&
    permission.receiver_id === s.vault &&
    Array.isArray(permission.method_names) &&
    permission.method_names.length === 1 &&
    permission.method_names[0] === "anchor"
  );
}

/** Anchors in seq order; check c is the one that insists the seqs are 1, 2, 3, … */
function anchorsInOrder(s: Snapshot): Snapshot["chain"]["anchors"] {
  return [...s.chain.anchors].sort((x, y) => x.seq - y.seq);
}

/**
 * Check a (v2, key rotation). Entries in each anchor range `(prev.count, anchor.count]` must be signed by
 * that anchor's `ledger_key`: the contract only accepts an anchor from the ledger key of the moment, so the
 * anchor is chain-attested evidence of which key signed that range. Entries after the last anchor must be
 * signed by `config.ledger_key`. The current ledger key must be an anchor-only function-call key on the vault.
 *
 * What this proves: for every entry, `signer` is the key the chain names for its range, `body_hash` recomputes
 * from the body, and `sig` is a valid ed25519 signature by that key over it. `signer` is covered by no hash and
 * no signature, so comparing it with the on-chain key is the only thing that catches a self-consistent forgery.
 *
 * It recomputes `body_hash` itself, so it is safe to call alone: `verifyEntrySignature` does not, and every
 * public anchor-transaction signature is a (tx hash, signature, ledger key) triple that passes it. Check b
 * additionally verifies every link, the seq and the chain.
 */
export function checkLedgerSignatures(s: Snapshot): CheckResult {
  const current = s.chain.config.ledger_key;
  if (current !== null && typeof current !== "string") {
    return fail("a", "config.ledger_key is neither a key nor null");
  }
  if (current !== null && !isAnchorOnlyKey(s, current)) {
    return fail("a", `ledger key ${current} is not an anchor-only function-call key on ${s.vault}`);
  }
  if (s.ledger.length === 0) return pass("a", "ledger is empty");
  const ranges: { from: number; to: number; key: string | null; source: string }[] = [];
  let covered = 0;
  for (const anchor of anchorsInOrder(s)) {
    const to = Math.min(anchor.count, s.ledger.length);
    if (to > covered)
      ranges.push({ from: covered, to, key: anchor.ledger_key, source: `anchor ${anchor.seq}` });
    covered = Math.max(covered, to);
  }
  if (covered < s.ledger.length) {
    if (current === null)
      return fail("a", "the vault has no ledger key set for the unanchored entries", covered);
    ranges.push({ from: covered, to: s.ledger.length, key: current, source: "config.ledger_key" });
  }
  const keys = new Set<string>();
  for (const range of ranges) {
    for (let i = range.from; i < range.to; i++) {
      try {
        const entry: unknown = s.ledger[i];
        if (!isEntry(entry)) return fail("a", `entry ${i} is missing or malformed`, i);
        if (entry.signer !== range.key) {
          return fail(
            "a",
            `entry ${i} is signed by ${String(entry.signer)}, but ${range.source} names ledger key ${String(range.key)}`,
            i,
          );
        }
        let recomputed: string;
        try {
          recomputed = computeBodyHash(entry.body);
        } catch (error) {
          return fail("a", `entry ${i} body is not canonical JSON: ${message(error)}`, i);
        }
        if (recomputed !== entry.body_hash) {
          return fail(
            "a",
            `entry ${i} body_hash does not recompute from its body: a signature over a hash the body does not produce proves nothing about the body`,
            i,
          );
        }
        if (!verifyEntrySignature(entry))
          return fail("a", `entry ${i} signature does not verify`, i);
      } catch (error) {
        return fail("a", `entry ${i} cannot be checked: ${message(error)}`, i);
      }
    }
    if (range.key !== null) keys.add(range.key);
  }
  const n = s.ledger.length;
  return pass(
    "a",
    `${n} ${plural(n, "entry", "entries")}: each body_hash recomputes from its body and carries a valid signature by the ledger key the chain names for its range (${keys.size} ledger key(s) named by the anchors and the vault config); check b also verifies every link and the chain`,
  );
}

/** Check b: every body_hash and link recomputes, seq counts up from 0, and prev_link chains from the zero link. */
export function checkHashLinks(s: Snapshot): CheckResult {
  for (let i = 0; i < s.ledger.length; i++) {
    try {
      const entry: unknown = s.ledger[i];
      if (!isEntry(entry)) return fail("b", `entry ${i} is missing or malformed`, i);
      const body = entry.body;
      if (body.v !== 1) {
        return fail(
          "b",
          `entry ${i} has ledger version ${String(body.v)}, which this verifier does not know`,
          i,
        );
      }
      if (body.seq !== i) return fail("b", `entry ${i} has seq ${String(body.seq)}`, i);
      if (body.vault !== s.vault) {
        return fail("b", `entry ${i} belongs to vault ${String(body.vault)}, not ${s.vault}`, i);
      }
      const expectedPrev: unknown =
        i === 0 ? ZERO_LINK : (s.ledger[i - 1] as LedgerEntry | undefined)?.link;
      if (body.prev_link !== expectedPrev) {
        return fail(
          "b",
          i === 0
            ? "entry 0 prev_link is not the zero link"
            : `entry ${i} prev_link does not chain to the link of entry ${i - 1}`,
          i,
        );
      }
      let bodyHash: string;
      try {
        bodyHash = computeBodyHash(body);
      } catch (error) {
        return fail("b", `entry ${i} body is not canonical JSON: ${message(error)}`, i);
      }
      if (bodyHash !== entry.body_hash)
        return fail("b", `entry ${i} body_hash does not recompute from its body`, i);
      let link: string;
      try {
        link = computeLink(body.prev_link, entry.body_hash, entry.sig);
      } catch (error) {
        return fail("b", `entry ${i} link inputs are malformed: ${message(error)}`, i);
      }
      if (link !== entry.link) return fail("b", `entry ${i} link does not recompute`, i);
    } catch (error) {
      return fail("b", `entry ${i} cannot be checked: ${message(error)}`, i);
    }
  }
  return pass(
    "b",
    `${s.ledger.length} entries: every body_hash and link recomputes, chained from the zero link`,
  );
}

/** A range of seqs for a message: "entry 2" or "entries 2 to 3". */
const entryRange = (from: number, to: number): string =>
  from === to ? `entry ${from}` : `entries ${from} to ${to}`;

/**
 * Check c: every anchor's root is the link of the entry it names, anchor seqs run 1, 2, 3, … and counts never go back.
 * A failure names the first seq of the range it cannot prove: an anchor pins a whole range, so it cannot say which
 * entry inside it is wrong (checks a and b name the exact entry). Entries after the last anchored count are
 * not chain-attested; the pass detail says how many there are.
 */
export function checkAnchors(s: Snapshot): CheckResult {
  const anchors = anchorsInOrder(s);
  if (anchors.length === 0) {
    return s.ledger.length === 0
      ? pass("c", "no anchors and an empty ledger")
      : fail(
          "c",
          `the ledger has ${s.ledger.length} entries but no anchor exists on chain: no entry is chain-attested`,
          0,
          s.ledger.length - 1,
        );
  }
  let covered = 0;
  const lastEntry = s.ledger.length - 1;
  for (let j = 0; j < anchors.length; j++) {
    const anchor = anchors[j];
    if (anchor === undefined) continue;
    if (anchor.seq !== j + 1) {
      return fail(
        "c",
        `anchor seq ${anchor.seq} found where ${j + 1} was expected; entry ${covered} and later are not proven`,
        covered,
        Math.max(covered, lastEntry),
      );
    }
    if (!Number.isSafeInteger(anchor.count) || anchor.count < 1 || anchor.count < covered) {
      return fail(
        "c",
        `anchor ${anchor.seq} count ${String(anchor.count)} is not a count that goes forward from ${covered}; entry ${covered} and later are not proven`,
        covered,
        Math.max(covered, lastEntry),
      );
    }
    if (anchor.count > s.ledger.length) {
      return fail(
        "c",
        `anchor ${anchor.seq} covers ${anchor.count} entries but the ledger has ${s.ledger.length}: entry ${s.ledger.length} and later are missing`,
        s.ledger.length,
        anchor.count - 1,
      );
    }
    if ((s.ledger[anchor.count - 1] as LedgerEntry | undefined)?.link !== anchor.root) {
      const range = entryRange(covered, anchor.count - 1);
      return fail(
        "c",
        `anchor ${anchor.seq} root does not match the link of entry ${anchor.count - 1}, the last entry it covers; ${range} ${covered === anchor.count - 1 ? "is" : "are"} not proven`,
        covered,
        anchor.count - 1,
      );
    }
    covered = anchor.count;
  }
  const tail = s.ledger.length - covered;
  return pass(
    "c",
    `${anchors.length} ${plural(anchors.length, "anchor matches", "anchors match")} the ledger; ${tail} ${plural(tail, "entry", "entries")} after the last anchored count (${covered}) ${plural(tail, "is", "are")} not chain-attested`,
  );
}

/**
 * ICR-4b: judges one spend that has no ledger decision and whose hash the snapshot lists as pre-ledger. Returns
 * why it is not exempt, or null when it is (and records the use, so the hash exempts no second spend).
 */
function judgePreLedger(
  s: Snapshot,
  spend: Snapshot["chain"]["spends"][number],
  usedBy: Map<string, number>,
): string | null {
  const used = usedBy.get(spend.decision_hash);
  if (used !== undefined) {
    return `spend ${spend.id}: decision_hash is a pre-ledger hash already used by spend ${used}`;
  }
  const firstAnchor = anchorsInOrder(s)[0];
  if (firstAnchor !== undefined) {
    const created = nanoseconds(spend.created_at_ns);
    const began = nanoseconds(firstAnchor.at_ns);
    if (created === null) {
      return `spend ${spend.id}: created_at_ns ${String(spend.created_at_ns)} is not a nanosecond count`;
    }
    if (began === null) {
      return `anchor ${firstAnchor.seq}: at_ns ${String(firstAnchor.at_ns)} is not a nanosecond count`;
    }
    if (created >= began) {
      return `spend ${spend.id}: decision_hash is a pre-ledger hash, but the spend was created after the ledger began (created_at_ns ${spend.created_at_ns}, first anchor at_ns ${firstAnchor.at_ns})`;
    }
  }
  usedBy.set(spend.decision_hash, spend.id);
  return null;
}

/** The ids of the spends that check d exempts as pre-ledger: the same judgement, so check h can say so. */
function preLedgerExemptSpends(s: Snapshot): Set<number> {
  const decisions = decisionsByHash(s);
  const listed = new Set(s.pre_ledger_decision_hashes ?? []);
  const usedBy = new Map<string, number>();
  const exempt = new Set<number>();
  for (const spend of [...s.chain.spends].sort((x, y) => x.id - y.id)) {
    if (decisions.has(spend.decision_hash) || !listed.has(spend.decision_hash)) continue;
    if (judgePreLedger(s, spend, usedBy) === null) exempt.add(spend.id);
  }
  return exempt;
}

function decisionsByHash(s: Snapshot): Map<string, LedgerEntry> {
  const map = new Map<string, LedgerEntry>();
  for (const entry of s.ledger)
    if (isEntry(entry) && entry.body.kind === "decision") map.set(entry.body_hash, entry);
  return map;
}

/**
 * Check d (ICR-4, ICR-4b): every on-chain spend is bound to exactly one allow decision. Its `decision_hash` must be
 * the `body_hash` of a `decision` entry in the ledger and that entry must:
 *  - have the verdict `allow`, or `hold` only when the spend went through `held`. The snapshot has no status
 *    history, but `held_until_ns` says it: the contract's `reserve` sets it only for a spend it holds and nothing
 *    clears it, so it is non-null for a spend that was held, whether it was then approved and paid out, rejected,
 *    expired or is still held. A hold decision without it means the spend moved with no approver. An `allow`
 *    decision is accepted for a held spend too: the approval threshold (`approval_above`) is the contract's own
 *    and the policy engine has no such rule;
 *  - carry the spend's `invoice_hash`, `mandate_id` and `amount`;
 *  - be referenced by no other spend: a decision authorises exactly one spend. The contract checks only that
 *    `decision_hash` is 64 hex and never de-duplicates it, so without this an agent key could reuse one allow
 *    decision for any number of spends.
 *
 * A spend whose `decision_hash` is not in the ledger is exempt only if the snapshot lists the hash in
 * `pre_ledger_decision_hashes` (Day-4 v0 spends from before the ledger existed), and only ONCE (ICR-4b): the
 * listed hashes are public and the contract does not de-duplicate them, so each exempts at most one spend, the
 * lowest id that references it; and when the snapshot has an anchor, only a spend created before the first
 * anchor's `at_ns` qualifies. Any other spend that references a pre-ledger hash fails. The report says "listed
 * as pre-ledger by the snapshot": the verifier does not read `docs/evidence` and claims nothing about it.
 *
 * Not proved: that `decide()` would give that verdict for those inputs (the verifier does not re-run the policy).
 */
export function checkSpendsHaveDecisions(s: Snapshot): CheckResult {
  const decisions = decisionsByHash(s);
  const preLedger = new Set(s.pre_ledger_decision_hashes ?? []);
  const firstAnchor = anchorsInOrder(s)[0];
  const claimedBy = new Map<string, number>(); // decision body_hash -> the first spend that references it
  const exemptedBy = new Map<string, number>(); // pre-ledger hash -> the one spend it exempts
  for (const spend of [...s.chain.spends].sort((x, y) => x.id - y.id)) {
    const decision = decisions.get(spend.decision_hash);
    if (decision === undefined) {
      if (!preLedger.has(spend.decision_hash)) {
        return fail(
          "d",
          `spend ${spend.id} has decision_hash ${spend.decision_hash}, which is not a decision in the ledger`,
        );
      }
      const why = judgePreLedger(s, spend, exemptedBy);
      if (why !== null) return fail("d", why);
      continue;
    }
    const { seq, verdict } = decision.body;
    if (verdict !== "allow" && verdict !== "hold") {
      return fail(
        "d",
        `spend ${spend.id} points to decision seq ${seq} with verdict ${String(verdict)}`,
        seq,
      );
    }
    if (verdict === "hold" && (spend.held_until_ns === null || spend.held_until_ns === undefined)) {
      return fail(
        "d",
        `spend ${spend.id} points to the hold decision seq ${seq} but never went through held (held_until_ns is null): no approver was involved`,
        seq,
      );
    }
    const differs: string[] = [];
    for (const field of ["invoice_hash", "mandate_id", "amount"] as const) {
      if (spend[field] !== decision.body[field]) {
        differs.push(`${field} ${String(spend[field])} vs ${String(decision.body[field])}`);
      }
    }
    if (differs.length > 0) {
      return fail(
        "d",
        `spend ${spend.id} does not match its decision seq ${seq} (spend vs decision): ${differs.join("; ")}`,
        seq,
      );
    }
    const first = claimedBy.get(decision.body_hash);
    if (first !== undefined) {
      return fail(
        "d",
        `spends ${first} and ${spend.id} both reference decision seq ${seq}: a decision authorises exactly one spend`,
        seq,
      );
    }
    claimedBy.set(decision.body_hash, spend.id);
  }
  const bound = claimedBy.size;
  const exempt = exemptedBy.size;
  const parts: string[] = [];
  if (bound > 0) {
    parts.push(
      `${bound} on-chain ${plural(bound, "spend, bound to its own allow or hold decision", "spends, each bound to its own allow or hold decision")} (same invoice, mandate and amount)`,
    );
  } else {
    parts.push(exempt === 0 ? "no on-chain spends" : "no spend is bound to a ledger decision");
  }
  if (exempt > 0) {
    const when = firstAnchor === undefined ? "" : ", created before the first anchor";
    parts.push(
      `${exempt} ${plural(exempt, "spend has a decision_hash", "spends have a decision_hash")} listed as pre-ledger by the snapshot (exempt: at most one spend per listed hash${when})`,
    );
  }
  const notes = paymentNotes(s, decisions, claimedBy);
  if (notes.length > 0) parts.push(`notes (not failures): ${notes.join("; ")}`);
  return pass("d", parts.join("; "));
}

/**
 * The notes check d adds for Task 13's ledger shapes (carries C). They never fail d: the chain spend, not the
 * payment entry, is what d binds.
 * - A payment entry with `contract.status: "unknown"` (ICR-6) is resolved from chain state: the spend that
 *   carries its decision hash says what happened. With no such spend it is pending.
 * - A spend bound to its decision with no payment entry for that decision: the cycle could not write it
 *   (`ledgerComplete: false`). d still binds the spend to its decision.
 */
function paymentNotes(
  s: Snapshot,
  decisions: Map<string, LedgerEntry>,
  claimedBy: Map<string, number>,
): string[] {
  const notes: string[] = [];
  const spendByDecision = new Map<string, Snapshot["chain"]["spends"][number]>();
  for (const spend of [...s.chain.spends].sort((x, y) => x.id - y.id)) {
    if (!spendByDecision.has(spend.decision_hash)) spendByDecision.set(spend.decision_hash, spend);
  }
  const withPayment = new Set<string>();
  for (let i = 0; i < s.ledger.length; i++) {
    const entry: unknown = s.ledger[i];
    if (!isEntry(entry) || entry.body.kind !== "payment") continue;
    const decision = isRecord(entry.body.refs) ? entry.body.refs.decision_body_hash : undefined;
    if (typeof decision === "string") withPayment.add(decision);
    if (!isRecord(entry.body.contract) || entry.body.contract.status !== "unknown") continue;
    const spend = typeof decision === "string" ? spendByDecision.get(decision) : undefined;
    notes.push(
      spend === undefined
        ? `payment seq ${i} recorded an unknown outcome and no spend on chain carries its decision: pending (it can be neither paid nor failed until its transaction lands or expires)`
        : `payment seq ${i} recorded an unknown outcome; spend ${spend.id} on chain carries its decision (status ${String(spend.status)}): resolved from chain state`,
    );
  }
  for (const [decisionHash, spendId] of claimedBy) {
    if (withPayment.has(decisionHash)) continue;
    const seq = decisions.get(decisionHash)?.body.seq;
    notes.push(
      `spend ${spendId} is bound to decision seq ${String(seq)}, which has no payment entry (the cycle could not write it: ledgerComplete false)`,
    );
  }
  return notes;
}

type AttestationOutcome =
  | { kind: "fail"; detail: string }
  | { kind: "attested" }
  | { kind: "reported"; note: string }
  | { kind: "none" };

async function attestationOutcome(
  s: Snapshot,
  entry: LedgerEntry,
  i: number,
): Promise<AttestationOutcome> {
  const b = entry.body;
  const evidence = b.evidence;
  const hasEvidence = evidence !== null && evidence !== undefined;
  if (b.kind === "decision" && b.decided_by !== "model+rules" && b.decided_by !== "rules-only") {
    return {
      kind: "fail",
      detail: `entry ${i} is a decision whose decided_by is ${String(b.decided_by)}`,
    };
  }
  if (!hasEvidence) {
    if (b.decided_by === "model+rules") {
      return {
        kind: "fail",
        detail: `entry ${i} is decided by model+rules but carries no evidence`,
      };
    }
    return b.kind === "decision" ? { kind: "reported", note: String(i) } : { kind: "none" };
  }
  // The nonce binds the evidence to ONE position in ONE vault's ledger (ICR-1). Recompute it from the entry,
  // with the vault the ENTRY names, and require that this is the snapshot's vault and the entry's real
  // position, so evidence copied from another vault or another place in the chain cannot match.
  if (b.vault !== s.vault) {
    return {
      kind: "fail",
      detail: `entry ${i} names vault ${String(b.vault)}, not ${s.vault}: its attestation nonce would bind the wrong vault`,
    };
  }
  const previous = i === 0 ? ZERO_LINK : (s.ledger[i - 1] as LedgerEntry | undefined)?.link;
  if (b.seq !== i || b.prev_link !== previous) {
    return {
      kind: "fail",
      detail: `entry ${i} is not at the chain position its attestation nonce is computed from`,
    };
  }
  const expected = computeNonce({
    vault: b.vault,
    prev_link: b.prev_link,
    invoice_hash: b.invoice_hash,
    mandate_id: b.mandate_id,
    seq: b.seq,
  });
  const r = await checkAttestation(evidence, expected, b.proposal ?? null);
  const failed = r.checks.filter((c) => !c.pass);
  const failedIds = failed.map((c) => c.id).join(",");
  if (b.decided_by === "rules-only") {
    return { kind: "reported", note: r.ok ? String(i) : `${i} (unattested: ${failedIds})` };
  }
  if (!r.ok) {
    return {
      kind: "fail",
      detail: `entry ${i} fails ${failedIds}: ${failed.map((c) => c.detail).join("; ")}`,
    };
  }
  return { kind: "attested" };
}

/**
 * Invoice texts for A8, by `invoice_hash` (the sha256 of the text, ICR-3b): a map, or a loader (sync or async)
 * that returns the text or null/undefined when it has none. The texts never enter the ledger or the snapshot.
 */
export type InvoiceTextSource =
  | ReadonlyMap<string, string>
  | ((invoiceHash: Hex32) => string | null | undefined | Promise<string | null | undefined>);

/**
 * The mandate fields that never change on chain once `create_mandate` stored them. `remaining` and `status`
 * do change (spends, revocation), so A8's mandate match compares only these (Task 14 B2).
 */
export const IMMUTABLE_MANDATE_FIELDS = [
  "id",
  "label",
  "payee",
  "purpose_hash",
  "max_per_payment",
  "expires_at_ns",
] as const;

/** At most `max` characters of `JSON.stringify(value)`, for a detail. */
function shown(value: unknown, max = 80): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * A8's mandate match (Task 14 B2), folded into A8's verdict by check e: the mandates the model was shown
 * (`request_inputs.mandates`) are the vault's own. Every listed mandate must exist in `mandates` (the snapshot's
 * chain mandates), appear once, and have the chain's immutable fields (`IMMUTABLE_MANDATE_FIELDS`); the entry's
 * `mandate_id` must be among them; and `facts.amount` must be the entry's `amount` when the entry has one (a
 * refusal with an unreadable amount has none, and no spend). `remaining` and `status` change on chain, so a
 * difference there is a note: the values at decision time need archival state. `problem` is null when it
 * matches. It never throws.
 */
export function matchRequestMandates(
  inputs: ProposalRequestInputs,
  entry: Pick<LedgerEntryBody, "mandate_id" | "amount">,
  mandates: readonly MandateView[] | undefined,
  seq?: number,
): { problem: string | null; notes: string[] } {
  const notes: string[] = [];
  const problem = (text: string) => ({ problem: text, notes });
  if (!Array.isArray(mandates)) {
    return problem(
      "the snapshot holds no chain mandates (chain.mandates) to match request_inputs.mandates against",
    );
  }
  const chain = new Map<number, MandateView>();
  for (const m of mandates) {
    if (isRecord(m) && typeof m.id === "number") chain.set(m.id, m as unknown as MandateView);
  }
  const listed = Array.isArray(inputs?.mandates) ? inputs.mandates : [];
  const seen = new Set<number>();
  const where = seq === undefined ? "" : ` (seq ${seq})`;
  for (const [i, m] of listed.entries()) {
    if (!isRecord(m)) return problem(`request_inputs.mandates[${i}] is not a mandate`);
    if (seen.has(m.id)) return problem(`request_inputs.mandates lists mandate ${m.id} twice`);
    seen.add(m.id);
    const onChain = chain.get(m.id);
    if (onChain === undefined) {
      return problem(
        `request_inputs.mandates[${i}] is mandate ${m.id}, which the vault does not have`,
      );
    }
    for (const field of IMMUTABLE_MANDATE_FIELDS) {
      if (canonicalJson(m[field]) !== canonicalJson(onChain[field])) {
        return problem(
          `request_inputs.mandates[${i}] (mandate ${m.id}) differs from the chain in ${field}: the model was shown ${shown(m[field])}, the chain holds ${shown(onChain[field])}`,
        );
      }
    }
    let remaining: string | null = null;
    try {
      remaining = (
        BigInt(onChain.max_total) -
        BigInt(onChain.spent) -
        BigInt(onChain.reserved)
      ).toString();
    } catch {
      remaining = null;
    }
    if (m.remaining !== remaining || m.status !== onChain.status) {
      notes.push(
        `mandate ${m.id}${where}: the model was shown remaining ${m.remaining} and status ${m.status}; the chain now holds ${String(remaining)} and ${String(onChain.status)} (the values at decision time need archival state)`,
      );
    }
  }
  if (entry.mandate_id === null || !seen.has(entry.mandate_id)) {
    return problem(
      `the entry's mandate_id ${String(entry.mandate_id)} is not among the mandates the model was shown`,
    );
  }
  if (!isRecord(inputs.facts)) return problem("request_inputs.facts is null");
  if (entry.amount !== null && inputs.facts.amount !== entry.amount) {
    return problem(
      `the model was shown amount ${String(inputs.facts.amount)}, but the entry records ${entry.amount}`,
    );
  }
  return { problem: null, notes };
}

type RequestBindingOutcome =
  | { kind: "fail"; detail: string }
  | { kind: "checked"; notes: string[] }
  | { kind: "not_run"; note: string };

/** A8 plus the mandate match for one attested decision, when its invoice text is supplied. */
async function requestBindingOutcome(
  s: Snapshot,
  entry: LedgerEntry,
  i: number,
  texts: InvoiceTextSource,
  prompts: readonly KnownSystemPrompt[],
): Promise<RequestBindingOutcome> {
  const b = entry.body;
  const hash = b.invoice_hash;
  let text: string | null | undefined;
  try {
    text =
      typeof texts === "function"
        ? await texts(String(hash))
        : (texts as ReadonlyMap<string, string>).get(String(hash));
  } catch (error) {
    return {
      kind: "not_run",
      note: `seq ${i} (the invoice text loader failed: ${message(error)})`,
    };
  }
  if (typeof text !== "string") {
    return {
      kind: "not_run",
      note: `seq ${i} (no invoice text supplied for invoice_hash ${String(hash)})`,
    };
  }
  const evidence = b.evidence;
  if (evidence === null || evidence === undefined) {
    return { kind: "fail", detail: `entry ${i} has no evidence for A8` };
  }
  const a8 = checkRequestBinding(
    evidence,
    text,
    {
      vault: b.vault,
      prev_link: b.prev_link,
      invoice_hash: b.invoice_hash,
      mandate_id: b.mandate_id,
      seq: b.seq,
    },
    { systemPrompts: prompts },
  );
  if (!a8.pass) return { kind: "fail", detail: `entry ${i} fails A8: ${a8.detail}` };
  const match = matchRequestMandates(
    evidence.request_inputs as ProposalRequestInputs,
    b,
    s.chain.mandates,
    i,
  );
  if (match.problem !== null) {
    return {
      kind: "fail",
      detail: `entry ${i} fails A8 (the mandates the model was shown are not the vault's): ${match.problem}`,
    };
  }
  return { kind: "checked", notes: match.notes };
}

/** The A8 allow-list: `KNOWN_SYSTEM_PROMPT_HASHES` extended (never replaced) by the caller's prompts. */
function promptAllowList(extra: readonly KnownSystemPrompt[] | undefined): KnownSystemPrompt[] {
  return [...KNOWN_SYSTEM_PROMPT_HASHES, ...(Array.isArray(extra) ? extra : [])];
}

/**
 * Check e: every entry with evidence passes A1–A7 (the offline attestation checks) with its own `proposal`
 * as the expected proposal. Decisions with `decided_by = "rules-only"` are reported, not failed.
 *
 * With `opts.invoiceTexts` (ICR-9), every attested decision whose text is supplied must also pass A8 (the
 * request rebuilt from `request_inputs`, the text and the ledger nonce, under the allow-list
 * `KNOWN_SYSTEM_PROMPT_HASHES` plus `opts.systemPrompts`) AND the mandate match (`matchRequestMandates`); the
 * two are one verdict, never "A8 pass" alone. A decision without its text is "A8 not run" for that seq, which
 * is neither a pass nor a fail.
 *
 * The detail says what this did NOT establish: the TDX quote is not verified offline (that is O1, run with
 * --online), and without the texts A8 is not run. A1–A7 prove the signature, the response body, the recorded
 * proposal and the attestation report agree with each other and with the ledger position. They do not prove
 * the request was the honest one for this invoice (A8 does, for the texts supplied), and not that the quote
 * came from genuine TEE hardware. Neither does A8 prove that the invoice is authentic: an invented invoice
 * whose hash is written into both the entry and the spend passes.
 */
export async function checkAttestations(
  s: Snapshot,
  opts: Pick<RunChecksOptions, "invoiceTexts" | "systemPrompts"> = {},
): Promise<CheckResult> {
  let attested = 0;
  const reported: string[] = [];
  const texts = opts.invoiceTexts;
  const prompts = promptAllowList(opts.systemPrompts);
  const checked: number[] = [];
  const notRun: string[] = [];
  const notes: string[] = [];
  for (let i = 0; i < s.ledger.length; i++) {
    const entry: unknown = s.ledger[i];
    if (!isEntry(entry)) return fail("e", `entry ${i} is missing or malformed`, i);
    let outcome: AttestationOutcome;
    try {
      outcome = await attestationOutcome(s, entry, i);
    } catch (error) {
      return fail("e", `entry ${i} cannot be checked: ${message(error)}`, i);
    }
    if (outcome.kind === "fail") return fail("e", outcome.detail, i);
    if (outcome.kind === "reported") reported.push(outcome.note);
    if (outcome.kind !== "attested") continue;
    attested++;
    if (texts === undefined) continue;
    let binding: RequestBindingOutcome;
    try {
      binding = await requestBindingOutcome(s, entry, i, texts, prompts);
    } catch (error) {
      return fail(
        "e",
        `entry ${i} cannot be checked against its invoice text: ${message(error)}`,
        i,
      );
    }
    if (binding.kind === "fail") return fail("e", binding.detail, i);
    if (binding.kind === "not_run") notRun.push(binding.note);
    else {
      checked.push(i);
      notes.push(...binding.notes);
    }
  }
  const tail =
    reported.length > 0
      ? `; rules-only or unattested (reported, not failed): seq ${reported.join(", ")}`
      : "";
  let a8: string;
  if (texts === undefined) {
    a8 = "A8 not run (the request is not checked against the invoice)";
  } else {
    const which = checked.length > 0 ? ` (seq ${checked.join(", ")})` : "";
    a8 = `A8 (request binding and mandate match) passes for ${checked.length} of ${attested} attested decisions${which}`;
    if (notRun.length > 0) a8 += `; A8 not run for ${notRun.join(", ")}`;
    if (notes.length > 0) a8 += `; notes (not failures): ${notes.join("; ")}`;
  }
  return pass(
    "e",
    `${attested} attested decisions pass A1–A7; quote not verified offline (run --online for O1); ${a8}${tail}`,
  );
}

const AGENT_KEY_SHAPE = 'receiver the vault, methods exactly ["spend"]';
const LEDGER_KEY_SHAPE = 'receiver the vault, methods exactly ["anchor"]';

/**
 * The first access key that is neither of the two shapes the contract grants (contracts/vault keys.rs), or null.
 * `add_agent` grants (vault, ["spend"]); `set_ledger_key` grants (vault, ["anchor"]) to the one current ledger key
 * and deletes the previous one. FullAccess keys are reported separately.
 */
function offendingKey(s: Snapshot): string | null {
  const ledgerKey = s.chain.config.ledger_key;
  for (const key of s.chain.access_keys) {
    const permission = key.permission;
    if (permission === "FullAccess") continue;
    const only = (method: string): boolean =>
      isRecord(permission) &&
      permission.receiver_id === s.vault &&
      Array.isArray(permission.method_names) &&
      permission.method_names.length === 1 &&
      permission.method_names[0] === method;
    if (only("spend")) continue;
    if (only("anchor") && key.public_key === ledgerKey) continue;
    const why = only("anchor")
      ? "an anchor key that is not the current ledger key"
      : `neither the current ledger key (${LEDGER_KEY_SHAPE}) nor an agent key (${AGENT_KEY_SHAPE})`;
    return `access key ${String(key.public_key)} has permission ${JSON.stringify(permission)}, which is ${why}`;
  }
  return null;
}

/**
 * The code hashes this verifier trusts for a vault, each with where the trust comes from (ICR-5): the recorded
 * reproducible vault builds (`KNOWN_VAULT_CODE_HASHES`), plus every version the factory lists, but only when the
 * vault's `config.factory` is the network's canonical factory. A vault records whoever deployed it as its
 * factory, so any other account's `versions()` proves nothing. The all-zero hash is never trusted.
 */
function trustedCodeHashes(s: Snapshot): Map<string, string> {
  const trusted = new Map<string, string>();
  const add = (hash: unknown, source: string): void => {
    const normal = typeof hash === "string" ? normalizeCodeHash(hash) : null;
    if (normal !== null && normal !== ZERO_CODE_HASH && !trusted.has(normal)) {
      trusted.set(normal, source);
    }
  };
  for (const hash of KNOWN_VAULT_CODE_HASHES) {
    add(hash, "a recorded reproducible build (KNOWN_VAULT_CODE_HASHES)");
  }
  const canonical = NETWORKS[s.network].factory;
  if (s.chain.config.factory === canonical) {
    for (const version of s.chain.factory_versions) {
      add(
        version?.code_hash,
        `version ${String(version?.index)} of the canonical factory ${canonical}`,
      );
    }
  }
  return trusted;
}

/**
 * Check f (ICR-5): no FullAccess key; every other access key is the current ledger key or an agent key, both on the
 * vault itself (the detail names an offending key and its permission); and the vault's code hash is trusted.
 *
 * The verifier derives its own trusted set (`trustedCodeHashes`): `KNOWN_VAULT_CODE_HASHES`, generated from
 * contracts/code-hashes.json (vault builds only), plus the versions of the canonical factory. The snapshot's
 * `expected_code_hashes` adds nothing: it is free text a snapshot builder, or a forger, can put anything into, so
 * the check FAILS if it lists any hash outside the trusted set. A factory build, and the all-zero hash of an account
 * with no contract code, are never trusted.
 *
 * No special case for a global-mode vault: its account has no code of its own, and the SDK puts the global
 * contract's hash (`global_contract_hash`) into `Snapshot.chain.code_hash` (R6, Task 14), so by the time it
 * reaches this check it is an ordinary hash.
 */
export function checkVaultLocked(s: Snapshot): CheckResult {
  const fullAccess = s.chain.access_keys
    .filter((k) => k.permission === "FullAccess")
    .map((k) => k.public_key);
  if (fullAccess.length > 0)
    return fail("f", `the vault has FullAccess key(s): ${fullAccess.join(", ")}`);
  const offending = offendingKey(s);
  if (offending !== null) return fail("f", offending);
  const actual = normalizeCodeHash(s.chain.code_hash);
  if (actual === null)
    return fail("f", `code_hash ${String(s.chain.code_hash)} is not a sha256 hash`);
  if (actual === ZERO_CODE_HASH) {
    return fail(
      "f",
      "the account has no contract code (the all-zero code hash); a global-mode vault must report its global contract hash",
    );
  }
  const trusted = trustedCodeHashes(s);
  for (const listed of s.expected_code_hashes) {
    const normal = typeof listed === "string" ? normalizeCodeHash(listed) : null;
    if (normal === null || !trusted.has(normal)) {
      return fail(
        "f",
        `the snapshot lists an untrusted code hash ${JSON.stringify(listed)}: expected_code_hashes is not trusted, and this hash is neither a recorded reproducible build nor a version of the canonical factory`,
      );
    }
  }
  const source = trusted.get(actual);
  if (source === undefined) {
    const canonical = NETWORKS[s.network].factory;
    const other =
      s.chain.config.factory === canonical
        ? ""
        : ` (this vault names ${String(s.chain.config.factory)} as its factory, whose versions are not trusted)`;
    return fail(
      "f",
      `code_hash ${s.chain.code_hash} is not a recorded reproducible build (KNOWN_VAULT_CODE_HASHES) nor a version of the canonical factory ${canonical}${other}`,
    );
  }
  // A vault the canonical factory created at version N runs version N's code, not another trusted build.
  // (An unusable version number is check i's business; plain vaults have none and rest on KNOWN alone.)
  let versionNote = "";
  const version = s.chain.factory_version;
  if (
    s.chain.config.factory === NETWORKS[s.network].factory &&
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version >= 1
  ) {
    const record = s.chain.factory_versions.find((v) => v?.index === version);
    if (record !== undefined) {
      if (normalizeCodeHash(record.code_hash) !== actual) {
        return fail(
          "f",
          `code hash does not match factory version ${version}: the vault runs ${s.chain.code_hash}, but ${NETWORKS[s.network].factory} lists ${String(record.code_hash)} for that version`,
        );
      }
      versionNote = `; it is the code of factory version ${version}`;
    }
  }
  return pass(
    "f",
    `no FullAccess key; every access key is the ledger key or a spend-only agent key on the vault; code_hash ${s.chain.code_hash} is ${source}${versionNote}`,
  );
}

/** Check g: no key of the vault is registered in intents, and predecessor auth is on. */
export function checkIntentsKeys(s: Snapshot): CheckResult {
  if (s.chain.intents_public_keys.length > 0) {
    return fail(
      "g",
      `intents has public key(s) registered for the vault: ${s.chain.intents_public_keys.join(", ")}`,
    );
  }
  if (s.chain.intents_predecessor_auth !== true)
    return fail("g", "predecessor auth is disabled for the vault in intents");
  return pass("g", "no intents public keys; predecessor auth enabled");
}

/**
 * Check h: every Burned spend has exactly one matched burn pair (Snapshot.burns is the pair summary, so this
 * check does not depend on the receipt shape): the POA token's ft_burn memo is `WITHDRAW_TO:` + the mandate's
 * destination address, and intents' mt_burn has the vault as owner and the spend's amount. One transaction
 * burns for one spend, so two spends that cite the same burn tx fail.
 *
 * R7 (Task 14): a burned spend that check d exempted as pre-ledger (documented) and whose burn tx nobody
 * supplied is a note, not a failure: "documented, burn tx not supplied", and the pass detail says its burn is
 * not proven. A burn record that names a tx in which no pair was found fails, documented or not.
 */
export function checkBurnMemos(s: Snapshot): CheckResult {
  const decisions = decisionsByHash(s);
  const preLedgerExempt = preLedgerExemptSpends(s);
  const burned = s.chain.spends.filter((sp) => sp.status === "burned").sort((x, y) => x.id - y.id);
  const notes: string[] = [];
  const spendOfTx = new Map<string, number>();
  for (const spend of burned) {
    const seq = decisions.get(spend.decision_hash)?.body.seq;
    if (spend.destination.type !== "intents")
      return fail("h", `spend ${spend.id} is burned but pays a NEAR account`, seq);
    const expected = `${WITHDRAW_MEMO_PREFIX}${spend.destination.address}`;
    const matches = s.chain.burns.filter((x) => x.spend_id === spend.id);
    if (matches.length > 1)
      return fail(
        "h",
        `spend ${spend.id}: ${matches.length} burn records name it, expected one`,
        seq,
      );
    const burn = matches[0];
    if (burn === undefined || burn.status !== "ok") {
      const tx =
        burn !== undefined && typeof burn.tx_hash === "string" && burn.tx_hash.length > 0
          ? burn.tx_hash
          : null;
      if (tx !== null) {
        return fail(
          "h",
          `spend ${spend.id}: no burn event observed in tx ${tx} (no POA ft_burn with the WITHDRAW_TO: memo paired with the intents mt_burn)`,
          seq,
        );
      }
      if (preLedgerExempt.has(spend.id)) {
        const supply =
          s.network === "mainnet" ? " (record it in docs/mainnet-proof.json with --spend-id)" : "";
        notes.push(`spend ${spend.id}: documented (pre-ledger), burn tx not supplied${supply}`);
        continue;
      }
      return fail("h", `spend ${spend.id}: no burn event observed`, seq);
    }
    if (typeof burn.tx_hash !== "string" || burn.tx_hash.length === 0) {
      return fail("h", `spend ${spend.id}: the burn record names no tx`, seq);
    }
    const other = spendOfTx.get(burn.tx_hash);
    if (other !== undefined) {
      return fail(
        "h",
        `spends ${other} and ${spend.id} cite the same burn tx ${burn.tx_hash}: one transaction burns for one spend`,
        seq,
      );
    }
    spendOfTx.set(burn.tx_hash, spend.id);
    if (burn.memo !== expected) {
      return fail(
        "h",
        `spend ${spend.id}: burn memo ${JSON.stringify(burn.memo)} is not ${JSON.stringify(expected)}`,
        seq,
      );
    }
    if (burn.intents_owner !== s.vault) {
      return fail(
        "h",
        `spend ${spend.id}: the intents mt_burn owner is ${burn.intents_owner}, not the vault ${s.vault}`,
        seq,
      );
    }
    if (burn.amount !== spend.amount) {
      return fail(
        "h",
        `spend ${spend.id}: the intents mt_burn amount ${burn.amount} is not the spend amount ${spend.amount}`,
        seq,
      );
    }
    if (spend.memo !== null && spend.memo !== expected) {
      return fail(
        "h",
        `spend ${spend.id}: spend memo ${JSON.stringify(spend.memo)} is not ${JSON.stringify(expected)}`,
        seq,
      );
    }
  }
  const n = burned.length;
  const proven = n - notes.length;
  let detail: string;
  if (n === 0) detail = "0 burned spends: no burn to pair";
  else if (proven === 0)
    detail = `0 of ${n} burned ${plural(n, "spend has", "spends have")} a proven burn pair`;
  else
    detail = `${proven} burned ${plural(proven, "spend has", "spends have")} a matched burn pair: the POA ft_burn memo is WITHDRAW_TO:<destination address> and the vault's intents mt_burn is for the spend amount`;
  if (notes.length > 0) {
    detail += `; not proven (notes, not failures): ${notes.join("; ")}: the burn of a documented pre-ledger spend is not proven until its tx is supplied`;
  }
  return pass("h", detail);
}

/**
 * Check i: a factory vault names the Probarion factory of its network and has a version record that the
 * factory lists. Factory version ids are 1-based (R14): 0 is no version, whatever the list holds. A vault
 * records the account that deployed it as its `factory` (contracts/vault `new`), so anyone could name their own
 * contract there; only the network's canonical factory counts. A vault without a factory is skipped.
 */
export function checkFactoryVersion(s: Snapshot): CheckResult {
  const factory = s.chain.config.factory;
  if (factory === null) return result("i", "skip", "not a factory vault");
  const canonical = NETWORKS[s.network].factory;
  if (factory !== canonical) {
    return fail(
      "i",
      `the vault names factory ${String(factory)}, which is not the Probarion factory ${canonical} on ${s.network}`,
    );
  }
  const version = s.chain.factory_version;
  if (version === null) return fail("i", `factory ${factory} has no version record for ${s.vault}`);
  if (!Number.isSafeInteger(version) || version < 1) {
    return fail("i", `factory version ids are 1-based; ${String(version)} is not a version id`);
  }
  if (!s.chain.factory_versions.some((v) => v.index === version)) {
    return fail("i", `version ${version} is not in ${factory} versions()`);
  }
  return pass("i", `created by ${factory} at version ${version}`);
}

async function safe(
  id: CheckId,
  run: () => CheckResult | Promise<CheckResult>,
): Promise<CheckResult> {
  try {
    return await run();
  } catch (error) {
    return fail(id, `check crashed on a malformed snapshot: ${message(error)}`);
  }
}

/** The container-level shape every check relies on, or the first thing wrong with it. Entries are checked one by one. */
function shapeProblem(s: unknown): string | null {
  if (!isRecord(s)) return "the snapshot is not an object";
  if (s.v !== 1) return `snapshot version ${String(s.v)} is not supported`;
  if (typeof s.vault !== "string" || s.vault.length === 0) return "vault is not an account id";
  if (s.network !== "mainnet" && s.network !== "testnet")
    return "network is neither mainnet nor testnet";
  if (!Array.isArray(s.ledger)) return "ledger is not an array";
  if (!Array.isArray(s.expected_code_hashes)) return "expected_code_hashes is not an array";
  if (s.pre_ledger_decision_hashes !== undefined && !Array.isArray(s.pre_ledger_decision_hashes)) {
    return "pre_ledger_decision_hashes is not an array";
  }
  const chain = s.chain;
  if (!isRecord(chain)) return "chain is missing";
  for (const key of [
    "access_keys",
    "anchors",
    "spends",
    "intents_public_keys",
    "factory_versions",
    "burns",
  ]) {
    if (!Array.isArray(chain[key])) return `chain.${key} is not an array`;
  }
  if (chain.mandates !== undefined && !Array.isArray(chain.mandates)) {
    return "chain.mandates is not an array";
  }
  if (!isRecord(chain.config)) return "chain.config is missing";
  if (typeof chain.code_hash !== "string") return "chain.code_hash is not a string";
  return null;
}

/**
 * Options of `runChecks` (ICR-9). `invoiceTexts` runs A8 with the mandate match for every attested decision
 * whose invoice text it holds (check e); without it A8 is "not run". `systemPrompts` extends A8's allow-list
 * (`KNOWN_SYSTEM_PROMPT_HASHES` is always in it, never replaced).
 */
export interface RunChecksOptions {
  now?: Date;
  invoiceTexts?: InvoiceTextSource;
  systemPrompts?: readonly KnownSystemPrompt[];
}

/** Pure, offline. Async only because EIP-191 recovery in viem is async. Never throws: a broken snapshot fails. */
export async function runChecks(s: Snapshot, opts: RunChecksOptions = {}): Promise<VerifyReport> {
  const generatedAt = (opts.now ?? new Date()).toISOString();
  const problem = shapeProblem(s);
  if (problem !== null) {
    const record: Record<string, unknown> = isRecord(s) ? s : {};
    return {
      vault: typeof record.vault === "string" ? record.vault : "",
      // Passed through as received: a malformed snapshot is reported, not repaired.
      network: record.network as VerifyReport["network"],
      ok: false,
      checks: CHECK_IDS.map((id) => fail(id, `the snapshot is malformed: ${problem}`)),
      entries: Array.isArray(record.ledger) ? record.ledger.length : 0,
      anchors: 0,
      generated_at: generatedAt,
    };
  }
  const checks: CheckResult[] = [
    await safe("a", () => checkLedgerSignatures(s)),
    await safe("b", () => checkHashLinks(s)),
    await safe("c", () => checkAnchors(s)),
    await safe("d", () => checkSpendsHaveDecisions(s)),
    await safe("e", () => checkAttestations(s, opts)),
    await safe("f", () => checkVaultLocked(s)),
    await safe("g", () => checkIntentsKeys(s)),
    await safe("h", () => checkBurnMemos(s)),
    await safe("i", () => checkFactoryVersion(s)),
  ];
  return {
    vault: s.vault,
    network: s.network,
    ok: checks.every((c) => c.status !== "fail"),
    checks,
    entries: s.ledger.length,
    anchors: s.chain.anchors.length,
    generated_at: generatedAt,
  };
}

/**
 * The lowest seq any failing check points to, or null when no failing check names a seq. Nothing refines it.
 *
 * What each check points to: a and b the exact entry that fails (its signer, signature, hash, link or position);
 * c the first entry of the anchor range it cannot prove (an anchor pins a whole range and cannot say which entry
 * inside it is wrong; `lastUnprovenSeq` says where the range ends and is information only); d the decision at
 * the end of a spend that fails to bind; e the entry whose attestation fails; h the decision whose burn fails.
 * For d and h that seq is the decision whose chain outcome failed, not necessarily unproven ledger history.
 * One check's seq never replaces another's: a and b only show that an entry is self-consistent, not that it is
 * the history the anchor pinned, so an exact a or b seq inside c's range does not clear the entries of the
 * range before it.
 */
export function firstBrokenSeq(report: VerifyReport): number | null {
  let first: number | null = null;
  for (const c of report.checks) {
    if (
      c.status === "fail" &&
      typeof c.firstBrokenSeq === "number" &&
      (first === null || c.firstBrokenSeq < first)
    ) {
      first = c.firstBrokenSeq;
    }
  }
  return first;
}
