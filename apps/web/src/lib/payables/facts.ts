import type { InvoiceFacts, PayeeHint } from "@probarion/core";
import { type AmountIssue, numberView, readAmount, skeleton } from "./amount";
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
 * The text an invoice's fingerprint is the hash of: NFKC; invisible characters (format and default-ignorable
 * characters) and combining marks removed; every dash as "-"; look-alike letters folded through the amount
 * reader's skeleton (which also lower-cases); every run of whitespace as one space; trimmed. A re-upload that
 * renders the same (other line ends, a no-break space, a zero-width space, a Unicode hyphen, a Cyrillic letter for
 * a Latin one) has the same fingerprint, so the pipeline answers it as a duplicate before anything is sent. (The
 * ledger's invoice_hash stays the hash of the exact text the model is shown.)
 */
export function fingerprintText(text: string): string {
  return skeleton(numberView(text.normalize("NFKC")))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The invoice number as the text states it, read with invisible characters removed and every dash as "-": the
 * number of "INV-10<ZWSP>01" or "INV<U+2011>1001" is INV-1001. For display and for the duplicate guard's key.
 */
export function invoiceNumberOf(text: string): string | null {
  return INVOICE_NO.exec(numberView(text.normalize("NFKC")))?.[1] ?? null;
}

/** The form of an invoice number the duplicate guard keys: the skeleton, so case and look-alikes do not matter. */
export const numberKeyText = (number: string): string => skeleton(number.normalize("NFKC"));

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
    invoiceNumber: invoiceNumberOf(text),
    amountIssue: read.issue,
  };
}

/** Idempotency key for spend(): at most 64 bytes and unique per invoice text (IF §4.1). */
export function refFor(invoiceHash: string): string {
  return `inv-${invoiceHash.slice(0, 24)}`;
}
