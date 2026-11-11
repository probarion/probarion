// A tiny pay-per-call endpoint. Without a payment it answers 402 with a quote: a price, a payee and the text
// to pay. With one, it reads the spend from the payer's Probarion vault on NEAR and serves the data only if
// that spend paid this quote, in full, to this seller. Each quote serves one call.
//
// A buyer may counter a quote once (POST /counter). A counter below the quote and at or above the seller's
// floor gets a new quote at the countered price; any other counter is refused. The floor never leaves this
// process.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isNearAccountId, NETWORKS, type SpendView } from "@probarion/core";
import { FactoryClient, type RpcClient, VaultClient } from "@probarion/sdk";
import { checkPricing, judgeCounter, type Quote, quoteHash, quoteText, UNITS_RE } from "./quote.js";
import { DATA_SHA256_FIELD, dataSha256 } from "./receipts.js";

/** What the seller reads from NEAR to check a payment. */
export interface PaymentReader {
  /** True when the account is a vault that Probarion's factory created (so it runs the vault's code). */
  isProbarionVault(vault: string): Promise<boolean>;
  getSpend(vault: string, spendId: number): Promise<SpendView | null>;
}

export function chainReader(rpc: RpcClient, network: "mainnet" | "testnet"): PaymentReader {
  const factory = new FactoryClient(NETWORKS[network].factory, rpc);
  return {
    isProbarionVault: async (vault) => (await factory.vaultVersion(vault)) !== null,
    getSpend: (vault, spendId) => new VaultClient(vault, rpc).getSpend(spendId),
  };
}

export interface PaywallOptions {
  network: "mainnet" | "testnet";
  /** The seller's NEAR account: the payee a buyer's mandate must name. */
  payee: string;
  /** The list price of one call, in USDC smallest units: the amount of every first quote. */
  priceUnits: string;
  /**
   * The least the seller takes for a counter, in USDC smallest units, at most the list price. It is not sent
   * to anyone. Default: the list price, so every counter is refused.
   */
  floorUnits?: string;
  /** The one path this endpoint serves, e.g. "/forecast". Not "/counter", where counters go. */
  path: string;
  /**
   * The data of paid call number `call` (1, 2, ...). It is sent as JSON, which drops undefined values and turns a
   * Date into its ISO text; `data_sha256` is computed over what is sent. When it throws, or its value has no
   * JSON form, the answer is 500 and the quote stays unredeemed.
   */
  data: (call: number) => unknown;
  reader: PaymentReader;
  /** How long a quote may be paid for. Default 5 minutes. */
  quoteTtlMs?: number;
  /** How long after its expiry a quote paid in time can still be redeemed. Default 10 minutes. */
  redeemGraceMs?: number;
  /** The most quotes kept at once; the oldest go first. Default 10,000. */
  maxQuotes?: number;
  now?: () => Date;
  newQuoteId?: () => string;
}

interface Issued {
  quote: Quote;
  text: string;
  hash: string;
  /**
   * Given only to the client that got the 402. The quote id goes on chain in the spend's ref, so anyone can
   * read it and the spend id; this token is what ties the call to the client that paid.
   */
  token: string;
  /** When the quote stops being kept, in ms: its expiry plus the grace to redeem a quote paid in time. */
  dropAt: number;
  redeemed: boolean;
  /** The quote this one was issued for, when it answers a counter: it cannot be countered again. */
  counterOf: string | null;
  /** Set when this quote's one counter was judged: the new quote's id, or the verdict that refused it. */
  counter: string | null;
}

export const PAYMENT_HEADERS = {
  quote: "x-probarion-quote",
  redeem: "x-probarion-redeem",
  vault: "x-probarion-vault",
  spend: "x-probarion-spend",
} as const;

/** Where a buyer sends its one counter for a quote: POST, on the paywall's origin. */
export const COUNTER_PATH = "/counter";

/** The JSON body of a counter. */
export interface CounterRequest {
  quote_id: string;
  /** The countered price, in USDC smallest units. */
  amount: string;
  /** The redeem token of the 402 that carried the quote: only the client that got the quote may counter it. */
  redeem_token: string;
  /** A short reason, for the seller's people. */
  reason?: string;
}

const COUNTER_FIELDS = new Set(["quote_id", "amount", "redeem_token", "reason"]);
const MAX_COUNTER_BYTES = 4096;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The data of a paid answer as the buyer parses it, and its sha256. A JSON round trip first: it drops undefined
 * values and turns a Date into its ISO text, as the answer's JSON does, so the hash covers exactly what the
 * buyer gets. Throws when the data has no JSON form (a cycle, a BigInt) or no canonical JSON form.
 */
function paidData(raw: unknown): { data: unknown; sha256: string } {
  const text = JSON.stringify(raw);
  const data: unknown = text === undefined ? null : JSON.parse(text);
  return { data, sha256: dataSha256(data) };
}

