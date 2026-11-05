import { quoteHash } from "@defuse-protocol/one-click-sdk-typescript";
import { NETWORKS, type VaultConfig } from "@probarion/core";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { QuoteRequestBody } from "@/lib/topup/oneclick";

/**
 * Shared by the three top-up route tests: a 1Click that signs with a key of the test's own, and a
 * vault config. The routes' own code runs for real (checkQuote, the amount rules, the transaction builder).
 */

export const ORIGIN = "http://localhost:3000";
export const VAULT = "acme.vaults.probarion.near";
export const OWNER = "acme.near";
export const JWT = "jwt-test-secret";

/** The key the 1Click double signs with. The route's default key is swapped for its public half. */
export const ONECLICK_KEYS = nacl.sign.keyPair();
export const ONECLICK_PUBLIC = `ed25519:${bs58.encode(ONECLICK_KEYS.publicKey)}`;

/** A key nobody trusts: a quote signed with it must be refused. */
const STRANGER = nacl.sign.keyPair();

export const DEPOSIT_ADDRESS = "ab".repeat(32);

export function vaultConfig(network: "mainnet" | "testnet" = "mainnet"): VaultConfig {
  const n = NETWORKS[network];
  return {
    owner: OWNER,
    approvers: [],
    usdc: n.usdc,
    intents: n.intents,
    allowed_assets: [n.allowedAssets.base],
    daily_backstop: "500000000",
    held_ttl_ns: "259200000000000",
    frozen: false,
    factory: n.factory,
    version: "0.1.0",
    ledger_key: null,
  };
}

/** What 1Click answers to `request`: a live quote signed the way the SDK hashes it. */
export function signedQuote(
  request: QuoteRequestBody,
  o: {
    quote?: Record<string, unknown>;
    request?: Partial<QuoteRequestBody>;
    signWith?: nacl.SignKeyPair;
    tamper?: (resp: Record<string, unknown>) => void;
  } = {},
): Record<string, unknown> {
  const now = new Date();
  const signedRequest = { ...request, ...o.request };
  const quote = {
    depositAddress: DEPOSIT_ADDRESS,
    amountIn: "20208197",
    amountInFormatted: "20.208197",
    amountInUsd: "20.2082",
    minAmountIn: "20006115",
    amountOut: request.amount,
    amountOutFormatted: "20",
    amountOutUsd: "20",
    minAmountOut: request.amount,
    deadline: new Date(now.getTime() + 30 * 60_000).toISOString(),
    timeWhenInactive: new Date(now.getTime() + 60 * 60_000).toISOString(),
    timeEstimate: 12,
    ...o.quote,
  };
  const resp: Record<string, unknown> = {
    correlationId: "corr-1",
    timestamp: now.toISOString(),
    signature: "",
    quoteRequest: signedRequest,
    quote,
  };
  const message = new TextEncoder().encode(quoteHash(resp as Parameters<typeof quoteHash>[0]));
  const keys = o.signWith ?? ONECLICK_KEYS;
  resp.signature = `ed25519:${bs58.encode(nacl.sign.detached(message, keys.secretKey))}`;
  o.tamper?.(resp);
  return resp;
}

export const strangerKeys = STRANGER;

/** A JSON POST as a browser sends it from the console. */
export function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  raw = false,
): Request {
  return new Request(url, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: raw ? String(body) : JSON.stringify(body),
  });
}

/** `fetch`, replaced: every call is recorded, and `reply` decides the answer. */
export interface FakeOneClick {
  calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[];
  reply: (call: FakeOneClick["calls"][number]) => Response | Promise<Response>;
}

export function fakeOneClick(): FakeOneClick & { fetch: typeof fetch } {
  const box: FakeOneClick = {
    calls: [],
    reply: () => new Response("{}", { status: 200 }),
  };
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const text = typeof init?.body === "string" ? init.body : null;
    const call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: text === null ? null : (JSON.parse(text) as unknown),
    };
    box.calls.push(call);
    return box.reply(call);
  }) as typeof fetch;
  return Object.assign(box, { fetch: fetchImpl });
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
