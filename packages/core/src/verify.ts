import bs58 from "bs58";
import { checkAttestation } from "./attestation.js";
import { KNOWN_VAULT_CODE_HASHES } from "./code-hashes.js";
import { NETWORKS, WITHDRAW_MEMO_PREFIX } from "./constants.js";
import { bytesToHex, ZERO_HEX32 } from "./hex.js";
import {
  computeBodyHash,
  computeLink,
  computeNonce,
  verifyEntrySignature,
  ZERO_LINK,
} from "./ledger.js";
import type { CheckId, CheckResult, LedgerEntry, Snapshot, VerifyReport } from "./types.js";

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
): CheckResult {
  const base = { id, name: CHECK_NAMES[id], status, detail };
  return seq === undefined ? base : { ...base, firstBrokenSeq: seq };
}
const pass = (id: CheckId, detail: string): CheckResult => result(id, "pass", detail);
const fail = (id: CheckId, detail: string, seq?: number): CheckResult =>
  result(id, "fail", detail, seq);
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A ledger entry as far as the checks need it: an object with an object `body`. Anything else is malformed. */
function isEntry(value: unknown): value is LedgerEntry {
  return isRecord(value) && isRecord(value.body);
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
 * What this proves: for every entry, `signer` is the key the chain names for its range, and `sig` is a valid
 * ed25519 signature by it over the entry's STORED `body_hash`. `signer` is covered by no hash and no
 * signature, so comparing it with the on-chain key is the only thing that catches a self-consistent forgery.
 *
 * What this does NOT prove: that the body hashes to `body_hash`. `verifyEntrySignature` does not recompute it,
 * and every public anchor-transaction signature is a (tx hash, signature, ledger key) triple that passes it
 * on its own. Check b recomputes every `body_hash` and every `link`; this check is meaningful only together
 * with b, which `runChecks` always runs, and a report is `ok` only if both pass.
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
        if (!verifyEntrySignature(entry))
          return fail("a", `entry ${i} signature does not verify`, i);
      } catch (error) {
        return fail("a", `entry ${i} cannot be checked: ${message(error)}`, i);
      }
    }
    if (range.key !== null) keys.add(range.key);
  }
  return pass(
    "a",
    `${s.ledger.length} signatures verify over the stored body_hash values with ${keys.size} ledger key(s) named by the anchors and the vault config; check b recomputes every body_hash`,
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

/** Check c: every anchor's root is the link of the entry it names, anchor seqs run 1, 2, 3, … and counts never go back. */
export function checkAnchors(s: Snapshot): CheckResult {
  const anchors = anchorsInOrder(s);
  if (anchors.length === 0) {
    return s.ledger.length === 0
      ? pass("c", "no anchors and an empty ledger")
      : fail("c", `the ledger has ${s.ledger.length} entries but no anchor exists on chain`, 0);
  }
  let covered = 0;
  for (let j = 0; j < anchors.length; j++) {
    const anchor = anchors[j];
    if (anchor === undefined) continue;
    if (anchor.seq !== j + 1)
      return fail("c", `anchor seq ${anchor.seq} found where ${j + 1} was expected`, covered);
    if (!Number.isSafeInteger(anchor.count) || anchor.count < 1 || anchor.count < covered) {
      return fail(
        "c",
        `anchor ${anchor.seq} count ${String(anchor.count)} is not a count that goes forward`,
        covered,
      );
    }
    if (anchor.count > s.ledger.length) {
      return fail(
        "c",
        `anchor ${anchor.seq} covers ${anchor.count} entries but the ledger has ${s.ledger.length}`,
        s.ledger.length,
      );
    }
    if ((s.ledger[anchor.count - 1] as LedgerEntry | undefined)?.link !== anchor.root) {
      return fail(
        "c",
        `anchor ${anchor.seq} root does not match the link of entry ${anchor.count - 1}`,
        covered,
      );
    }
    covered = anchor.count;
  }
  const tail = s.ledger.length - covered;
  return pass(
    "c",
    `${anchors.length} anchors match the ledger${tail > 0 ? `; ${tail} newest entries not yet anchored` : ""}`,
  );
}

function decisionsByHash(s: Snapshot): Map<string, LedgerEntry> {
  const map = new Map<string, LedgerEntry>();
  for (const entry of s.ledger)
    if (isEntry(entry) && entry.body.kind === "decision") map.set(entry.body_hash, entry);
  return map;
}

/** Check d: every on-chain spend's decision_hash is the body_hash of an allow or hold decision in the ledger. */
export function checkSpendsHaveDecisions(s: Snapshot): CheckResult {
  const decisions = decisionsByHash(s);
  const preLedger = new Set(s.pre_ledger_decision_hashes ?? []);
  let documented = 0;
  for (const spend of [...s.chain.spends].sort((x, y) => x.id - y.id)) {
    const decision = decisions.get(spend.decision_hash);
    if (decision === undefined) {
      if (preLedger.has(spend.decision_hash)) {
        documented++;
        continue;
      }
      return fail(
        "d",
        `spend ${spend.id} has decision_hash ${spend.decision_hash}, which is not a decision in the ledger`,
      );
    }
    if (decision.body.verdict !== "allow" && decision.body.verdict !== "hold") {
      return fail(
        "d",
        `spend ${spend.id} points to decision seq ${decision.body.seq} with verdict ${String(decision.body.verdict)}`,
        decision.body.seq,
      );
    }
  }
  const note = documented > 0 ? `; ${documented} pre-ledger (documented) in docs/evidence` : "";
  return pass(
    "d",
    `${s.chain.spends.length - documented} on-chain spends map to allow or hold decisions${note}`,
  );
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
 * Check e: every entry with evidence passes A1–A7 (the offline attestation checks) with its own `proposal`
 * as the expected proposal. Decisions with `decided_by = "rules-only"` are reported, not failed.
 *
 * The detail says what this did NOT establish: the TDX quote is not verified offline (that is O1, run with
 * --online), and A8, the request binding, is not run. A1–A7 prove the signature, the response body, the
 * recorded proposal and the attestation report agree with each other and with the ledger position. They do
 * not prove the request was the honest one for this invoice, and not that the quote came from genuine TEE
 * hardware.
 */
export async function checkAttestations(s: Snapshot): Promise<CheckResult> {
  let attested = 0;
  const reported: string[] = [];
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
    if (outcome.kind === "attested") attested++;
    else if (outcome.kind === "reported") reported.push(outcome.note);
  }
  const tail =
    reported.length > 0
      ? `; rules-only or unattested (reported, not failed): seq ${reported.join(", ")}`
      : "";
  return pass(
    "e",
    `${attested} attested decisions pass A1–A7; quote not verified offline (run --online for O1); A8 not run (the request is not bound to the invoice)${tail}`,
  );
}

/**
 * Check f: no FullAccess key, and the vault's code hash is an expected reproducible build.
 *
 * The hash is compared with `KNOWN_VAULT_CODE_HASHES` (generated from contracts/code-hashes.json, vault builds
 * only) and with the `expected_code_hashes` the snapshot builder supplies (the factory's versions for a factory
 * vault). The result says which of the two matched. A factory build, and the all-zero hash of an account with
 * no contract code, never match.
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
  const actual = normalizeCodeHash(s.chain.code_hash);
  if (actual === null)
    return fail("f", `code_hash ${String(s.chain.code_hash)} is not a sha256 hash`);
  if (actual === ZERO_CODE_HASH) {
    return fail(
      "f",
      "the account has no contract code (the all-zero code hash); a global-mode vault must report its global contract hash",
    );
  }
  const recognised = (hashes: readonly string[]): Set<string> => {
    const set = new Set<string>();
    for (const hash of hashes) {
      const normal = normalizeCodeHash(hash);
      if (normal !== null && normal !== ZERO_CODE_HASH) set.add(normal);
    }
    return set;
  };
  if (recognised(KNOWN_VAULT_CODE_HASHES).has(actual)) {
    return pass(
      "f",
      `no FullAccess key; code_hash ${s.chain.code_hash} is a recorded reproducible build (KNOWN_VAULT_CODE_HASHES)`,
    );
  }
  const listed = recognised(s.expected_code_hashes);
  if (listed.has(actual)) {
    return pass(
      "f",
      `no FullAccess key; code_hash ${s.chain.code_hash} matches an expected build supplied by the snapshot (one of ${listed.size}; it is not among the ${KNOWN_VAULT_CODE_HASHES.length} builds recorded in this package)`,
    );
  }
  return fail(
    "f",
    `code_hash ${s.chain.code_hash} is not one of the ${listed.size} expected build hashes nor a recorded reproducible build`,
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
 * destination address, and intents' mt_burn has the vault as owner and the spend's amount.
 */
export function checkBurnMemos(s: Snapshot): CheckResult {
  const decisions = decisionsByHash(s);
  const burned = s.chain.spends.filter((sp) => sp.status === "burned").sort((x, y) => x.id - y.id);
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
    if (burn === undefined || burn.status !== "ok")
      return fail("h", `spend ${spend.id}: no burn event observed`, seq);
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
  return pass(
    "h",
    `${burned.length} burns pair a POA ft_burn with WITHDRAW_TO:<mandate address> and the vault's intents mt_burn of the spend amount`,
  );
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
  if (!isRecord(chain.config)) return "chain.config is missing";
  if (typeof chain.code_hash !== "string") return "chain.code_hash is not a string";
  return null;
}

/** Pure, offline. Async only because EIP-191 recovery in viem is async. Never throws: a broken snapshot fails. */
export async function runChecks(s: Snapshot, opts: { now?: Date } = {}): Promise<VerifyReport> {
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
    await safe("e", () => checkAttestations(s)),
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
