import { NETWORKS } from "@probarion/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { intentsDepositTx } from "@/lib/near/tx";
import { LIMITS } from "@/lib/ratelimit";
import { buildQuoteRequest, ONECLICK_BASE, type QuoteRequestBody } from "@/lib/topup/oneclick";
import { quietLogs } from "../../../../../test/fixtures/quiet-logs";
import {
  DEPOSIT_ADDRESS,
  fakeOneClick,
  JWT,
  jsonResponse,
  ONECLICK_PUBLIC,
  ORIGIN,
  OWNER,
  post,
  signedQuote,
  strangerKeys,
  VAULT,
  vaultConfig,
} from "../../../../../test/fixtures/topup";

const h = vi.hoisted(() => ({
  network: "mainnet" as "mainnet" | "testnet",
  jwt: "" as string | null,
  /** The role of the signed-in account in the vault, or null for no session. */
  role: "owner" as "owner" | "approver" | "viewer" | null,
  roles: [] as unknown[],
  config: null as unknown,
  configError: null as null | Error,
  limiterDown: false,
  buckets: new Map<string, number>(),
  limits: [] as { bucket: string; max: number; window: number }[],
  /** The public key the route trusts for 1Click's signature: this test's own, set before each test. */
  trustedKey: "",
}));

vi.mock("@/lib/auth/guard", () => ({
  memberForApi: async (vault: string, roles: unknown) => {
    h.roles.push(roles);
    if (h.role === null)
      return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
    if (!(roles as string[]).includes(h.role)) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }
    return {
      session: { accountId: "acme.near" },
      member: { vault_id: vault, role: h.role, network: h.network },
    };
  },
}));
vi.mock("@/lib/db/clients", () => ({
  serviceDb: () => ({
    rpc: async (fn: string, p: { bucket: string; max: number; window_seconds: number }) => {
      if (fn !== "rate_limit_take") throw new Error(`unexpected rpc ${fn}`);
      if (h.limiterDown) throw new Error("db down");
      h.limits.push({ bucket: p.bucket, max: p.max, window: p.window_seconds });
      const n = (h.buckets.get(p.bucket) ?? 0) + 1;
      h.buckets.set(p.bucket, n);
      return {
        allowed: n <= p.max,
        remaining: Math.max(0, p.max - n),
        reset_at: new Date(Date.now() + 30_000).toISOString(),
      };
    },
  }),
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ ONECLICK_JWT: h.jwt }),
}));
vi.mock("@/lib/near/server", async () => {
  const { NETWORKS: networks } = await import("@probarion/core");
  return {
    chainConsts: (network: "mainnet" | "testnet") => networks[network],
    getReader: () => ({
      getConfig: async () => {
        if (h.configError) throw h.configError;
        return h.config;
      },
    }),
  };
});
const REAL_ONECLICK_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
// The route runs the real SDK, except that the key it trusts is this test's, so a quote this test signs can pass.
vi.mock("@defuse-protocol/one-click-sdk-typescript", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@defuse-protocol/one-click-sdk-typescript")>();
  return {
    ...sdk,
    verifyQuoteSignature: (r: Parameters<typeof sdk.verifyQuoteSignature>[0], k?: string) =>
      // The route passes 1Click's pinned key: this test signs with its own, so that key is swapped for it here.
      sdk.verifyQuoteSignature(r, k === REAL_ONECLICK_KEY ? h.trustedKey : k),
  };
});

const { POST, maxDuration } = await import("./route");

const URL_ = `${ORIGIN}/api/topup/quote`;
const logs = quietLogs();
let oneclick: ReturnType<typeof fakeOneClick>;

const ask = (
  body: unknown = { vault: VAULT, amountUsdc: "20" },
  headers: Record<string, string> = {},
) => POST(post(URL_, body, headers));
const answer = async (r: Response) => (await r.json()) as Record<string, unknown>;
/** The request body 1Click first received. */
const firstRequest = (): QuoteRequestBody => {
  const call = oneclick.calls[0];
  if (!call) throw new Error("1Click was not asked");
  return call.body as QuoteRequestBody;
};

