// A tiny pay-per-call endpoint. Without a payment it answers 402 with a quote: a price, a payee and the text
// to pay. With one, it reads the spend from the payer's Probarion vault on NEAR and serves the data only if
// that spend paid this quote, in full, to this seller. Each quote serves one call.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isNearAccountId, NETWORKS, type SpendView } from "@probarion/core";
import { FactoryClient, type RpcClient, VaultClient } from "@probarion/sdk";
import { type Quote, quoteHash, quoteText } from "./quote.js";

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
  /** The price of one call, in USDC smallest units. */
  priceUnits: string;
  /** The one path this endpoint serves, e.g. "/forecast". */
  path: string;
  /** The body of a paid call. */
  data: (call: number) => unknown;
  reader: PaymentReader;
  quoteTtlMs?: number;
  now?: () => Date;
  newQuoteId?: () => string;
}

interface Issued {
  quote: Quote;
  text: string;
  hash: string;
  redeemed: boolean;
}

export const PAYMENT_HEADERS = {
  quote: "x-probarion-quote",
  vault: "x-probarion-vault",
  spend: "x-probarion-spend",
} as const;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

export function createPaywall(opts: PaywallOptions) {
  const now = opts.now ?? (() => new Date());
  const ttl = opts.quoteTtlMs ?? 5 * 60_000;
  const newId = opts.newQuoteId ?? (() => `q_${randomBytes(12).toString("hex")}`);
  const issued = new Map<string, Issued>();
  let served = 0;

  function paymentRequired(res: ServerResponse, reason: string | null): void {
    const at = now().toISOString();
    for (const [id, e] of issued) if (e.quote.expiresAt < at) issued.delete(id);
    const quote: Quote = {
      id: newId(),
      resource: `GET ${opts.path}`,
      payee: opts.payee,
      amount: opts.priceUnits,
      network: opts.network,
      expiresAt: new Date(now().getTime() + ttl).toISOString(),
    };
    const text = quoteText(quote);
    const hash = quoteHash(text);
    issued.set(quote.id, { quote, text, hash, redeemed: false });
    send(res, 402, {
      error: "payment_required",
      ...(reason === null ? {} : { reason }),
      price_units: quote.amount,
      asset: "USDC",
      payee: `near:${quote.payee}`,
      network: quote.network,
      quote: text,
      quote_hash: hash,
      how_to_pay: `Pay sha256(quote) under a Probarion mandate with ref "402:${quote.id}", then send the request again with the headers ${Object.values(PAYMENT_HEADERS).join(", ")}.`,
    });
  }

  /** Null when the spend paid this quote; otherwise why not. */
  async function problemWith(req: IncomingMessage, entry: Issued): Promise<string | null> {
    const vault = String(req.headers[PAYMENT_HEADERS.vault] ?? "");
    const spendId = Number(req.headers[PAYMENT_HEADERS.spend]);
    if (!isNearAccountId(vault) || !Number.isSafeInteger(spendId) || spendId < 1) {
      return "bad_payment_headers";
    }
    if (now().toISOString() > entry.quote.expiresAt) return "quote_expired";
    if (!(await opts.reader.isProbarionVault(vault))) return "not_a_probarion_vault";
    const spend = await opts.reader.getSpend(vault, spendId);
    if (spend === null) return "spend_not_found";
    const paidHere =
      spend.status === "paid" &&
      spend.destination.type === "near" &&
      spend.destination.account_id === opts.payee &&
      spend.amount === entry.quote.amount &&
      spend.invoice_hash === entry.hash;
    return paidHere ? null : "spend_does_not_pay_this_quote";
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://paywall.localhost");
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
    if (entry === undefined) {
      paymentRequired(res, "unknown_quote");
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
    entry.redeemed = true;
    served += 1;
    send(res, 200, { paid: { quote: entry.quote.id }, data: opts.data(served) });
  }

  return {
    handle: (req: IncomingMessage, res: ServerResponse) => {
      handle(req, res).catch((e: unknown) => {
        send(res, 502, {
          error: "payment_check_failed",
          detail: e instanceof Error ? e.message.slice(0, 200) : "unknown",
        });
      });
    },
    served: () => served,
  };
}

/** Starts the paywall on 127.0.0.1. Port 0 picks a free port. */
export async function startPaywall(
  opts: PaywallOptions,
  port = 0,
): Promise<{ url: string; close(): Promise<void>; served(): number }> {
  const paywall = createPaywall(opts);
  const server = createServer(paywall.handle);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}${opts.path}`,
    served: paywall.served,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
