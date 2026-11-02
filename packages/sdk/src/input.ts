// The input checks of the Probarion class (ICR-6, ICR-3b, ICR-3c). Every one of them runs before anything is
// read, sent or written: a malformed call is `ProbarionError` `InvalidInput` and leaves no trace.
import {
  type AttestationEvidence,
  canonicalJson,
  type Hex32,
  IMMUTABLE_MANDATE_FIELDS,
  type InvoiceFacts,
  isHex32,
  type MandateView,
  type ModelProposal,
  type PayeeHint,
  type ProposalRequestInputs,
  parseModelProposal,
  proposalRequestInputsProblem,
  sha256Hex,
  utf8,
} from "@probarion/core";
import { ProbarionError } from "./errors.js";
import { isRecord, messageOf } from "./guards.js";

const NOT_TEXT =
  "hashInvoice takes the invoice text, as a string or as its UTF-8 bytes; this is not UTF-8 text. Pass the extracted text (the text the model is shown); a PDF's file hash belongs in document_sha256";

/**
 * The invoice hash (ICR-3b): `sha256Hex(utf8(text))`, the hash of the exact text the model is shown. Bytes
 * must be valid UTF-8 and hash the same as their text (a BOM is kept, so they hash as they are). Anything
 * else throws `ProbarionError` `InvalidInput`.
 */
export function hashInvoice(content: string | Uint8Array): Hex32 {
  if (typeof content === "string") return sha256Hex(utf8(content));
  if (content instanceof Uint8Array) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      throw new ProbarionError(NOT_TEXT, "InvalidInput");
    }
    return sha256Hex(utf8(text));
  }
  throw new ProbarionError(NOT_TEXT, "InvalidInput");
}

const REF_MAX_BYTES = 64; // contracts/vault/src/validate.rs `is_ref`
const U128_MAX = (1n << 128n) - 1n;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,38})$/;
const LONE_SURROGATE_RE = /[\u{D800}-\u{DFFF}]/u;

export function invalid(message: string): ProbarionError {
  return new ProbarionError(message, "InvalidInput");
}

export { isRecord, messageOf };

function checkRef(ref: unknown): string {
  if (typeof ref !== "string" || LONE_SURROGATE_RE.test(ref)) {
    throw invalid("ref must be well-formed text of 1 to 64 bytes");
  }
  const bytes = utf8(ref).length;
  if (bytes < 1 || bytes > REF_MAX_BYTES) {
    throw invalid(`ref must be 1 to ${REF_MAX_BYTES} bytes, got ${bytes}`);
  }
  return ref;
}

function checkPayeeHint(raw: unknown): PayeeHint | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw invalid("facts.payee_hint must be an object or null");
  const hint: PayeeHint = {};
  for (const key of ["near_account", "address", "name"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw invalid(`facts.payee_hint.${key} must be text`);
    hint[key] = value;
  }
  if (raw.chain !== undefined) {
    if (raw.chain !== "base" && raw.chain !== "solana") {
      throw invalid("facts.payee_hint.chain must be base or solana");
    }
    hint.chain = raw.chain;
  }
  return hint;
}

export interface ProcessInput {
  text: string;
  facts: InvoiceFacts;
  ref: string;
}

/**
 * ICR-6: `facts.invoice_hash === hashInvoice(text)` (ICR-3b) and `facts.po_ref` null or a verbatim substring
 * of `text` (ICR-3c), as `NearAiProposer.propose` and A8 require. An empty `po_ref` is written as null. The
 * facts are rebuilt with exactly their five keys, so nothing else reaches the model or the ledger.
 */
export function processInput(invoice: unknown): ProcessInput {
  if (!isRecord(invoice)) throw invalid("process() takes { text, facts, ref }");
  const { text, facts } = invoice;
  if (typeof text !== "string") {
    throw invalid("invoice.text must be the invoice text (a string): the text the model is shown");
  }
  if (!isRecord(facts)) throw invalid("invoice.facts must be an object");
  if (!isHex32(facts.invoice_hash)) {
    throw invalid("facts.invoice_hash must be 64 lowercase hex characters: use hashInvoice(text)");
  }
  if (facts.invoice_hash !== hashInvoice(text)) {
    throw invalid(
      "facts.invoice_hash must equal hashInvoice(text), the hash of the exact text the model is shown (ICR-3b)",
    );
  }
  if (typeof facts.amount !== "string") {
    throw invalid("facts.amount must be a decimal string in the token's smallest units");
  }
  const purposeHash = facts.purpose_hash ?? null;
  if (purposeHash !== null && !isHex32(purposeHash)) {
    throw invalid("facts.purpose_hash must be 64 lowercase hex characters or null");
  }
  const rawPoRef = facts.po_ref ?? null;
  if (rawPoRef !== null && typeof rawPoRef !== "string") {
    throw invalid("facts.po_ref must be text or null");
  }
  const poRef = rawPoRef === "" ? null : rawPoRef;
  if (poRef !== null && !text.includes(poRef)) {
    throw invalid(
      "facts.po_ref must be null or copied verbatim from the invoice text, with no trimming, case change or normalisation (ICR-3c)",
    );
  }
  return {
    text,
    ref: checkRef(invoice.ref),
    facts: {
      invoice_hash: facts.invoice_hash,
      amount: facts.amount,
      po_ref: poRef,
      purpose_hash: purposeHash,
      payee_hint: checkPayeeHint(facts.payee_hint),
    },
  };
}