/** Makes the fake 1Click answer every quote request with a quote signed as `o` says. */
function quotes(
  o:
    | Parameters<typeof signedQuote>[1]
    | ((r: QuoteRequestBody) => Parameters<typeof signedQuote>[1]) = {},
) {
  oneclick.reply = (call) => {
    const request = call.body as QuoteRequestBody;
    return jsonResponse(signedQuote(request, typeof o === "function" ? o(request) : o), 201);
  };
}

beforeEach(() => {
  h.trustedKey = ONECLICK_PUBLIC;
  h.network = "mainnet";
  h.jwt = JWT;
  h.role = "owner";
  h.roles = [];
  h.config = vaultConfig();
  h.configError = null;
  h.limiterDown = false;
  h.buckets.clear();
  h.limits = [];
  oneclick = fakeOneClick();
  vi.stubGlobal("fetch", oneclick.fetch);
  quotes();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/topup/quote: who may ask", () => {
  it("refuses another origin and a request with no origin, before anything else", async () => {
    expect((await ask(undefined, { origin: "https://evil.example" })).status).toBe(403);
    const none = await POST(new Request(URL_, { method: "POST", body: "{}" }));
    expect(none.status).toBe(403);
    expect(await answer(none)).toEqual({ error: "bad_origin" });
    expect(h.roles).toEqual([]);
    expect(oneclick.calls).toEqual([]);
  });

  it("answers 400 to a body that is not the two strings, before any lookup", async () => {
    for (const body of [
      "not json",
      "null",
      "[]",
      {},
      { vault: VAULT },
      { amountUsdc: "20" },
      { vault: 5, amountUsdc: "20" },
      { vault: VAULT, amountUsdc: 20 },
    ]) {
      const r = await POST(post(URL_, body, {}, typeof body === "string"));
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await answer(r)).toEqual({ error: "invalid_input" });
    }
    expect(h.roles).toEqual([]);
  });

  it.each(["approver", "viewer"] as const)(
    "answers a %s with 403, and asks 1Click nothing",
    async (role) => {
      h.role = role;
      const r = await ask();
      expect(r.status).toBe(403);
      expect(h.roles).toEqual([["owner"]]);
      expect(oneclick.calls).toEqual([]);
      expect(h.limits).toEqual([]);
    },
  );

  it("answers 401 without a session", async () => {
    h.role = null;
    expect((await ask()).status).toBe(401);
    expect(oneclick.calls).toEqual([]);
  });

  it("refuses an owner whose chain owner is another account", async () => {
    h.config = { ...vaultConfig(), owner: "someone-else.near" };
    const r = await ask();
    expect(r.status).toBe(403);
    expect(await answer(r)).toEqual({ error: "forbidden" });
    expect(oneclick.calls).toEqual([]);
  });
});

describe("POST /api/topup/quote: what this deployment can do", () => {
  it("answers 409 mainnet_only on testnet, and never calls 1Click", async () => {
    h.network = "testnet";
    h.config = vaultConfig("testnet");
    const r = await ask();
    expect(r.status).toBe(409);
    expect(await answer(r)).toMatchObject({ error: "mainnet_only" });
    expect(oneclick.calls).toEqual([]);
  });

  it("answers 503 not_configured without a partner JWT, and never calls 1Click", async () => {
    h.jwt = null;
    const r = await ask();
    expect(r.status).toBe(503);
    expect(await answer(r)).toEqual({ error: "not_configured" });
    expect(oneclick.calls).toEqual([]);
  });

  it("answers 409 asset_not_allowed when the vault does not allow Base USDC", async () => {
    for (const allowed of [[], [NETWORKS.mainnet.allowedAssets.solana]]) {
      h.config = { ...vaultConfig(), allowed_assets: allowed };
      const r = await ask();
      expect(r.status).toBe(409);
      expect(await answer(r)).toEqual({ error: "asset_not_allowed" });
    }
    expect(oneclick.calls).toEqual([]);
  });

  it("answers 503 when the vault's config cannot be read or is not a config", async () => {
    h.configError = new Error("all RPC endpoints failed");
    const down = await ask();
    expect(down.status).toBe(503);
    expect(await answer(down)).toMatchObject({ error: "chain_unavailable" });
    h.configError = null;
    h.config = { owner: OWNER };
    expect((await ask()).status).toBe(503);
    h.config = null;
    expect((await ask()).status).toBe(503);
    expect(oneclick.calls).toEqual([]);
  });
});

