import type { InvoiceFacts, PayeeHint } from "@probarion/core";
import { parseUsdc } from "@/lib/near/units";

// Deterministic, code-level facts read from the extracted invoice text (interfaces §8). Nothing here decides
// anything: the amount is checked by the policy and the contract, and the payee hint is only evidence for
// `mandate.payee_mismatch`. The destination is always the mandate's payee, never something read from an invoice.

const CODES = "USDC|USD|EUR|GBP|JPY|CHF|CAD|AUD|INR|CNY|RMB|SGD|KRW|VND";
const SYMBOLS = "[$€£¥₹₩₫]";
/** The currency markers that mean US dollars, which the vault pays in USDC. */
const USD_MARKERS: ReadonlySet<string> = new Set(["USDC", "USD", "$"]);

/**
 * A total and its currency: label, optional currency before the number, the number, optional currency after it
 * (same line). The number must end where the figure ends: "1.250,50" or "1.1234567" are not cut to a shorter
 * figure that reads as a smaller amount.
 */
const TOTAL = new RegExp(
  "(?:grand\\s+total|total\\s+due|amount\\s+due|balance\\s+due|total)\\s*[:\\-]?\\s*" +
    `(?:(${CODES}|${SYMBOLS})\\s*)?(${SYMBOLS})?\\s*` +
    "([0-9][0-9,]*(?:\\.[0-9]+)?)(?![0-9]|[.,][0-9])" +
    `(?:[ \\t]*(?:(${CODES})\\b|(${SYMBOLS})))?`,
  "gi",
);
/** Thousands written as 1,000 or 1,000,000 (never 12,5 or 1,25,000), with an optional decimal part. */
const GROUPED = /^[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?$/;
const PLAIN = /^[0-9]+(?:\.[0-9]+)?$/;

// R26: "PO" must be a word of its own (not "Power", "Policy", "Postal") and a reference has a digit in it.
/** A reference that starts with PO itself: "PO-4471", "PO4471". */
const PO_TOKEN = /\b(PO[-#]?[0-9][A-Z0-9-]{1,30})(?![A-Z0-9-])/i;
/** A labelled reference: "PO: 4471", "P.O. number 7781", "Purchase order #4471-A". */
const PO_LABELLED =
  /\b(?:P\.?O\b\.?|purchase[ \t]+order\b)[ \t]*(?:#|no\.?|number)?[ \t]*[:-]?[ \t]*((?=[A-Z0-9-]*[0-9])[A-Z0-9][A-Z0-9-]{2,31})(?![A-Z0-9-])/i;
const INVOICE_NO =
  /\binvoice[ \t]*(?:#|no\.?|number|num\.?|id)?[ \t]*[:-]?[ \t]*((?=[A-Z0-9/-]*[0-9])[A-Z0-9][A-Z0-9/-]{0,31})(?![A-Z0-9/-])/i;
const NEAR_ACCOUNT = /\b((?:[a-z0-9_-]+\.)+(?:near|testnet))\b/;
const EVM_ADDRESS = /\b(0x[0-9a-fA-F]{40})\b/;
const NAME = /^[ \t]*(?:from|vendor|bill[ \t]+from|payee|supplier)[ \t]*:[ \t]*(.{2,80})$/im;

/** USDC smallest units of the last total in `text`, or "0" (refused by `invoice.amount_invalid`). */
function lastAmount(text: string): string {
  let last: RegExpMatchArray | null = null;
  for (const m of text.matchAll(TOTAL)) last = m;
  if (last === null) return "0";
  const [, before, symbol, figure, codeAfter, symbolAfter] = last;
  for (const marker of [before, symbol, codeAfter, symbolAfter]) {
    if (marker !== undefined && !USD_MARKERS.has(marker.toUpperCase())) return "0";
  }
  if (figure === undefined) return "0";
  if (!PLAIN.test(figure) && !GROUPED.test(figure)) return "0";
  try {
    return parseUsdc(figure.replace(/,/g, ""));
  } catch {
    return "0";
  }
}

/** The PO reference, copied verbatim from the text (the SDK requires a verbatim substring), or null. */
function poRef(text: string): string | null {
  return PO_TOKEN.exec(text)?.[1] ?? PO_LABELLED.exec(text)?.[1] ?? null;
}

/**
 * Deterministic, code-level facts. `invoiceNumber` is for display only: the caller passes just the five
 * `InvoiceFacts` keys to `Probarion.process` (R26). The payee hint is evidence for mandate.payee_mismatch,
 * never a destination.
 */
export function extractFacts(
  text: string,
  invoiceHash: string,
  purposeHash: string | null,
): InvoiceFacts & { invoiceNumber: string | null } {
  const hint: PayeeHint = {};
  const name = NAME.exec(text)?.[1]?.trim();
  if (name) hint.name = name;
  const evm = EVM_ADDRESS.exec(text)?.[1];
  if (evm) {
    hint.chain = "base";
    hint.address = evm;
  }
  const near = NEAR_ACCOUNT.exec(text)?.[1];
  if (near) hint.near_account = near;
  return {
    invoice_hash: invoiceHash,
    amount: lastAmount(text),
    po_ref: poRef(text),
    purpose_hash: purposeHash,
    payee_hint: Object.keys(hint).length > 0 ? hint : null,
    invoiceNumber: INVOICE_NO.exec(text)?.[1] ?? null,
  };
}

/** Idempotency key for spend(): at most 64 bytes and unique per invoice text (IF §4.1). */
export function refFor(invoiceHash: string): string {
  return `inv-${invoiceHash.slice(0, 24)}`;
}
