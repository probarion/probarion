import { canonicalJson, sha256Bytes, sha256Hex } from "./hash.js";
import { bytesToHex, concatBytes, hexToBytes, isHex32, u64be, utf8, ZERO_HEX32 } from "./hex.js";
import { type LedgerSigner, parseSignature, verifyEd25519 } from "./keys.js";
import type { Hex32, LedgerEntry, LedgerEntryBody } from "./types.js";

export const ZERO_LINK: Hex32 = ZERO_HEX32;
export const NONCE_DOMAIN = "probarion/v1";

export class LedgerFormatError extends Error {
  override name = "LedgerFormatError";
}

/** sha256 of the RFC 8785 canonical JSON of the whole body: every body field is covered. */
export function computeBodyHash(body: LedgerEntryBody): Hex32 {
  return sha256Hex(canonicalJson(body));
}

/** link = sha256(bytes(prev_link) || bytes(body_hash) || raw 64-byte signature) (interfaces §6). */
export function computeLink(prevLink: Hex32, bodyHash: Hex32, sig: string): Hex32 {
  if (!isHex32(prevLink)) throw new LedgerFormatError("prev_link must be 64 lowercase hex");
  if (!isHex32(bodyHash)) throw new LedgerFormatError("body_hash must be 64 lowercase hex");
  return bytesToHex(
    sha256Bytes(concatBytes(hexToBytes(prevLink), hexToBytes(bodyHash), parseSignature(sig))),
  );
}

export function nextBodyFields(head: LedgerEntry | null): { seq: number; prev_link: Hex32 } {
  return head === null
    ? { seq: 0, prev_link: ZERO_LINK }
    : { seq: head.body.seq + 1, prev_link: head.link };
}

export async function buildEntry(
  body: LedgerEntryBody,
  signer: LedgerSigner,
): Promise<LedgerEntry> {
  if (!Number.isSafeInteger(body.seq) || body.seq < 0) {
    throw new LedgerFormatError(`invalid seq ${body.seq}`);
  }
  if (!isHex32(body.prev_link)) throw new LedgerFormatError("prev_link must be 64 lowercase hex");
  if (body.seq === 0 && body.prev_link !== ZERO_LINK) {
    throw new LedgerFormatError("the entry with seq 0 must have the all-zero prev_link");
  }
  const bodyHash = computeBodyHash(body);
  const { sig, signer: signerPk } = await signer(hexToBytes(bodyHash));
  // An entry is append-only: one that does not verify could never be repaired afterwards, so a
  // broken signer (a remote KMS, a wrong key) is caught before the entry reaches a store.
  if (!verifyEd25519(sig, hexToBytes(bodyHash), signerPk)) {
    throw new LedgerFormatError("the signer returned a signature that does not verify");
  }
  return {
    body,
    body_hash: bodyHash,
    sig,
    signer: signerPk,
    link: computeLink(body.prev_link, bodyHash, sig),
  };
}

/**
 * True when `entry.sig` is a valid Ed25519 signature by `entry.signer` over the 32 raw bytes of
 * `entry.body_hash`. It does NOT recompute `body_hash` from `body`, and it does not say that
 * `signer` is the vault's ledger key: callers (the verifier's checks a and b) must also compare
 * `computeBodyHash(entry.body)` with `entry.body_hash` and `signer` with the on-chain key.
 */
export function verifyEntrySignature(entry: LedgerEntry): boolean {
  if (!isHex32(entry.body_hash)) return false;
  return verifyEd25519(entry.sig, hexToBytes(entry.body_hash), entry.signer);
}

export interface NonceContext {
  prev_link: Hex32;
  invoice_hash: Hex32 | null;
  mandate_id: number | null;
  seq: number;
}

function assertU64(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LedgerFormatError(`${what} must be a non-negative safe integer, got ${value}`);
  }
}

/**
 * nonce = sha256(utf8("probarion/v1") || prev_link || (invoice_hash ?? 32 zero bytes)
 *                || u64be(mandate_id ?? 0) || u64be(seq)); `seq` is the decision entry about to be written.
 */
export function computeNonce(ctx: NonceContext): Hex32 {
  if (!isHex32(ctx.prev_link)) throw new LedgerFormatError("prev_link must be 64 lowercase hex");
  if (ctx.invoice_hash !== null && !isHex32(ctx.invoice_hash)) {
    throw new LedgerFormatError("invoice_hash must be 64 lowercase hex");
  }
  if (ctx.mandate_id !== null) assertU64(ctx.mandate_id, "mandate_id");
  assertU64(ctx.seq, "seq");
  return sha256Hex(
    concatBytes(
      utf8(NONCE_DOMAIN),
      hexToBytes(ctx.prev_link),
      ctx.invoice_hash === null ? new Uint8Array(32) : hexToBytes(ctx.invoice_hash),
      u64be(ctx.mandate_id ?? 0),
      u64be(ctx.seq),
    ),
  );
}