describe("POST /api/topup/quote: the amount", () => {
  it.each([
    ["0.99", "Between 1 and 1000 USDC"],
    ["0", "Between 1 and 1000 USDC"],
    ["1000.01", "Between 1 and 1000 USDC"],
    ["99999999999", "Between 1 and 1000 USDC"],
    ["abc", "Use a plain decimal number such as 12.50"],
    ["-5", "Use a plain decimal number such as 12.50"],
    ["1e3", "Use a plain decimal number such as 12.50"],
    ["", "Use a plain decimal number such as 12.50"],
    ["1.1234567", "At most 6 decimal places"],
  ])("refuses %s with 400 invalid_amount", async (amountUsdc, detail) => {
    const r = await ask({ vault: VAULT, amountUsdc });
    expect(r.status).toBe(400);
    expect(await answer(r)).toEqual({ error: "invalid_amount", detail });
    expect(oneclick.calls).toEqual([]);
  });

  it.each([
    ["1", "1000000"],
    ["20", "20000000"],
    ["1000", "1000000000"],
  ])("asks 1Click for exactly %s USDC", async (amountUsdc, units) => {
    // a fair price at any size: a little over the ask, and a least input that is not above it
    quotes((r) => ({
      quote: { amountIn: String(BigInt(r.amount) + 100n), minAmountIn: r.amount },
    }));
    const r = await ask({ vault: VAULT, amountUsdc });
    expect(r.status).toBe(200);
    expect(firstRequest().amount).toBe(units);
  });
});

describe("POST /api/topup/quote: the request 1Click gets", () => {
  it("asks for Base USDC into the vault's Intents account, refunding the owner, with the partner JWT", async () => {
    await ask();
    expect(oneclick.calls).toHaveLength(1);
    const [call] = oneclick.calls;
    expect(call?.url).toBe(`${ONECLICK_BASE}/v0/quote`);
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe(`Bearer ${JWT}`);
    const sent = call?.body as QuoteRequestBody;
    const expected = buildQuoteRequest(
      {
        vault: VAULT,
        owner: OWNER,
        amountOut: "20000000",
        usdc: NETWORKS.mainnet.usdc,
        baseAsset: NETWORKS.mainnet.allowedAssets.base,
      },
      new Date(),
    );
    expect({ ...sent, deadline: "" }).toEqual({ ...expected, deadline: "" });
    expect(sent).toMatchObject({
      recipient: VAULT,
      recipientType: "INTENTS",
      refundTo: OWNER,
      originAsset: `nep141:${NETWORKS.mainnet.usdc}`,
      destinationAsset: `nep141:${NETWORKS.mainnet.allowedAssets.base}`,
      dry: false,
    });
    const minutes = (Date.parse(sent.deadline) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(29.9);
    expect(minutes).toBeLessThan(30.1);
  });

  it("takes the refund address from the chain, not from the request", async () => {
    h.config = { ...vaultConfig(), owner: "acme.near" };
    await POST(
      post(URL_, { vault: VAULT, amountUsdc: "20", owner: "evil.near", refundTo: "evil.near" }),
    );
    expect(firstRequest().refundTo).toBe("acme.near");
  });

  it("rate-limits per owner account, at the topupQuote limit", async () => {
    const [max, window] = LIMITS.topupQuote;
    for (let i = 0; i < max; i++) expect((await ask()).status).toBe(200);
    const r = await ask();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^[0-9]+$/);
    expect(await answer(r)).toMatchObject({ error: "rate_limited" });
    expect(h.limits.at(-1)).toEqual({ bucket: `topup:${OWNER}`, max, window });
    expect(oneclick.calls).toHaveLength(max);
  });

  it("answers 503 when the rate limiter cannot be reached, and asks 1Click nothing", async () => {
    h.limiterDown = true;
    const r = await ask();
    expect(r.status).toBe(503);
    expect(await answer(r)).toMatchObject({ error: "unavailable" });
    expect(oneclick.calls).toEqual([]);
  });

  it("allows 30 s for 1Click and the chain", () => {
    expect(maxDuration).toBe(30);
  });
});

