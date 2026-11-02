import { recoverMessageAddress } from "viem";
import { isRecord } from "./guards.js";
import { canonicalJson, sha256Hex } from "./hash.js";
import { bytesToHex, hexToBytes, isHex32 } from "./hex.js";
import { computeNonce, type NonceContext } from "./ledger.js";
import { extractJsonObject, parseModelProposal } from "./proposal.js";
import {
  buildProposalRequest,
  KNOWN_SYSTEM_PROMPT_HASHES,
  type KnownSystemPrompt,
  proposalRequestInputsProblem,
} from "./proposal-request.js";
import type {
  AttestationBinding,
  AttestationCheck,
  AttestationCheckId,
  AttestationEvidence,
  AttestationResult,
  Hex32,
  ModelProposal,
  ProposalRequestInputs,
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

/**
 * The text NEAR AI's `provider_tee` signature covers, as a template: the one place that decides the A1
 * format. A1, `expectedSignatureText`, the SDK's fake NEAR AI and the recorded fixtures all follow it.
 * It is the format NEAR AI documents and spike S2 used. The OWNER recording of one real decision (plan 03
 * Task 11 Step 7) confirms it; if NEAR AI really signs another text (for example without the model
 * prefix), change this constant and nothing else.
 */
export const PROVIDER_TEE_TEXT_FORMAT = "{model}:{request_sha256}:{response_sha256}";

/** Fills `PROVIDER_TEE_TEXT_FORMAT`. Each placeholder is replaced once; a value is never rescanned. */
export function formatProviderTeeText(
  model: string,
  requestSha256: string,
  responseSha256: string,
): string {
  const values: Record<string, string> = {
    model: String(model),
    request_sha256: String(requestSha256),
    response_sha256: String(responseSha256),
  };
  return PROVIDER_TEE_TEXT_FORMAT.replace(
    /\{(model|request_sha256|response_sha256)\}/g,
    (_placeholder, key: string) => values[key] ?? "",
  );
}

/** `PROVIDER_TEE_TEXT_FORMAT` with angle brackets, for check details: "<model>:<request_sha256>:<response_sha256>". */
const TEXT_FORMAT_LABEL = PROVIDER_TEE_TEXT_FORMAT.replace(/\{(\w+)\}/g, "<$1>");

export function expectedSignatureText(evidence: AttestationEvidence): string {
  return formatProviderTeeText(evidence.model, evidence.request_sha256, evidence.response_sha256);
}

/**
 * Normalises an ECDSA signature at capture (ICR-3): `0x` + r + s + v, lowercase, v in {27, 28} and low-s.
 * A raw recovery id 0 or 1 becomes 27 or 28. A high-s signature becomes its twin (s := n - s, v flipped),
 * which recovers to the same address, so a ledger never holds the malleable form. Never deduplicate on
 * raw signature bytes: both twins verify. Throws a TypeError for anything that is not a 65-byte secp256k1
 * signature (r or s outside [1, n-1], v other than 0, 1, 27 or 28).
 */
export function normalizeEcdsaSignature(signature: string): string {
  const hex =
    typeof signature === "string" && /^0[xX]/.test(signature) ? signature.slice(2) : signature;
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{130}$/.test(hex)) {
    throw new TypeError("ECDSA signature must be 65 bytes of hex (r, s, v)");
  }
  const rHex = hex.slice(0, 64).toLowerCase();
  const r = BigInt(`0x${rHex}`);
  let s = BigInt(`0x${hex.slice(64, 128)}`);
  let v = Number.parseInt(hex.slice(128, 130), 16);
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) {
    throw new TypeError(`ECDSA signature has an invalid recovery byte ${v}`);
  }
  if (r === 0n || r >= SECP256K1_N || s === 0n || s >= SECP256K1_N) {
    throw new TypeError("ECDSA signature has r or s outside [1, n - 1]");
  }
  if (s > SECP256K1_HALF_N) {
    s = SECP256K1_N - s;
    v = v === 27 ? 28 : 27;
  }
  return `0x${rHex}${s.toString(16).padStart(64, "0")}${v.toString(16)}`;
}

