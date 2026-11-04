import type { InvoiceFacts, PayeeHint } from "@probarion/core";
import {
  type AmountIssue,
  cappedNfkc,
  MAX_READ_UNITS,
  numberKey,
  numberView,
  readAmount,
  readInvoiceNumbers,
  skeleton,
} from "./amount";
import { EVM_ADDRESS, nearAccounts, PO_LABELLED, PO_TOKEN } from "./lexicon";

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
 * The text an invoice's fingerprint is the hash of: NFKC; blank-rendering characters as spaces; invisible
 * characters (format and default-ignorable characters) and combining marks removed; every dash-like character as
 * "-"; digit look-alikes inside a number as digits; look-alike letters folded through the amount reader's skeleton
 * (which also lower-cases); every run of whitespace as one space; trimmed. A re-upload that renders the same (other
 * line ends, a no-break or zero-width space, a Braille blank, a Unicode hyphen or box line, "1OO1" for 1001, a
 * Cyrillic letter for a Latin one) has the same fingerprint, so the pipeline answers it as a duplicate before
 * anything is sent. (The ledger's invoice_hash stays the hash of the exact text the model is shown.)
 *
 * Capped as the reader is: past MAX_READ_UNITS, or when NFKC would expand the text past its bounds, the reader
 * refuses the text anyway, and the fingerprint is the text itself (no per-character work on it).
 */
export function fingerprintText(text: string): string {
  const shown = cappedNfkc(text);
  if (shown === null) return text;
  return skeleton(numberView(shown)).replace(/\s+/g, " ").trim();
}

/**
 * The invoice number as the text states it (one number, the first the reader finds), read on the number view:
 * "INV-10<ZWSP>01", "INV<U+2011>1001" and "INV-1OO1" are INV-1001; "# INV-000415", "INV 2026-0451", a bare "No. 5520"
 * in the header, a number on the line after "Invoice number:" and one under an "Invoice #" cell are read too. For
 * display and for the duplicate guard's key. Only the first MAX_READ_UNITS units are read, and a text that NFKC would
 * expand past its bounds has no number (the reader refuses it).
 */
export function invoiceNumberOf(text: string): string | null {
  const shown = cappedNfkc(text.length > MAX_READ_UNITS ? text.slice(0, MAX_READ_UNITS) : text);
  if (shown === null) return null;
  return readInvoiceNumbers(numberView(shown))[0] ?? null;
}

/**
 * The form of an invoice number the duplicate guard keys: its skeleton in capitals, letters and digits only, so
 * case, look-alikes, dashes and spaces do not matter ("INV 1001", "inv-1001" and "INV-1001" are one key).
 */
export const numberKeyText = (number: string): string => numberKey(number);

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