describe("POST /api/topup/quote: a quote that passes", () => {
  it("returns the verified quote and the deposit transaction built from it", async () => {
    const r = await ask();
    expect(r.status).toBe(200);
    const body = await answer(r);
    expect(body.quote).toEqual({
      depositAddress: DEPOSIT_ADDRESS,
      depositMemo: null,
      amountIn: "20208197",
      amountInFormatted: "20.208197",
      amountOut: "20000000",
      amountOutFormatted: "20",
      deadline: expect.any(String),
      timeEstimate: 12,
      correlationId: "corr-1",
      signature: expect.stringMatching(/^ed25519:/),
      timestamp: expect.any(String),
      recipient: VAULT,
      refundTo: OWNER,
    });
    expect(body.tx).toEqual(
      intentsDepositTx(NETWORKS.mainnet.usdc, DEPOSIT_ADDRESS, "20208197", null),
    );
  });

  it("builds the transaction from the verified quote: its address, its amount and its memo", async () => {
    quotes({
      quote: { depositAddress: "cd".repeat(32), amountIn: "20300000", depositMemo: "memo-7" },
    });
    const body = await answer(await ask());
    expect(body.quote).toMatchObject({
      depositAddress: "cd".repeat(32),
      amountIn: "20300000",
      depositMemo: "memo-7",
    });
    expect(body.tx).toEqual(
      intentsDepositTx(NETWORKS.mainnet.usdc, "cd".repeat(32), "20300000", "memo-7"),
    );
    const tx = body.tx as ReturnType<typeof intentsDepositTx>;
    expect(tx.receiverId).toBe(NETWORKS.mainnet.usdc);
    expect(tx.actions.map((a) => a.params.methodName)).toEqual(["storage_deposit", "ft_transfer"]);
    expect(tx.actions[0]?.params.args).toEqual({
      account_id: "cd".repeat(32),
      registration_only: true,
    });
    expect(tx.actions[1]?.params.args).toEqual({
      receiver_id: "cd".repeat(32),
      amount: "20300000",
      memo: "memo-7",
    });
    expect(tx.actions[1]?.params.deposit).toBe("1");
  });

  it("shows amounts the server formatted from the units, not the text 1Click sent", async () => {
    quotes({ quote: { amountInFormatted: "0.01", amountOutFormatted: "999" } });
    const body = await answer(await ask());
    expect(body.quote).toMatchObject({ amountInFormatted: "20.208197", amountOutFormatted: "20" });
  });

  it("sends no JWT or key to the browser", async () => {
    const text = await (await ask()).text();
    expect(text).not.toContain(JWT);
    expect(text).not.toContain(ONECLICK_PUBLIC);
  });
});

