import type { InvoiceFacts, PayeeHint } from "@probarion/core";
import { type AmountIssue, readAmount } from "./amount";
import { EVM_ADDRESS, INVOICE_NO, nearAccounts, PO_LABELLED, PO_TOKEN } from "./lexicon";

export { AMOUNT_ISSUES, type AmountIssue } from "./amount";

// Deterministic, code-level facts read from the extracted invoice text (interfaces §8). Nothing here decides
// anything: the amount is checked by the policy and the contract, and the payee hint is only evidence for
// `mandate.payee_mismatch`. The destination is always the mandate's payee, never something read from an invoice.
// The amount itself is read by amount.ts.

/** "From: Acme Design LLC", "Vendor: ...", "Bill from: ...": the payee's name, as a hint. */
const NAME =
  /^[ \t]{0,40}(?:from|vendor|bill[ \t]{1,40}from|payee|supplier)[ \t]{0,40}:[ \t]{0,40}(.{2,80})$/im;

/** The PO reference, copied verbatim from the text (the SDK requires a verbatim substring), or null. */
function poRef(text: string): string | null {
  return PO_TOKEN.exec(text)?.[1] ?? PO_LABELLED.exec(text)?.[1] ?? null;
}

/**
 * The text an invoice's fingerprint is the hash of: NFKC, lower case, every run of whitespace as one space, and
 * trimmed. A re-upload that differs only by its line ends, a final newline, a no-break space or letter case has
 * the same fingerprint, so the pipeline answers it as a duplicate before anything is sent. (The ledger's
 * invoice_hash stays the hash of the exact text the model is shown.)
 */
export function fingerprintText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Deterministic, code-level facts. `invoiceNumber` and `amountIssue` are for display and for the duplicate guard:
 * the caller passes just the five `InvoiceFacts` keys to `Probarion.process`. The payee hint is evidence for
 * mandate.payee_mismatch, never a destination. `truncated`: the text is not the whole invoice (pages or length
 * past the limits), so its total cannot be trusted and the amount is "0".
 */
export function extractFacts(
  text: string,
  invoiceHash: string,
  purposeHash: string | null,
  opts: { truncated?: boolean } = {},
): InvoiceFacts & { invoiceNumber: string | null; amountIssue: AmountIssue | null } {
  const hint: PayeeHint = {};
  const name = NAME.exec(text)?.[1]?.trim();
  if (name) hint.name = name;
  const evm = EVM_ADDRESS.exec(text)?.[1];
  if (evm) {
    hint.chain = "base";
    hint.address = evm;
  }
  const near = nearAccounts(text)[0];
  if (near) hint.near_account = near;
  const read = opts.truncated ? { amount: "0", issue: "truncated" as const } : readAmount(text);
  return {
    invoice_hash: invoiceHash,
    amount: read.amount,
    po_ref: poRef(text),
    purpose_hash: purposeHash,
    payee_hint: Object.keys(hint).length > 0 ? hint : null,
    invoiceNumber: INVOICE_NO.exec(text)?.[1] ?? null,
    amountIssue: read.issue,
  };
}

/** Idempotency key for spend(): at most 64 bytes and unique per invoice text (IF §4.1). */
export function refFor(invoiceHash: string): string {
  return `inv-${invoiceHash.slice(0, 24)}`;
}
