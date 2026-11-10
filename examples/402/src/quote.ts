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
  if (!/^[1-9][0-9]{0,30}$/.test(amount)) throw new QuoteError("the quote's amount is not units");
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
