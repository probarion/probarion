import { recoverMessageAddress } from "viem";
import { canonicalJson, sha256Hex } from "./hash.js";
import { bytesToHex, hexToBytes, isHex32 } from "./hex.js";
import { extractJsonObject, parseModelProposal } from "./proposal.js";
import type {
  AttestationBinding,
  AttestationCheck,
  AttestationCheckId,
  AttestationEvidence,
  AttestationResult,
  Hex32,
  ModelProposal,
} from "./types.js";

/** The TD report body starts after the 48-byte quote header (v4), or after the header plus a 6-byte body descriptor (v5). */
export const TDX_QUOTE_V4_BODY_OFFSET = 48;
export const TDX_QUOTE_V5_BODY_OFFSET = 54;
/** REPORTDATA is TD report body bytes [520, 584). */
export const TDX_REPORT_DATA_BODY_OFFSET = 520;
export const TDX_REPORT_DATA_LENGTH = 64;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const REPORT_DATA_RE = /^[0-9a-f]{128}$/;

/** TDX quote v4 header tee_type (u32 little-endian at bytes 4..8); SGX is 0x00. */
const TDX_TEE_TYPE = 0x81;
/** TDX quote v5 body types: 2 = TD report 1.0, 3 = TD report 1.5 (1 is an SGX enclave report). */
const TDX_V5_BODY_TYPES: readonly number[] = [2, 3];
/** secp256k1 group order: an ECDSA signature is canonical only with s <= n/2 (low-s). */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N >> 1n;
const CHECK_IDS: readonly AttestationCheckId[] = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"];

export interface TdxQuoteInfo {
  version: 4 | 5;
  bodyOffset: number;
  reportData: string; // 128 lowercase hex
}

/**
 * Reads the quote version (u16 little-endian at bytes 0–1) and the 64-byte report_data. Null if
 * unparseable or not a TDX quote: v4 needs tee_type 0x81 (u32 LE at bytes 4..8), v5 needs body type 2 or 3
 * (u16 LE at bytes 48..50). This is a format check, not a verification: O1 verifies the quote online.
 */
export function parseTdxQuote(intelQuoteHex: string): TdxQuoteInfo | null {
  if (typeof intelQuoteHex !== "string") return null;
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(intelQuoteHex.trim());
  } catch {
    return null;
  }
  if (bytes.length < 2) return null;
  const version = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, true);
  if (version !== 4 && version !== 5) return null;
  const bodyOffset = version === 4 ? TDX_QUOTE_V4_BODY_OFFSET : TDX_QUOTE_V5_BODY_OFFSET;
  const start = bodyOffset + TDX_REPORT_DATA_BODY_OFFSET;
  if (bytes.length < start + TDX_REPORT_DATA_LENGTH) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (version === 4 && view.getUint32(4, true) !== TDX_TEE_TYPE) return null;
  if (version === 5 && !TDX_V5_BODY_TYPES.includes(view.getUint16(48, true))) return null;
  return {
    version,
    bodyOffset,
    reportData: bytesToHex(bytes.slice(start, start + TDX_REPORT_DATA_LENGTH)),
  };
}

export function extractReportDataFromQuote(intelQuoteHex: string): string | null {
  return parseTdxQuote(intelQuoteHex)?.reportData ?? null;
}

export function expectedSignatureText(evidence: AttestationEvidence): string {
  return `${evidence.model}:${evidence.request_sha256}:${evidence.response_sha256}`;
}

/**
 * True if `signature` is a canonical EIP-191 signature (low-s, v 27 or 28) of `text` by `address`.
 * The twin (n - s, flipped v) and the v 0/1 spelling recover to the same address, so accepting them
 * would let one signed response carry several byte-different signatures.
 */