describe("POST /api/topup/quote: a quote that does not pass", () => {
  const refused = async (reason: string) => {
    const r = await ask();
    expect(r.status).toBe(502);
    const body = await answer(r);
    expect(body).toEqual({ error: "quote_rejected", detail: reason });
    expect(body).not.toHaveProperty("tx");
    expect(body).not.toHaveProperty("quote");
    expect(logs.lines.some((l) => l.includes("topup.quote_rejected") && l.includes(reason))).toBe(
      true,
    );
  };

  it("refuses a quote signed by a key nobody trusts: bad_signature", async () => {
    quotes({ signWith: strangerKeys });
    await refused("bad_signature");
  });

  it("refuses a quote changed after it was signed: bad_signature", async () => {
    quotes({
      tamper: (resp) => {
        resp.quoteRequest = { ...(resp.quoteRequest as object), recipient: "evil.near" };
      },
    });
    await refused("bad_signature");
  });

  it("refuses a quote that moved the deposit address after it was signed: bad_signature", async () => {
    quotes({
      tamper: (resp) => {
        resp.quote = { ...(resp.quote as object), depositAddress: "ee".repeat(32) };
      },
    });
    await refused("bad_signature");
  });

  it("refuses a genuinely signed quote for another recipient: mismatch:recipient", async () => {
    quotes({ request: { recipient: "evil.near" } });
    await refused("mismatch:recipient");
  });

  it("refuses a genuinely signed quote that refunds another account: mismatch:refundTo", async () => {
    quotes({ request: { refundTo: "evil.near" } });
    await refused("mismatch:refundTo");
  });

  it("refuses a quote for another amount: mismatch:amount", async () => {
    quotes((r) => ({ request: { amount: String(BigInt(r.amount) + 1n) } }));
    await refused("mismatch:amount");
  });

  it("refuses an overpriced quote: price_too_high", async () => {
    quotes({ quote: { amountIn: "25000000" } });
    await refused("price_too_high");
  });

  it("refuses a quote that delivers less than asked: amount_out_too_low", async () => {
    quotes({ quote: { amountOut: "19999999" } });
    await refused("amount_out_too_low");
  });

  it("refuses a deposit address that is not a NEAR account: bad_deposit_address", async () => {
    quotes({ quote: { depositAddress: "Not An Account" } });
    await refused("bad_deposit_address");
  });

  it("refuses a quote whose deposit address closes within 5 minutes: deadline_too_close", async () => {
    quotes({ quote: { deadline: new Date(Date.now() + 4 * 60_000).toISOString() } });
    await refused("deadline_too_close");
  });

  it("refuses a signed request that carries routing we did not ask for: mismatch:virtualChainRecipient", async () => {
    quotes({ request: { virtualChainRecipient: `0x${"22".repeat(20)}` } as never });
    await refused("mismatch:virtualChainRecipient");
  });

  it("refuses a signed request with other slippage than we sent: mismatch:slippageTolerance", async () => {
    quotes({ request: { slippageTolerance: 5000 } });
    await refused("mismatch:slippageTolerance");
  });

  it("refuses a deposit address that is the vault itself: bad_deposit_address", async () => {
    quotes({ quote: { depositAddress: VAULT } });
    await refused("bad_deposit_address");
  });

  it("refuses a deposit address that stays open past the deadline asked for: deadline_after_request", async () => {
    quotes((r) => ({ quote: { deadline: new Date(Date.parse(r.deadline) + 1000).toISOString() } }));
    await refused("deadline_after_request");
  });

  it("refuses an amount that is not digits: malformed", async () => {
    quotes({ quote: { amountIn: "twenty" } });
    await refused("malformed");
  });

  it("refuses an answer that is not a quote: malformed", async () => {
    oneclick.reply = () => jsonResponse({ hello: "world" }, 201);
    await refused("malformed");
    oneclick.reply = () => new Response("not json", { status: 201 });
    await refused("malformed");
  });
});

describe("POST /api/topup/quote: 1Click is not available", () => {
  it("answers 502 quote_unavailable with a fixed sentence for the status when it refuses, never its own text", async () => {
    oneclick.reply = () => jsonResponse({ message: "amount too small Bearer secret-1" }, 400);
    const r = await ask();
    expect(r.status).toBe(502);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({
      error: "quote_unavailable",
      detail: "1Click quote failed (400): the request was not accepted.",
    });
    expect(text).not.toContain("too small");
    expect(
      logs.lines.some((l) => l.includes("topup.oneclick_refused") && l.includes("too small")),
    ).toBe(true);
  });

  it("answers 502 quote_unavailable when 1Click cannot be reached, and says nothing of why", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError(`fetch failed (Bearer ${JWT})`);
    });
    const r = await ask();
    expect(r.status).toBe(502);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({
      error: "quote_unavailable",
      detail: "1Click could not be reached",
    });
    expect(text).not.toContain(JWT);
  });
});