/**
 * True if `signature` is a low-s EIP-191 signature of `text` by `address`. The recovery byte v may be
 * spelled 27/28 (Ethereum) or 0/1 (raw recovery id): both encode the same recovery id and are
 * normalised to 27/28 before recovery. Which one NEAR AI emits is not yet known (the Task 11 recording
 * settles it), so rejecting either would risk failing every real attestation. High-s (the twin
 * n - s) and every other v are refused.
 */
async function recoversTo(text: string, signature: string, address: string): Promise<boolean> {
  const sig = signature.startsWith("0x") ? signature : `0x${signature}`;
  if (!SIGNATURE_RE.test(sig) || !ADDRESS_RE.test(address)) return false;
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = Number.parseInt(sig.slice(130, 132), 16);
  if (s === 0n || s > SECP256K1_HALF_N || (v !== 0 && v !== 1 && v !== 27 && v !== 28)) {
    return false;
  }
  const normalised = `${sig.slice(0, 130)}${(v < 27 ? v + 27 : v).toString(16)}`;
  try {
    const recovered = await recoverMessageAddress({
      message: text,
      signature: normalised as `0x${string}`,
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
    // Verification contract: extractJsonObject and parseModelProposal are frozen for ledger `v` 1. Any
    // behavioural change (what they accept, how they normalise, the reasoning length) needs a new
    // ledger `v`, and this check must then dispatch on the entry's `v` so old entries still verify.
    // Versioning is not built yet; interfaces §7 records the rule.
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
 * Scope: A1–A7 prove internal consistency only. A7 detects post-hoc tampering with a genuine
 * exchange, for example a swapped proposal or an edited response. Until the request check A8 runs
 * with the invoice documents, A1–A7 do NOT prove that the request was the honest one for this
 * invoice and position: whoever writes the ledger could send a request of their choosing and
 * record its signed answer. A8 (`checkRequestBinding`, ICR-3b) narrows that: it shows the TEE answered
 * the standard request, under an allow-listed prompt, for the invoice text bound on chain, at this ledger
 * position. It is run by an auditor who holds the invoice text, outside this function.
 * They also do not prove that the TDX quote came from genuine TEE hardware or that the signing key
 * is a measured TEE key; that is O1 (online). `quote_verified` is a boolean that this function
 * always sets to false; only the SDK's online path sets it true, after O1 verifies the DCAP quote
 * and the measurement pin.
 *
 * `expectedNonce` comes from the caller's ledger context: it is `computeNonce` over the entry's
 * `prev_link`, `invoice_hash`, `mandate_id`, `seq` and the vault account id (ICR-1). A6 compares the
 * evidence nonce with it. A5 and A6 therefore bind the attestation REPORT to one position in one
 * vault's ledger; they do not bind the chat.
 *
 * `expectedProposal` is the decision entry's recorded `proposal` (ICR-2). A7 requires the proposal inside
 * the signed response body to equal it, so a ledger writer cannot record "pay" after the model said
 * "refuse". A decision with evidence must have a proposal: null fails A7.
 *
 * Storage: the invoice text of the REQUEST is never stored in the ledger, but `evidence.response_body`
 * stores the full model output. It may quote invoice details, and its size is bounded only by the
 * model's response.
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
    `signature text is ${TEXT_FORMAT_LABEL}`,
    `signature text is not ${TEXT_FORMAT_LABEL}`,
  );
  add(
    "A2",
    sig?.signing_algo === "ecdsa" &&
      (await recoversTo(str(sig.text), str(sig.signature), signingAddress)),
    "the low-s EIP-191 signature recovers to signing_address",
    "the EIP-191 signature is high-s, has a v other than 0, 1, 27 or 28, or does not recover to signing_address",
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

// ---------- A8: request binding (ICR-3, ICR-3b) ----------

export interface RequestBindingOptions {
  /**
   * The system prompts the auditor accepts, replacing `KNOWN_SYSTEM_PROMPT_HASHES`. Extend rather than
   * replace the default: `[...KNOWN_SYSTEM_PROMPT_HASHES, knownSystemPrompt("canary", CANARY_PROMPT)]`.
   */
  systemPrompts?: readonly KnownSystemPrompt[];
}

/**
 * A8, request binding (interfaces §7, ICR-3 and ICR-3b): the auditor check that the TEE answered the
 * standard Probarion request, under an allow-listed system prompt, for exactly this invoice text, at this
 * ledger position. It is separate from `checkAttestation` because it needs the invoice text, which the
 * ledger never stores, and the ledger context of the decision entry (`vault`, `prev_link`, `seq`,
 * `invoice_hash`, `mandate_id`). It passes only when all of these hold:
 *
 *  1. `request_inputs` has the strict shape (`proposalRequestInputsProblem`): the known template, exactly
 *     the keys of interfaces §6, 64-hex hashes, decimal-string amounts, `Payee` as the exact tagged
 *     union, a status from the enum, `request_inputs.model === evidence.model`;
 *  2. the nonce recomputed from `context` equals `evidence.nonce`, and the rebuilt request carries it in
 *     its `nonce:` header;
 *  3. `request_inputs.invoice_text_sha256 === context.invoice_hash` (the value check d ties to the
 *     on-chain `spend.invoice_hash`) and `sha256(invoiceText) === invoice_text_sha256`;
 *  4. `request_inputs.facts` is not null, `facts.invoice_hash === context.invoice_hash`, and
 *     `facts.po_ref` is null or occurs in the invoice text byte for byte, as a substring (ICR-3c);
 *  5. `sha256(request_inputs.system_prompt)` is in the allow-list (`opts.systemPrompts`, default
 *     `KNOWN_SYSTEM_PROMPT_HASHES`); the detail names the prompt that matched;
 *  6. the request rebuilt by `buildProposalRequest` from the recorded inputs, the invoice text and the
 *     nonce hashes to `request_sha256`, so the signed request was byte-identical to it.
 *
 * What it does NOT prove: that `request_inputs.facts` and `request_inputs.mandates` matched the chain at
 * decision time. Task 14 compares `mandates` with the snapshot's immutable mandate fields, checks that the
 * entry's `mandate_id` is among them and that `facts.amount` equals the entry's amount; the historical
 * `remaining` and `status` cannot be checked without archival chain state. The free text that the strict
 * shape leaves open is held in place elsewhere: `po_ref` by check 4 (a substring of the invoice text), and
 * `label` and the account ids and addresses of a `payee` by their immutability on chain, which Task 14's
 * match against the snapshot covers. Prompt injection inside the invoice text itself is out of scope here:
 * `decide()` and the contract are the defence. Like A1 to A7 it does not show that the quote came from genuine TEE hardware (that is O1,
 * online). It never throws: malformed evidence or context fails. Without the invoice text or the context,
 * do not call it: A8 is then "not run".
 */
export function checkRequestBinding(
  evidence: AttestationEvidence,
  invoiceText: string,
  context: NonceContext,
  opts: RequestBindingOptions = {},
): AttestationCheck {
  const fail = (detail: string): AttestationCheck => ({ id: "A8", pass: false, detail });
  try {
    if (!isRecord(evidence)) return fail("evidence is missing or not an object");
    if (typeof invoiceText !== "string") {
      return fail("no invoice text to check the request against");
    }
    if (!isRecord(context)) return fail("no ledger context to check the request against");
    const problem = proposalRequestInputsProblem(evidence.request_inputs);
    if (problem !== null) return fail(problem);
    const inputs = evidence.request_inputs as ProposalRequestInputs;
    if (inputs.model !== evidence.model) {
      return fail("request_inputs.model differs from the model the signature covers");
    }
    if (!isHex32(evidence.request_sha256)) return fail("request_sha256 is not 64 lowercase hex");

    let nonce: Hex32;
    try {
      nonce = computeNonce(context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      return fail(`cannot recompute the nonce from the ledger context: ${reason}`);
    }
    if (evidence.nonce !== nonce) {
      return fail(
        "the evidence nonce is not the nonce recomputed from the ledger context, so the nonce header of the request is not either",
      );
    }

    if (!isHex32(context.invoice_hash)) {
      return fail("the ledger context has no invoice_hash to bind the invoice text to");
    }
    if (inputs.invoice_text_sha256 !== context.invoice_hash) {
      return fail(
        "request_inputs.invoice_text_sha256 differs from the ledger invoice_hash: the model was asked about another text than the one the chain is bound to",
      );
    }
    if (sha256Hex(invoiceText) !== inputs.invoice_text_sha256) {
      return fail(
        "sha256(invoice text) differs from request_inputs.invoice_text_sha256: this is not the invoice the model was asked about",
      );
    }
    if (inputs.facts === null) {
      return fail("request_inputs.facts is null: the model was not shown the invoice facts");
    }
    if (inputs.facts.invoice_hash !== context.invoice_hash) {
      return fail("request_inputs.facts.invoice_hash differs from the ledger invoice_hash");
    }
    // ICR-3c: the auditor holds the text, so a po_ref that is not in it was not extracted from it.
    if (inputs.facts.po_ref !== null && !invoiceText.includes(inputs.facts.po_ref)) {
      return fail(
        "request_inputs.facts.po_ref does not occur verbatim in the invoice text: it was not extracted from it",
      );
    }

    const promptHash = sha256Hex(inputs.system_prompt);
    const allowed = opts.systemPrompts ?? KNOWN_SYSTEM_PROMPT_HASHES;
    const matched = allowed.find((p) => isRecord(p) && p.sha256 === promptHash);
    if (matched === undefined) {
      return fail(
        `the system prompt (sha256 ${promptHash}) is not in the allow-list of system prompts; its text stays readable in request_inputs.system_prompt`,
      );
    }

    const rebuilt = sha256Hex(
      buildProposalRequest(
        inputs.model,
        { invoiceText, nonce, facts: inputs.facts, mandates: inputs.mandates },
        inputs.system_prompt,
      ),
    );
    if (rebuilt !== evidence.request_sha256) {
      return fail(
        `the request rebuilt from request_inputs, the invoice text and the nonce hashes to ${rebuilt}, not to request_sha256 ${evidence.request_sha256}: the chat was not asked with exactly these inputs`,
      );
    }
    return {
      id: "A8",
      pass: true,
      detail: `the standard request rebuilt from request_inputs, the invoice text bound to the ledger invoice_hash and the ledger nonce hashes to request_sha256, under the allow-listed system prompt ${JSON.stringify(String(matched.name))}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return fail(`cannot rebuild the request: ${reason}`);
  }
}

/**
 * The part of A8 that needs no invoice text (Task 14 B5, moved here from the SDK): the strict shape of
 * `request_inputs`, its model against the evidence model, both of its invoice hashes against the ledger
 * context's `invoice_hash`, and the system prompt in the allow-list (`prompts`, default
 * `KNOWN_SYSTEM_PROMPT_HASHES`). Null when all hold, else what A8 would fail on ("A8 would fail: ...").
 *
 * The SDK's `requestSpend` has only the invoice hash, so it holds caller evidence to this before writing it.
 * It is a subset of A8, never a pass of A8: the request is not rebuilt, the nonce header and `po_ref` are not
 * checked against a text, and the mandates are not matched with the chain. It never throws.
 */
export function requestInputsProblemWithoutText(
  evidence: AttestationEvidence,
  context: NonceContext,
  prompts: readonly KnownSystemPrompt[] = KNOWN_SYSTEM_PROMPT_HASHES,
): string | null {
  if (!isRecord(evidence)) return "A8 would fail: evidence is missing or not an object";
  const shape = proposalRequestInputsProblem(evidence.request_inputs);
  if (shape !== null) return `A8 would fail: ${shape}`;
  const inputs = evidence.request_inputs as ProposalRequestInputs;
  if (inputs.model !== evidence.model) {
    return "A8 would fail: request_inputs.model is not the evidence model";
  }
  const invoiceHash = isRecord(context) ? context.invoice_hash : undefined;
  if (
    !isHex32(invoiceHash) ||
    inputs.invoice_text_sha256 !== invoiceHash ||
    inputs.facts?.invoice_hash !== invoiceHash
  ) {
    return "A8 would fail: request_inputs does not carry this invoice hash";
  }
  const promptHash = sha256Hex(inputs.system_prompt);
  const listed = Array.isArray(prompts) ? prompts : [];
  if (!listed.some((p) => isRecord(p) && p.sha256 === promptHash)) {
    return "A8 would fail: the system prompt is not in the allow-list";
  }
  return null;
}