async function recoversTo(text: string, signature: string, address: string): Promise<boolean> {
  const sig = signature.startsWith("0x") ? signature : `0x${signature}`;
  if (!SIGNATURE_RE.test(sig) || !ADDRESS_RE.test(address)) return false;
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = Number.parseInt(sig.slice(130, 132), 16);
  if (s === 0n || s > SECP256K1_HALF_N || (v !== 27 && v !== 28)) return false;
  try {
    const recovered = await recoverMessageAddress({
      message: text,
      signature: sig as `0x${string}`,
    });
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

/** Evidence is read back from a ledger file, so a wrong-typed field must fail a check, never throw. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A7: the response body is the signed one, belongs to this chat, and says what the entry recorded. */
function checkResponseBinding(
  evidence: AttestationEvidence,
  expectedProposal: ModelProposal | null,
): { pass: boolean; detail: string } {
  const fail = (detail: string): { pass: false; detail: string } => ({ pass: false, detail });
  if (expectedProposal === null || expectedProposal === undefined) {
    return fail("no recorded proposal to bind");
  }
  const body = evidence.response_body;
  if (typeof body !== "string") return fail("response_body is missing");
  if (sha256Hex(body) !== evidence.response_sha256) {
    return fail("sha256(response_body) differs from response_sha256");
  }
  let completion: unknown;
  try {
    completion = JSON.parse(body);
  } catch {
    return fail("response_body is not JSON");
  }
  if (typeof completion !== "object" || completion === null || Array.isArray(completion)) {
    return fail("response_body is not a JSON object");
  }
  const { id, choices } = completion as { id?: unknown; choices?: unknown };
  const chatId = evidence.chat_id;
  if (typeof id !== "string" || id.length === 0 || id !== chatId) {
    return fail("the id inside response_body is not the evidence chat_id");
  }
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message: unknown =
    typeof first === "object" && first !== null
      ? (first as { message?: unknown }).message
      : undefined;
  const content: unknown =
    typeof message === "object" && message !== null
      ? (message as { content?: unknown }).content
      : undefined;
  if (typeof content !== "string")
    return fail("response_body has no choices[0].message.content text");
  let signed: string;
  try {
    signed = canonicalJson(parseModelProposal(extractJsonObject(content)));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return fail(`the signed response does not hold a valid proposal: ${reason}`);
  }
  let recorded: string;
  try {
    recorded = canonicalJson(expectedProposal);
  } catch {
    return fail("the recorded proposal cannot be canonicalised");
  }
  if (signed !== recorded) {
    return fail("the proposal in the signed response differs from the recorded proposal");
  }
  return {
    pass: true,
    detail:
      "response_body hashes to response_sha256, carries chat_id and holds exactly the recorded proposal",
  };
}

/**
 * Offline checks A1–A7 of interfaces §7. Online checks O1/O2 live in @probarion/sdk.
 *
 * Scope: A1–A7 prove internal consistency only. They do not prove that the TDX quote came from
 * genuine TEE hardware or that the signing key is a measured TEE key; that is O1 (online), so every
 * result carries `quote_verified: false`. A8 (request binding) needs the invoice document and is run
 * by an auditor, outside this function.
 *
 * `expectedNonce` comes from the caller's ledger context: it is `computeNonce` over the entry's
 * `prev_link`, `invoice_hash`, `mandate_id`, `seq` and the vault account id (ICR-1). A6 compares the
 * evidence nonce with it, which binds the model's answer to one position in one vault's ledger.
 *
 * `expectedProposal` is the decision entry's recorded `proposal` (ICR-2). A7 requires the proposal inside
 * the signed response body to equal it, so a ledger writer cannot record "pay" after the model said
 * "refuse". A decision with evidence must have a proposal: null fails A7.
 */
export async function checkAttestation(
  evidence: AttestationEvidence,
  expectedNonce: Hex32,
  expectedProposal: ModelProposal | null,
): Promise<AttestationResult> {
  // Evidence comes from a ledger file or a snapshot: whatever it is, report failed checks, never throw.
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    const detail = "evidence is missing or not an object";
    return {
      ok: false,
      binding: "none",
      quote_verified: false,
      checks: CHECK_IDS.map((id) => ({ id, pass: false, detail })),
    };
  }
  const sig = evidence.signature;
  const signingAddress = str(sig?.signing_address);
  const signer = signingAddress.toLowerCase();
  const checks: AttestationCheck[] = [];
  const add = (id: AttestationCheckId, pass: boolean, ok: string, bad: string): void => {
    checks.push({ id, pass, detail: pass ? ok : bad });
  };

  add(
    "A1",
    isHex32(evidence.request_sha256) &&
      isHex32(evidence.response_sha256) &&
      str(sig?.text) === expectedSignatureText(evidence),
    "signature text is <model>:<request_sha256>:<response_sha256>",
    "signature text is not <model>:<request_sha256>:<response_sha256>",
  );
  add(
    "A2",
    sig?.signing_algo === "ecdsa" &&
      (await recoversTo(str(sig.text), str(sig.signature), signingAddress)),
    "the canonical EIP-191 signature recovers to signing_address",
    "the EIP-191 signature is not canonical (low-s, v 27 or 28) or does not recover to signing_address",
  );
  const report = evidence.report;
  add(
    "A3",
    report !== null &&
      report !== undefined &&
      report.signing_algo === "ecdsa" &&
      ADDRESS_RE.test(signingAddress) &&
      str(report.signing_address).toLowerCase() === signer,
    "the report signer is the ecdsa response signer",
    report === null || report === undefined
      ? "no attestation report (no single signer-matched candidate): the entry is unattested"
      : "report signing_address or signing_algo does not match the ecdsa response signer",
  );

  let binding: AttestationBinding = "none";
  let a4 = false;
  let a5 = false;
  let a4Detail = "no attestation report";
  let a5Detail = "no attestation report";
  if (report !== null && report !== undefined) {
    const reportData = str(report.report_data).toLowerCase();
    const consistent =
      REPORT_DATA_RE.test(reportData) &&
      extractReportDataFromQuote(str(report.intel_quote)) === reportData;
    if (!consistent) {
      a4Detail = "report_data is malformed or differs from the report data inside intel_quote";
      a5Detail = a4Detail;
    } else if (!ADDRESS_RE.test(signingAddress)) {
      a4Detail = "signing_address is not a 20-byte EVM address";
      a5Detail = a4Detail;
    } else {
      binding =
        reportData.slice(0, 64) === `${signer.slice(2)}${"0".repeat(24)}` ? "address" : "tls";
      a4 = binding === "address";
      a4Detail = a4
        ? "report_data[0..32] is the zero-padded signer"
        : "report_data[0..32] is not the zero-padded signer (a TLS binding needs --online)";
      a5 = reportData.slice(64) === evidence.nonce && report.request_nonce === evidence.nonce;
      a5Detail = a5
        ? "report_data[32..64] and request_nonce equal the evidence nonce"
        : "report_data[32..64] or the report's request_nonce is not the evidence nonce";
    }
  }
  checks.push({ id: "A4", pass: a4, detail: a4Detail }, { id: "A5", pass: a5, detail: a5Detail });
  add(
    "A6",
    isHex32(evidence.nonce) && evidence.nonce === expectedNonce,
    "the nonce equals the nonce recomputed from the ledger context (prev_link, invoice_hash, mandate_id, seq, vault)",
    "the evidence nonce differs from the nonce recomputed from the ledger context (prev_link, invoice_hash, mandate_id, seq, vault)",
  );
  const a7 = checkResponseBinding(evidence, expectedProposal);
  checks.push({ id: "A7", pass: a7.pass, detail: a7.detail });
  return { ok: checks.every((c) => c.pass), binding, quote_verified: false, checks };
}
