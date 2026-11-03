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
 * Why the amount is "0" (rule `invoice.amount_invalid` refuses it, and the console says why), or null when it was
 * read: no final total; final totals that disagree; a figure the code cannot read exactly; another currency; or a
 * text cut short (a PDF with more pages than are read, or text past the length limit), whose total may be missing.
 */
export type AmountIssue = "not_found" | "ambiguous" | "unreadable" | "currency" | "truncated";

const LABEL = "(?:grand\\s+total|total\\s+due|amount\\s+due|balance\\s+due|total)";
/**
 * Only a FINAL total counts. The label must not continue a word ("Subtotal") nor follow a word that makes it a
 * partial total or another document's ("Sub-total", "Page total", "Contract total", "Year-to-date total", "YTD
 * total", "Installment total").
 */
const FINAL =
  "(?<![\\p{L}\\p{N}])(?<!\\b(?:sub|page|contract|year[\\s-]*to[\\s-]*date|ytd|installment|instalment)[\\s-]*)";
/** The spaces a figure can be grouped with: space, tab, no-break space, thin spaces. */
const SPACE = "[ \\t\\u00A0\\u2009\\u202F]";
/**
 * A final total and its currency: label, optional currency before the number, the number, optional currency
 * after it (same line), then what follows. The number must end where the figure ends: "1.250,50" or "1.1234567"
 * are not cut to a shorter figure. The last group catches a figure grouped with spaces ("1 000,00") and a number
 * followed by a word that is no currency ("Total 3 items": a count, not an amount).
 */
const TOTAL = new RegExp(
  `${FINAL}${LABEL}\\s*[:\\-]?\\s*` +
    `(?:(${CODES}|${SYMBOLS})\\s*)?(${SYMBOLS})?\\s*` +
    "([0-9][0-9,]*(?:\\.[0-9]+)?)(?![0-9]|[.,][0-9])" +
    `(?:[ \\t]*(?:(${CODES})\\b|(${SYMBOLS})))?` +
    `(${SPACE}[0-9]{3}(?![0-9])|${SPACE}*\\p{L})?`,
  "giu",
);
/** Thousands written as 1,000 or 1,000,000 (never 12,5 or 1,25,000), with an optional decimal part. */
const GROUPED = /^[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?$/;
const PLAIN = /^[0-9]+(?:\.[0-9]+)?$/;
const SPACE_GROUPED = /[0-9]{3}$/;

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

/** One final-total match: its USDC units, why it cannot be read, or null when it is a count, not an amount. */
function candidate(m: RegExpMatchArray): { units: string } | { issue: AmountIssue } | null {
  const [, before, symbol, figure, codeAfter, symbolAfter, after] = m;
  if (after !== undefined) {
    if (SPACE_GROUPED.test(after)) return { issue: "unreadable" }; // "1 000,00" must never read as 1
    if (codeAfter === undefined && symbolAfter === undefined) return null; // "Total 3 items"
  }
  for (const marker of [before, symbol, codeAfter, symbolAfter]) {
    if (marker !== undefined && !USD_MARKERS.has(marker.toUpperCase()))
      return { issue: "currency" };
  }
  if (figure === undefined || (!PLAIN.test(figure) && !GROUPED.test(figure))) {
    return { issue: "unreadable" };
  }
  try {
    return { units: parseUsdc(figure.replace(/,/g, "")) };
  } catch {
    return { issue: "unreadable" };
  }
}

/**
 * The invoice amount in USDC smallest units, failing closed: every final total in the text must be readable,
 * in US dollars, and all must agree ("Total: 100 … Total due: 9,999" is refused, never one of the two picked).
 * In rules-only mode this amount goes straight to `spend`, so anything doubtful is "0" with its reason.
 */
function readAmount(text: string): { amount: string; issue: AmountIssue | null } {
  const values = new Set<string>();
  for (const m of text.matchAll(TOTAL)) {
    const c = candidate(m);
    if (c === null) continue;
    if ("issue" in c) return { amount: "0", issue: c.issue };
    values.add(c.units);
  }
  const [only, ...more] = [...values];
  if (only === undefined) return { amount: "0", issue: "not_found" };
  if (more.length > 0) return { amount: "0", issue: "ambiguous" };
  return { amount: only, issue: null };
}

/** The PO reference, copied verbatim from the text (the SDK requires a verbatim substring), or null. */
function poRef(text: string): string | null {
  return PO_TOKEN.exec(text)?.[1] ?? PO_LABELLED.exec(text)?.[1] ?? null;
}

/**
 * Deterministic, code-level facts. `invoiceNumber` and `amountIssue` are for display only: the caller passes just
 * the five `InvoiceFacts` keys to `Probarion.process` (R26). The payee hint is evidence for
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
  const near = NEAR_ACCOUNT.exec(text)?.[1];
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
