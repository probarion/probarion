import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@/lib/ratelimit";
import { ONECLICK_BASE } from "@/lib/topup/oneclick";
import { quietLogs } from "../../../../../test/fixtures/quiet-logs";
import {
  DEPOSIT_ADDRESS,
  fakeOneClick,
  JWT,
  jsonResponse,
  ORIGIN,
  OWNER,
  post,
  VAULT,
} from "../../../../../test/fixtures/topup";

const h = vi.hoisted(() => ({
  network: "mainnet" as "mainnet" | "testnet",
  jwt: "" as string | null,
  role: "owner" as "owner" | "approver" | "viewer" | null,
  roles: [] as unknown[],
  limiterDown: false,
  buckets: new Map<string, number>(),
  limits: [] as { bucket: string; max: number; window: number }[],
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

const { POST } = await import("./route");

const URL_ = `${ORIGIN}/api/topup/submit`;
const TX_HASH = bs58.encode(crypto.getRandomValues(new Uint8Array(32)));
const GOOD = { vault: VAULT, txHash: TX_HASH, depositAddress: DEPOSIT_ADDRESS };
const logs = quietLogs();
let oneclick: ReturnType<typeof fakeOneClick>;

const send = (body: unknown = GOOD, headers: Record<string, string> = {}, raw = false) =>
  POST(post(URL_, body, headers, raw));
const answer = async (r: Response) => (await r.json()) as Record<string, unknown>;

beforeEach(() => {
  h.network = "mainnet";
  h.jwt = JWT;
  h.role = "owner";
  h.roles = [];
  h.limiterDown = false;
  h.buckets.clear();
  h.limits = [];
  oneclick = fakeOneClick();
  oneclick.reply = () => jsonResponse({ status: "KNOWN_DEPOSIT_TX" });
  vi.stubGlobal("fetch", oneclick.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/topup/submit", () => {
  it("refuses another origin and a request with no origin, before anything else", async () => {
    expect((await send(GOOD, { origin: "https://evil.example" })).status).toBe(403);
    expect((await POST(new Request(URL_, { method: "POST", body: "{}" }))).status).toBe(403);
    expect(h.roles).toEqual([]);
    expect(oneclick.calls).toEqual([]);
  });

  it.each(["approver", "viewer"] as const)(
    "answers a %s with 403, and tells 1Click nothing",
    async (role) => {
      h.role = role;
      expect((await send()).status).toBe(403);
      expect(h.roles).toEqual([["owner"]]);
      expect(oneclick.calls).toEqual([]);
    },
  );

  it("answers 401 without a session", async () => {
    h.role = null;
    expect((await send()).status).toBe(401);
    expect(oneclick.calls).toEqual([]);
  });

  it("answers 400 to a body that is not three strings, and to a transaction hash that is not one", async () => {
    const hashes = [
      "",
      "abc",
      "z".repeat(44), // base58, 44 characters, but 33 bytes
      // 45 characters, one over the longest hash text. Not `${TX_HASH}x`: TX_HASH is random, and a 43-character hash
      // of a small enough value still decodes to 32 bytes with one more character (CI run 42100685842).
      TX_HASH.padEnd(45, "x"),
      `0${TX_HASH.slice(1)}`,
      `${TX_HASH}\n`,
      5,
      null,
      [TX_HASH],
    ];
    const bodies: unknown[] = [
      "not json",
      "null",
      "[]",
      {},
      { vault: VAULT },
      { ...GOOD, vault: 5 },
      { ...GOOD, depositAddress: "Not An Account" },
      { ...GOOD, depositAddress: 5 },
      { ...GOOD, depositAddress: "" },
      ...hashes.map((txHash) => ({ ...GOOD, txHash })),
    ];
    for (const body of bodies) {
      const r = await send(body, {}, typeof body === "string");
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await answer(r)).toEqual({ error: "invalid_input" });
    }
    expect(h.roles).toEqual([]);
    expect(oneclick.calls).toEqual([]);
  });

  it("rate-limits per owner account, at the topupSubmit limit, after the other checks", async () => {
    const [max, window] = LIMITS.topupSubmit;
    for (let i = 0; i < max; i++) expect((await send()).status).toBe(200);
    const r = await send();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^[0-9]+$/);
    expect(await answer(r)).toMatchObject({ error: "rate_limited" });
    expect(h.limits.at(-1)).toEqual({ bucket: "topup-submit:acme.near", max, window });
    expect(oneclick.calls).toHaveLength(max);
    // A bad request is refused before it costs a token.
    h.buckets.clear();
    expect((await send({})).status).toBe(400);
    expect(h.buckets.size).toBe(0);
  });

  it("answers 503 when the rate limiter cannot be reached, and tells 1Click nothing", async () => {
    h.limiterDown = true;
    const r = await send();
    expect(r.status).toBe(503);
    expect(await answer(r)).toMatchObject({ error: "unavailable" });
    expect(oneclick.calls).toEqual([]);
  });

  it("answers 409 mainnet_only on testnet, and tells 1Click nothing", async () => {
    h.network = "testnet";
    const r = await send();
    expect(r.status).toBe(409);
    expect(await answer(r)).toMatchObject({ error: "mainnet_only" });
    expect(oneclick.calls).toEqual([]);
  });

  it("answers 503 not_configured without a partner JWT", async () => {
    h.jwt = null;
    const r = await send();
    expect(r.status).toBe(503);
    expect(await answer(r)).toEqual({ error: "not_configured" });
    expect(oneclick.calls).toEqual([]);
  });

  it("tells 1Click the deposit, as the signed-in owner's own account", async () => {
    const r = await send({ ...GOOD, nearSenderAccount: "evil.near" });
    expect(r.status).toBe(200);
    expect(await answer(r)).toEqual({ ok: true });
    expect(oneclick.calls).toHaveLength(1);
    const [call] = oneclick.calls;
    expect(call?.url).toBe(`${ONECLICK_BASE}/v0/deposit/submit`);
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe(`Bearer ${JWT}`);
    expect(call?.body).toEqual({
      txHash: TX_HASH,
      depositAddress: DEPOSIT_ADDRESS,
      nearSenderAccount: OWNER,
    });
  });

  it("still answers ok when 1Click does not take the hint: it finds the deposit by itself", async () => {
    oneclick.reply = () => jsonResponse({ message: "unknown deposit address" }, 404);
    const refused = await send();
    expect(refused.status).toBe(200);
    expect(await answer(refused)).toEqual({ ok: true });
    vi.stubGlobal("fetch", async () => {
      throw new Error(`down (${JWT})`);
    });
    const down = await send();
    expect(down.status).toBe(200);
    expect(logs.lines.some((l) => l.includes("topup.submit_failed"))).toBe(true);
    expect(logs.lines.join("\n")).not.toContain(JWT);
  });
});
