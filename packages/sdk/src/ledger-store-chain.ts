// Shared by both ledger stores: what an entry is made of, and the checks that an appended entry
// chains onto the head it was built from. All hashing and linking is core's (`computeBodyHash`,
// `computeLink`, `nextBodyFields`, `verifyEntrySignature`, `buildEntry`); nothing is re-implemented here.
import {
  buildEntry,
  canonicalJson,
  computeBodyHash,
  computeLink,
  type Hex32,
  isHex32,
  type LedgerEntry,
  type LedgerEntryBody,
  type LedgerSigner,
  nextBodyFields,
  verifyEntrySignature,
} from "@probarion/core";
import { LedgerError } from "./errors.js";
import { isRecord } from "./guards.js";

export type LedgerAppendBody = Omit<LedgerEntryBody, "seq" | "prev_link">;

/** Exactly the interface keys, in a fixed order; nothing else reaches the canonical hash. */
export function composeBody(b: LedgerAppendBody, seq: number, prevLink: Hex32): LedgerEntryBody {
  return {
    v: b.v,
    vault: b.vault,
    seq,
    prev_link: prevLink,
    kind: b.kind,
    at: b.at,
    request_id: b.request_id,
    mandate_id: b.mandate_id,
    invoice_hash: b.invoice_hash,
    amount: b.amount,
    proposal: b.proposal,
    evidence: b.evidence,
    rules: b.rules,
    verdict: b.verdict,
    decided_by: b.decided_by,
    contract: b.contract,
    settlement: b.settlement,
    refs: b.refs,
  };
}

/**
 * The body as it will be hashed AND stored: composed, proven to be plain JSON (`canonicalJson` throws
 * `CanonicalJsonError` for `undefined`, a missing field, a class instance, ...), then deep-copied so the
 * caller keeps no reference into the ledger. Without the copy, `body.rules[0].detail = "x"` after the
 * append would rewrite an entry the hash was already taken over.
 */
function snapshotBody(b: LedgerAppendBody, seq: number, prevLink: Hex32): LedgerEntryBody {
  const composed = composeBody(b, seq, prevLink);
  canonicalJson(composed);
  return structuredClone(composed);
}

/** Why `head` cannot be chained onto, or null when it is a sound entry. Recomputed by core, not trusted. */
function headProblem(head: LedgerEntry): string | null {
  if (!isRecord(head.body)) return "it has no body";
  if (!Number.isSafeInteger(head.body.seq) || head.body.seq < 0) {
    return "its seq is not a non-negative integer";
  }
  if (typeof head.body.vault !== "string" || head.body.vault.length === 0) {
    return "its vault is not an account id";
  }
  if (!isHex32(head.link) || !isHex32(head.body_hash) || !isHex32(head.body.prev_link)) {
    return "link, body_hash and prev_link must each be 64 lowercase hex";
  }
  try {
    if (computeBodyHash(head.body) !== head.body_hash)
      return "its body_hash does not match its body";
    if (computeLink(head.body.prev_link, head.body_hash, head.sig) !== head.link) {
      return "its link does not match its prev_link, body_hash and sig";
    }
  } catch (error) {
    return `it cannot be recomputed (${error instanceof Error ? error.message : String(error)})`;
  }
  return null;
}

/**
 * Before anything is signed: the new entry must be for a vault, that vault must be the ledger's own, and
 * the head it will chain onto must be a sound entry. `where` names the head for the error message
 * ("<path> line N" or "the in-memory ledger").
 */
export function assertCanChainOnto(head: LedgerEntry | null, vault: string, where: string): void {
  if (typeof vault !== "string" || vault.length === 0) {
    throw new LedgerError("a ledger entry needs the vault account id it belongs to");
  }
  if (head === null) return;
  const problem = headProblem(head);
  if (problem !== null) {
    throw new LedgerError(
      `${where}: the last entry is not internally consistent (${problem}), so a new entry would chain onto nothing sound; refusing to append. Verify the ledger first.`,
    );
  }
  if (head.body.vault !== vault) {
    throw new LedgerError(
      `${where}: this ledger belongs to vault ${head.body.vault}; refusing to append an entry for vault ${vault}`,
    );
  }
}

