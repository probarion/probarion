// The price quote a 402 answer carries. Its text is the invoice: the agent pays sha256(text) under a mandate,
// and the seller checks that the spend it is shown paid exactly that hash, to its own account, in full.
import { isNearAccountId, sha256Hex, utf8 } from "@probarion/core";

export const QUOTE_HEADER = "probarion-402-quote/v1";

export interface Quote {
  id: string;
  resource: string;
  /** The NEAR account the seller is paid at. */
  payee: string;
  /** USDC smallest units (6 decimals). */
  amount: string;
  network: "mainnet" | "testnet";
  expiresAt: string;
}

export class QuoteError extends Error {}

/** USDC smallest units as a quote writes them: a whole number above 0, with no leading zero. */
export const UNITS_RE = /^[1-9][0-9]{0,30}$/;

/**
 * What the seller asks for one resource. The list price goes into the first quote. The floor is the least
 * the seller takes for a counter: it stays on the seller's side, and no answer of the paywall carries it.
 */
export interface Pricing {
  /** USDC smallest units. */
  listUnits: string;
  /** USDC smallest units, at most the list price. */
  floorUnits: string;
}

/** Returns the pricing when both prices are units and the floor is not above the list price; throws otherwise. */
export function checkPricing(p: Pricing): Pricing {
  if (!UNITS_RE.test(p.listUnits) || !UNITS_RE.test(p.floorUnits)) {
    throw new QuoteError("the list price and the floor must be USDC smallest units above 0");
  }
  if (BigInt(p.floorUnits) > BigInt(p.listUnits)) {
    throw new QuoteError("the floor must not be above the list price");
  }
  return p;
}

export type CounterVerdict = "accept" | "below_floor" | "not_below_quote";

/** The seller's answer to a counter: below the quoted amount and at or above the floor is a deal. */
export function judgeCounter(
  p: Pricing,
  quotedUnits: string,
  counterUnits: string,
): CounterVerdict {
  if (BigInt(counterUnits) >= BigInt(quotedUnits)) return "not_below_quote";
  return BigInt(counterUnits) >= BigInt(p.floorUnits) ? "accept" : "below_floor";
}

export function quoteText(q: Quote): string {
  return [
    QUOTE_HEADER,
    `id: ${q.id}`,
    `resource: ${q.resource}`,
    `payee: near:${q.payee}`,
    `amount: ${q.amount}`,
    `network: ${q.network}`,
    `expires_at: ${q.expiresAt}`,
  ].join("\n");
}

/** The invoice hash of a quote: what `request_spend` takes as `invoice_hash`. */
export function quoteHash(text: string): string {
  return sha256Hex(utf8(text));
}

const LINE = /^([a-z_]+): (.+)$/;

/** Reads a quote back from its text, and refuses anything that is not exactly what `quoteText` writes. */
export function parseQuote(text: string): Quote {
  const [header, ...lines] = text.split("\n");
  if (header !== QUOTE_HEADER) throw new QuoteError(`not a ${QUOTE_HEADER} quote`);
  const fields = new Map<string, string>();
  for (const line of lines) {
    const m = LINE.exec(line);
    if (m === null || m[1] === undefined || m[2] === undefined || fields.has(m[1])) {
      throw new QuoteError(`bad quote line ${JSON.stringify(line).slice(0, 80)}`);
    }
    fields.set(m[1], m[2]);
  }
  const get = (k: string): string => {
    const v = fields.get(k);
    if (v === undefined) throw new QuoteError(`the quote has no ${k}`);
    return v;
  };
  const payee = get("payee");
  const account = payee.startsWith("near:") ? payee.slice("near:".length) : "";
  if (!isNearAccountId(account)) throw new QuoteError("the quote's payee is not near:<account>");
  const amount = get("amount");
  if (!UNITS_RE.test(amount)) throw new QuoteError("the quote's amount is not units");
  const network = get("network");
  if (network !== "mainnet" && network !== "testnet") {
    throw new QuoteError("the quote's network is not mainnet or testnet");
  }
  const q: Quote = {
    id: get("id"),
    resource: get("resource"),
    payee: account,
    amount,
    network,
    expiresAt: get("expires_at"),
  };
  if (fields.size !== 6 || quoteText(q) !== text) throw new QuoteError("the quote has extra text");
  return q;
}
