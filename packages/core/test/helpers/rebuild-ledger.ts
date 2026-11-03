// TEST HELPER. Rebuilds the ledger of a fixture snapshot entry by entry with real hashes, signatures and
// links, and repoints everything that refers to them, so a test can change ONE thing (a signer, a body
// field, a chain position) and leave the rest self-consistent. Used to prove which check, and only which
// check, catches a given forgery.
import { hexToBytes } from "../../src/hex.js";
import { createEd25519Signer, type LedgerSigner } from "../../src/keys.js";
import { buildEntry, computeBodyHash, computeLink, nextBodyFields } from "../../src/ledger.js";
import type { Hex32, LedgerEntry, LedgerEntryBody, Snapshot } from "../../src/types.js";
import { TEST_LEDGER_KEY } from "../fixtures/keys.js";

export const honestSigner: LedgerSigner = createEd25519Signer(TEST_LEDGER_KEY.secretKey);

export interface RebuildOptions {
  /** The signer of the entry at `seq`. Default: the fixture's honest ledger key. */
  signer?: (seq: number) => LedgerSigner;
  /** Edits a copy of the body of the entry at `seq` before it is hashed and signed. */
  edit?: (body: LedgerEntryBody, seq: number) => void;
  /** Runs after seq and prev_link are set, so it can compute things that depend on the position (an attestation nonce). */
  finish?: (body: LedgerEntryBody, seq: number) => void | Promise<void>;
  /** Overrides the chain position (seq, prev_link) an entry is given, for example to restart from the zero link. */
  position?: (seq: number, head: LedgerEntry | null) => { seq: number; prev_link: Hex32 };
  /** Hand-assemble each entry. buildEntry refuses seq >= 1 with the zero link, so a restarted chain needs this. */
  handAssemble?: boolean;
}

/** body_hash, sig, signer and link computed by hand, exactly as buildEntry does but without its guards. */
export async function assembleEntry(
  body: LedgerEntryBody,
  signer: LedgerSigner,
): Promise<LedgerEntry> {
  const bodyHash = computeBodyHash(body);
  const { sig, signer: signerPk } = await signer(hexToBytes(bodyHash));
  return {
    body,
    body_hash: bodyHash,
    sig,
    signer: signerPk,
    link: computeLink(body.prev_link, bodyHash, sig),
  };
}

/**
 * Returns a copy of `s` whose ledger is rebuilt from the same bodies (after `edit`). `refs.decision_body_hash`,
 * every anchor root (the link of entry count-1) and every spend's decision_hash follow the new hashes.
 * Anything else the edit makes inconsistent stays inconsistent: that is the point of the test.
 */
export async function rebuildLedger(s: Snapshot, o: RebuildOptions = {}): Promise<Snapshot> {
  const out = structuredClone(s);
  const renamed = new Map<string, string>();
  const ledger: LedgerEntry[] = [];
  let head: LedgerEntry | null = null;
  for (const [index, old] of s.ledger.entries()) {
    const body = structuredClone(old.body);
    const target = body.refs?.decision_body_hash;
    if (target !== undefined && renamed.has(target)) {
      body.refs = { ...body.refs, decision_body_hash: renamed.get(target) as string };
    }
    o.edit?.(body, index);
    const place = o.position?.(index, head) ?? nextBodyFields(head);
    body.seq = place.seq;
    body.prev_link = place.prev_link;
    await o.finish?.(body, index);
    const signer = o.signer?.(index) ?? honestSigner;
    const entry =
      o.handAssemble === true ? await assembleEntry(body, signer) : await buildEntry(body, signer);
    renamed.set(old.body_hash, entry.body_hash);
    ledger.push(entry);
    head = entry;
  }
  out.ledger = ledger;
  for (const anchor of out.chain.anchors) {
    const covered = ledger[anchor.count - 1];
    if (covered !== undefined) anchor.root = covered.link;
  }
  for (const spend of out.chain.spends) {
    spend.decision_hash = renamed.get(spend.decision_hash) ?? spend.decision_hash;
  }
  return out;
}