/**
 * After signing, before writing: the entry is the successor of `head` (seq, prev_link, vault), and its
 * hash, signature and link recompute under core. A failure here means a bug in a signer or in core, and
 * it stops the write: an entry on disk can never be repaired.
 */
export function assertChains(head: LedgerEntry | null, entry: LedgerEntry, where: string): void {
  const expected = nextBodyFields(head);
  const problems: string[] = [];
  if (entry.body.seq !== expected.seq) {
    problems.push(`seq is ${entry.body.seq}, expected ${expected.seq}`);
  }
  if (entry.body.prev_link !== expected.prev_link) {
    problems.push("prev_link is not the link of the last entry");
  }
  if (head !== null && entry.body.vault !== head.body.vault) {
    problems.push(`vault is ${entry.body.vault}, the ledger's is ${head.body.vault}`);
  }
  try {
    if (computeBodyHash(entry.body) !== entry.body_hash)
      problems.push("body_hash does not match the body");
    if (computeLink(entry.body.prev_link, entry.body_hash, entry.sig) !== entry.link) {
      problems.push("link does not match prev_link, body_hash and sig");
    }
    if (!verifyEntrySignature(entry)) problems.push("the signature does not verify");
  } catch (error) {
    problems.push(
      `cannot be recomputed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (problems.length > 0) {
    throw new LedgerError(
      `${where}: refusing to write an entry that does not chain onto the last one: ${problems.join("; ")}`,
    );
  }
}

/** The position an append expects to write at: the `seq` and `prev_link` of the new entry. */
export interface AppendExpectation {
  seq: number;
  prev_link: Hex32;
}

export interface LedgerAppendOptions {
  /**
   * Compare-and-append: the store writes the entry only if the head it reads under its lock gives exactly
   * this position, else it throws `LedgerConflictError` and writes nothing. A caller whose entry depends on
   * its position (an attested decision: its nonce binds `seq` and `prev_link`) passes the position it used.
   */
  expect?: AppendExpectation;
}

/** The ledger's head is not the one an append expected (`LedgerAppendOptions.expect`). Nothing was written. */
export class LedgerConflictError extends LedgerError {
  override name = "LedgerConflictError";
  readonly expected: AppendExpectation;
  readonly actual: AppendExpectation;
  constructor(message: string, expected: AppendExpectation, actual: AppendExpectation) {
    super(message);
    this.expected = { seq: expected.seq, prev_link: expected.prev_link };
    this.actual = { seq: actual.seq, prev_link: actual.prev_link };
  }
}

/**
 * The one place an entry is made: both stores call this under their lock, with the head they just read.
 * With `expect`, the head must give exactly that position (checked before anything is signed).
 */
export async function buildNextEntry(
  head: LedgerEntry | null,
  body: LedgerAppendBody,
  sign: LedgerSigner,
  where: string,
  expect?: AppendExpectation,
): Promise<LedgerEntry> {
  assertCanChainOnto(head, body.vault, where);
  const { seq, prev_link } = nextBodyFields(head);
  if (expect !== undefined && (expect.seq !== seq || expect.prev_link !== prev_link)) {
    throw new LedgerConflictError(
      `${where}: the ledger moved: this append expected to write seq ${String(expect.seq)} on prev_link ${String(expect.prev_link)}, but the head gives seq ${seq} on prev_link ${prev_link}; nothing was written`,
      expect,
      { seq, prev_link },
    );
  }
  const entry = await buildEntry(snapshotBody(body, seq, prev_link), sign);
  assertChains(head, entry, where);
  return entry;
}