class BodyTooLarge extends Error {}

/** The request body as text, or BodyTooLarge past `limit` bytes (the rest is drained, so the answer still goes out). */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.off("data", onData);
        req.resume();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The counter, or why it is not one. Unknown fields are refused. */
function parseCounter(raw: string): CounterRequest | string {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return "not_json";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "not_an_object";
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !COUNTER_FIELDS.has(k))) return "unknown_field";
  const { quote_id, amount, redeem_token, reason } = b;
  if (typeof quote_id !== "string" || quote_id.length === 0 || quote_id.length > 100) {
    return "bad_quote_id";
  }
  if (typeof amount !== "string" || !UNITS_RE.test(amount)) return "bad_amount";
  if (typeof redeem_token !== "string" || redeem_token.length > 100) return "bad_redeem_token";
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    return "bad_reason";
  }
  return { quote_id, amount, redeem_token, ...(reason === undefined ? {} : { reason }) };
}

export function createPaywall(opts: PaywallOptions) {
  if (opts.path === COUNTER_PATH) throw new Error(`the paywall's path cannot be ${COUNTER_PATH}`);
  const pricing = checkPricing({
    listUnits: opts.priceUnits,
    floorUnits: opts.floorUnits ?? opts.priceUnits,
  });
  const now = opts.now ?? (() => new Date());
  const ttl = opts.quoteTtlMs ?? 5 * 60_000;
  const grace = opts.redeemGraceMs ?? 10 * 60_000;
  const maxQuotes = opts.maxQuotes ?? 10_000;
  const newId = opts.newQuoteId ?? (() => `q_${randomBytes(12).toString("hex")}`);
  // In the order the quotes were issued, which is the order they expire in, since every quote has one TTL.
  const issued = new Map<string, Issued>();
  let served = 0;
  let counters = 0;

  /** Drops the quotes past their grace, from the oldest, and the oldest beyond the cap. */
  function prune(at: number): void {
    for (const [id, e] of issued) {
      if (e.dropAt > at && issued.size < maxQuotes) break;
      issued.delete(id);
    }
  }

  /**
   * Issues a quote for `amount` and answers with it: 402 for a first quote, 200 for a counter's. Returns the
   * new quote's id.
   */
  function offer(
    res: ServerResponse,
    amount: string,
    extra: { status: 402; reason: string | null } | { status: 200; counterOf: string },
  ): string {
    const at = now().getTime();
    prune(at);
    const quote: Quote = {
      id: newId(),
      resource: `GET ${opts.path}`,
      payee: opts.payee,
      amount,
      network: opts.network,
      expiresAt: new Date(at + ttl).toISOString(),
    };
    const text = quoteText(quote);
    const hash = quoteHash(text);
    const token = randomBytes(16).toString("hex");
    const counterOf = extra.status === 200 ? extra.counterOf : null;
    issued.set(quote.id, {
      quote,
      text,
      hash,
      token,
      dropAt: at + ttl + grace,
      redeemed: false,
      counterOf,
      counter: null,
    });
    const head =
      extra.status === 402
        ? { error: "payment_required", ...(extra.reason === null ? {} : { reason: extra.reason }) }
        : { countered_from: extra.counterOf };
    send(res, extra.status, {
      ...head,
      price_units: quote.amount,
      asset: "USDC",
      payee: `near:${quote.payee}`,
      network: quote.network,
      quote: text,
      quote_hash: hash,
      redeem_token: token,
      how_to_pay: `Pay sha256(quote) under a Probarion mandate with ref "402:${quote.id}" before the quote expires, then send the request again with the headers ${Object.values(PAYMENT_HEADERS).join(", ")}; ${PAYMENT_HEADERS.redeem} is redeem_token.`,
      ...(counterOf === null
        ? {
            how_to_counter: `Once per quote: POST ${COUNTER_PATH} with JSON {"quote_id", "amount" (USDC smallest units), "redeem_token", "reason"}. A counter the seller takes gets a new quote; one it does not take gets 409.`,
          }
        : {}),
    });
    return quote.id;
  }

  function paymentRequired(res: ServerResponse, reason: string | null): void {
    offer(res, pricing.listUnits, { status: 402, reason });
  }

  function refuseCounter(res: ServerResponse, status: number, reason: string): void {
    send(res, status, { error: "counter_refused", reason });
  }

  async function counter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, MAX_COUNTER_BYTES);
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        refuseCounter(res, 413, "too_large");
        return;
      }
      throw e;
    }
    const c = parseCounter(raw);
    if (typeof c === "string") {
      send(res, 400, { error: "bad_counter", reason: c });
      return;
    }
    // From here to the end nothing waits, so two counters of one quote cannot both be judged.
    const at = now().getTime();
    const entry = issued.get(c.quote_id);
    if (entry === undefined || entry.dropAt <= at) {
      refuseCounter(res, 404, "unknown_quote");
      return;
    }
    if (!sameToken(c.redeem_token, entry.token)) {
      refuseCounter(res, 403, "bad_redeem_token");
      return;
    }
    const closed = entry.redeemed
      ? "quote_already_used"
      : Date.parse(entry.quote.expiresAt) <= at
        ? "quote_expired"
        : entry.counterOf !== null || entry.counter !== null
          ? "already_countered"
          : null;
    if (closed !== null) {
      refuseCounter(res, 409, closed);
      return;
    }
    const verdict = judgeCounter(pricing, entry.quote.amount, c.amount);
    counters += 1;
    if (verdict !== "accept") {
      entry.counter = verdict;
      // The answer names the verdict and nothing about the floor.
      refuseCounter(res, 409, verdict);
      return;
    }
    entry.counter = offer(res, c.amount, { status: 200, counterOf: entry.quote.id });
  }

  /** Null when the spend paid this quote; otherwise why not. */
  async function problemWith(req: IncomingMessage, entry: Issued): Promise<string | null> {
    if (!sameToken(String(req.headers[PAYMENT_HEADERS.redeem] ?? ""), entry.token)) {
      return "bad_redeem_token";
    }
    const vault = String(req.headers[PAYMENT_HEADERS.vault] ?? "");
    const spendId = Number(req.headers[PAYMENT_HEADERS.spend]);
    if (!isNearAccountId(vault) || !Number.isSafeInteger(spendId) || spendId < 1) {
      return "bad_payment_headers";
    }
    if (!(await opts.reader.isProbarionVault(vault))) return "not_a_probarion_vault";
    const spend = await opts.reader.getSpend(vault, spendId);
    if (spend === null) return "spend_not_found";
    const paidHere =
      spend.status === "paid" &&
      spend.destination.type === "near" &&
      spend.destination.account_id === opts.payee &&
      spend.amount === entry.quote.amount &&
      spend.invoice_hash === entry.hash;
    if (!paidHere) return "spend_does_not_pay_this_quote";
    // The chain's time of the spend, not the time of this request: a quote paid in time stays redeemable
    // through the grace period.
    const spentAtMs = Number(BigInt(spend.created_at_ns) / 1_000_000n);
    return spentAtMs > Date.parse(entry.quote.expiresAt) ? "quote_expired" : null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://paywall.localhost");
    if (req.method === "POST" && url.pathname === COUNTER_PATH) {
      await counter(req, res);
      return;
    }
    if (req.method !== "GET" || url.pathname !== opts.path) {
      send(res, 404, { error: "not_found" });
      return;
    }
    const quoteId = req.headers[PAYMENT_HEADERS.quote];
    if (quoteId === undefined) {
      paymentRequired(res, null);
      return;
    }
    const entry = issued.get(String(quoteId));
    if (entry === undefined || entry.dropAt <= now().getTime()) {
      paymentRequired(res, entry === undefined ? "unknown_quote" : "quote_expired");
      return;
    }
    if (entry.redeemed) {
      paymentRequired(res, "quote_already_used");
      return;
    }
    const problem = await problemWith(req, entry);
    // Checked again after the reads above: two retries of one quote must not both get the data.
    if (problem !== null || entry.redeemed) {
      paymentRequired(res, problem ?? "quote_already_used");
      return;
    }
    // The answer is built before the quote is spent: if the data cannot be built or hashed, the quote stays
    // unredeemed and a later retry with the same payment can still get the data.
    let paid: { data: unknown; sha256: string };
    try {
      paid = paidData(opts.data(served + 1));
    } catch {
      send(res, 500, { error: "data_unavailable" });
      return;
    }
    entry.redeemed = true;
    served += 1;
    send(res, 200, {
      paid: { quote: entry.quote.id },
      data: paid.data,
      [DATA_SHA256_FIELD]: paid.sha256,
    });
  }

  return {
    handle: (req: IncomingMessage, res: ServerResponse) => {
      handle(req, res).catch(() => {
        // The reason stays in this process: an RPC error can carry the URL of a paid RPC plan.
        if (!res.headersSent) send(res, 502, { error: "payment_check_failed" });
      });
    },
    served: () => served,
    /** How many counters were judged, taken or not. */
    counters: () => counters,
    /** How many quotes are kept now (for tests). */
    quotes: () => issued.size,
  };
}

export interface RunningPaywall {
  /** The paid resource's URL. */
  url: string;
  close(): Promise<void>;
  served(): number;
  counters(): number;
  quotes(): number;
}

/** Starts the paywall on 127.0.0.1. Port 0 picks a free port. */
export async function startPaywall(opts: PaywallOptions, port = 0): Promise<RunningPaywall> {
  const paywall = createPaywall(opts);
  const server = createServer(paywall.handle);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}${opts.path}`,
    served: paywall.served,
    counters: paywall.counters,
    quotes: paywall.quotes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
