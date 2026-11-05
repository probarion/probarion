import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ONECLICK_BASE } from "@/lib/topup/oneclick";
import {
  DEPOSIT_ADDRESS,
  fakeOneClick,
  JWT,
  jsonResponse,
  ORIGIN,
  VAULT,
} from "../../../../../test/fixtures/topup";

const h = vi.hoisted(() => ({
  network: "mainnet" as "mainnet" | "testnet",
  jwt: "" as string | null,
  role: "owner" as "owner" | "approver" | "viewer" | null,
  roles: [] as unknown[],
  vaults: [] as string[],
}));

vi.mock("@/lib/auth/guard", () => ({
  memberForApi: async (vault: string, roles: unknown) => {
    h.roles.push(roles);
    h.vaults.push(vault);
    if (h.role === null)
      return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
    if (!(roles as string[]).includes(h.role)) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }
    return { session: { accountId: "acme.near" }, member: { vault_id: vault, role: h.role } };
  },
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ NEAR_NETWORK: h.network, ONECLICK_JWT: h.jwt }),
}));

const { GET } = await import("./route");

let oneclick: ReturnType<typeof fakeOneClick>;
const url = (vault: string | null = VAULT, depositAddress: string | null = DEPOSIT_ADDRESS) => {
  const u = new URL(`${ORIGIN}/api/topup/status`);
  if (vault !== null) u.searchParams.set("vault", vault);
  if (depositAddress !== null) u.searchParams.set("depositAddress", depositAddress);
  return u.toString();
};
const get = (u = url()) => GET(new Request(u));
const answer = async (r: Response) => (await r.json()) as Record<string, unknown>;

beforeEach(() => {
  h.network = "mainnet";
  h.jwt = JWT;
  h.role = "owner";
  h.roles = [];
  h.vaults = [];
  oneclick = fakeOneClick();
  oneclick.reply = () => jsonResponse({ status: "PROCESSING", updatedAt: "2026-11-08T10:01:00Z" });
  vi.stubGlobal("fetch", oneclick.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/topup/status", () => {
  it("answers 400 when the vault or the deposit address is missing or is not a NEAR account", async () => {
    const bad: [string | null, string | null][] = [
      [null, DEPOSIT_ADDRESS],
      ["", DEPOSIT_ADDRESS],
      ["Not A Vault", DEPOSIT_ADDRESS],
      ["a", DEPOSIT_ADDRESS],
      [`${VAULT}/../x`, DEPOSIT_ADDRESS],
      [VAULT, null],
      [VAULT, ""],
      [VAULT, "Not An Account"],
      [VAULT, "ab cd"],
      [VAULT, `${DEPOSIT_ADDRESS}&x=1`],
    ];
    for (const [vault, depositAddress] of bad) {
      const r = await get(url(vault, depositAddress));
      expect(r.status, `${vault} ${depositAddress}`).toBe(400);
      expect(await answer(r)).toEqual({ error: "invalid_input" });
    }
    expect(h.roles).toEqual([]);
    expect(oneclick.calls).toEqual([]);
  });

  it.each(["approver", "viewer"] as const)(
    "answers a %s with 403, and asks 1Click nothing",
    async (role) => {
      h.role = role;
      expect((await get()).status).toBe(403);
      expect(h.roles).toEqual([["owner"]]);
      expect(oneclick.calls).toEqual([]);
    },
  );

  it("answers 401 without a session", async () => {
    h.role = null;
    expect((await get()).status).toBe(401);
    expect(oneclick.calls).toEqual([]);
  });

  it("answers 409 mainnet_only on testnet", async () => {
    h.network = "testnet";
    const r = await get();
    expect(r.status).toBe(409);
    expect(await answer(r)).toMatchObject({ error: "mainnet_only" });
    expect(oneclick.calls).toEqual([]);
  });

  it("answers 503 not_configured without a partner JWT", async () => {
    h.jwt = null;
    const r = await get();
    expect(r.status).toBe(503);
    expect(await answer(r)).toEqual({ error: "not_configured" });
    expect(oneclick.calls).toEqual([]);
  });

  it("checks the owner role for the vault asked about, then reads the deposit's state", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(await answer(r)).toEqual({ status: "PROCESSING", updatedAt: "2026-11-08T10:01:00Z" });
    expect(h.vaults).toEqual([VAULT]);
    expect(h.roles).toEqual([["owner"]]);
    const [call] = oneclick.calls;
    expect(call?.url).toBe(`${ONECLICK_BASE}/v0/status?depositAddress=${DEPOSIT_ADDRESS}`);
    expect(call?.headers.authorization).toBe(`Bearer ${JWT}`);
  });

  it("passes on the state and its time only, nothing else 1Click sent", async () => {
    oneclick.reply = () =>
      jsonResponse({
        status: "SUCCESS",
        updatedAt: "2026-11-08T10:02:00Z",
        quoteResponse: { quoteRequest: { recipient: "x.near" } },
        swapDetails: { nearTxHashes: ["h"] },
      });
    const text = await (await get()).text();
    expect(JSON.parse(text)).toEqual({ status: "SUCCESS", updatedAt: "2026-11-08T10:02:00Z" });
    expect(text).not.toContain(JWT);
  });

  it("answers 502 status_unavailable when 1Click refuses, cannot be reached or says something unreadable", async () => {
    oneclick.reply = () => jsonResponse({ message: "not found" }, 404);
    const refused = await get();
    expect(refused.status).toBe(502);
    expect(await answer(refused)).toEqual({
      error: "status_unavailable",
      detail: "1Click status failed (404)",
    });
    oneclick.reply = () => jsonResponse({ status: "<script>" });
    const odd = await get();
    expect(odd.status).toBe(502);
    expect(await answer(odd)).toMatchObject({ error: "status_unavailable" });
    vi.stubGlobal("fetch", async () => {
      throw new Error(`down (${JWT})`);
    });
    const down = await get();
    expect(down.status).toBe(502);
    const text = await down.text();
    expect(JSON.parse(text)).toEqual({
      error: "status_unavailable",
      detail: "1Click could not be reached",
    });
    expect(text).not.toContain(JWT);
  });
});