export interface SpendInput {
  mandateId: number;
  amount: string;
  invoiceHash: Hex32;
  ref: string;
  proposal: ModelProposal | null;
  evidence: AttestationEvidence | null;
  skipPreflight: boolean;
}

function isU128Decimal(value: string): boolean {
  return DECIMAL_RE.test(value) && BigInt(value) <= U128_MAX;
}

export function spendInput(input: unknown): SpendInput {
  if (!isRecord(input)) {
    throw invalid("requestSpend() takes { mandateId, amount, invoiceHash, ref }");
  }
  const { mandateId, amount, invoiceHash } = input;
  if (typeof mandateId !== "number" || !Number.isSafeInteger(mandateId) || mandateId < 0) {
    throw invalid("mandateId must be a non-negative integer");
  }
  if (typeof amount !== "string") {
    throw invalid("amount must be a decimal string in the token's smallest units");
  }
  if (!isHex32(invoiceHash)) {
    throw invalid("invoiceHash must be 64 lowercase hex characters: use hashInvoice(text)");
  }
  const ref = checkRef(input.ref);
  const skipPreflight = input.skipPreflight ?? false;
  if (typeof skipPreflight !== "boolean") throw invalid("skipPreflight must be a boolean");
  // Raw mode skips the code rules, but the contract must still be able to read the amount, so that its
  // answer is a refusal code and not a deserialisation failure.
  if (skipPreflight && !isU128Decimal(amount)) {
    throw invalid("in raw mode the amount must still be a u128 decimal string");
  }
  const evidence = input.evidence ?? null;
  if (evidence !== null && !isRecord(evidence)) throw invalid("evidence must be an object or null");
  const rawProposal = input.proposal ?? null;
  let proposal: ModelProposal | null = null;
  if (rawProposal !== null) {
    try {
      proposal = parseModelProposal(rawProposal);
    } catch (error) {
      throw invalid(`proposal is not a model proposal: ${messageOf(error)}`);
    }
  }
  return {
    mandateId,
    amount,
    invoiceHash,
    ref,
    proposal,
    evidence: evidence as AttestationEvidence | null,
    skipPreflight,
  };
}

/**
 * Caller evidence must have been made for THIS spend (T13-R1 item 3): the model was shown this amount, this
 * mandate's purpose, and exactly this mandate (its immutable fields). Null when it was, else what differs.
 * A malformed `request_inputs` is not judged here: the evidence is then dropped by the attestation checks.
 */
export function callerEvidenceMismatch(
  evidence: AttestationEvidence,
  input: SpendInput,
  mandate: MandateView | null,
): string | null {
  const raw = evidence.request_inputs;
  if (proposalRequestInputsProblem(raw) !== null) return null;
  const inputs = raw as ProposalRequestInputs;
  if (inputs.facts !== null) {
    if (inputs.facts.amount !== input.amount) {
      return `the model was shown amount ${inputs.facts.amount}, but this spend is for ${input.amount}`;
    }
    const purpose = mandate?.purpose_hash ?? null;
    if (inputs.facts.purpose_hash !== purpose) {
      return `the model was shown purpose ${String(inputs.facts.purpose_hash)}, but mandate ${input.mandateId} has purpose ${String(purpose)}`;
    }
  }
  if (mandate === null) {
    return `the model was shown mandates ${inputs.mandates.map((m) => m.id).join(", ") || "(none)"}, but mandate ${input.mandateId} does not exist`;
  }
  const shown = inputs.mandates[0];
  if (inputs.mandates.length !== 1 || shown === undefined) {
    return `the model was shown ${inputs.mandates.length} mandates, not exactly mandate ${mandate.id}`;
  }
  for (const field of IMMUTABLE_MANDATE_FIELDS) {
    if (canonicalJson(shown[field]) !== canonicalJson(mandate[field])) {
      return `the mandate the model was shown differs from mandate ${mandate.id} on chain in ${field}`;
    }
  }
  return null;
}
