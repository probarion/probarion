import type { PGlite } from "@electric-sql/pglite";
import type { MandateView, SpendView } from "@probarion/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/port";
import { createPairCode, listTokens } from "@/lib/ext/store";
import { codeHash } from "@/lib/ext/token";
import { freshDb, seedTenant } from "../../../../test/db/harness";
import { pgliteDb } from "../../../../test/db/pglite-db";
import { MAINNET_HOST, TESTNET_HOST } from "../../../../test/fixtures/networks";
import { quietLogs } from "../../../../test/fixtures/quiet-logs";

const h = vi.hoisted(() => ({
  db: null as unknown as Db,
  host: null as string | null,
  mandates: [] as MandateView[],
  spends: [] as SpendView[],
  dbDown: false,
  tag: vi.fn(),
}));
vi.mock("@/lib/observe", () => ({ tagRequest: h.tag }));
vi.mock("@/lib/env", async () => {
  const { networkPart } = await import("../../../../test/fixtures/networks");
  return { getEnv: () => networkPart({ defaultNetwork: "testnet", both: true }) };
});
vi.mock("@/lib/db/clients", () => ({
  serviceDb: () => {
    if (h.dbDown) throw new Error("db down");
    return h.db;
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "host" ? h.host : null) }),
  // The extension's routes never read a cookie: one that tried would fail every test here.
  cookies: async () => {
    throw new Error("the extension's routes never read cookies");
  },
}));
vi.mock("@/lib/near/server", () => ({
  getReader: () => ({
    listMandates: async (_v: string, from: number, limit: number) =>
      h.mandates.slice(from, from + limit),
    listSpends: async (_v: string, from: number, limit: number) =>
      h.spends.slice(from, from + limit),
  }),
  // The invoices route reads check_spend through getRpc; no request here gets that far.
  getRpc: () => {
    throw new Error("check_spend is not read in this test");
  },
}));

const { POST: pair } = await import("./pair/route");
const { GET: inbox } = await import("./inbox/route");
const { POST: revoke } = await import("./revoke/route");
const { POST: invoices } = await import("./invoices/route");

const OWNER = "owner.testnet";
const VAULT = "acme.vaults.probarion.testnet";
const ns = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

const mandate = (over: Partial<MandateView>): MandateView => ({
  id: 1,
  payee: { type: "near", account_id: "vendor.testnet" },
  purpose_hash: "a".repeat(64),
  max_per_payment: "100000000",
  max_total: "1000000000",
  spent: "0",
  reserved: "0",
  max_uses: 10,
  uses: 0,
  expires_at_ns: ns("2030-01-01T00:00:00Z"),
  approval_above: "50000000",
  agent_pk: "ed25519:agent",
  label: "Hosting",
  status: "active",
  created_at_ns: ns("2026-11-01T00:00:00Z"),
  ...over,
});
const spend = (over: Partial<SpendView>): SpendView => ({
  id: 7,
  mandate_id: 1,
  amount: "60000000",
  invoice_hash: "b".repeat(64),
  ref: "inv-1",
  decision_hash: "c".repeat(64),
  agent_pk: "ed25519:agent",
  destination: { type: "near", account_id: "vendor.testnet" },
  status: "held",
  created_at_ns: ns("2026-11-07T00:00:00Z"),
  held_until_ns: ns("2030-01-01T00:00:00Z"),
  memo: null,
  ...over,
});

function at(host: string, path: string, init: RequestInit = {}) {
  h.host = host;
  return new Request(`https://${host}${path}`, init);
}
function pairRequest(code: unknown, host = TESTNET_HOST, ip = "203.0.113.7") {
  const body = JSON.stringify({ code, label: "Chrome on Windows" });
  return at(host, "/api/ext/pair", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "x-forwarded-for": ip,
    },
    body,
  });
}
const withToken = (token: string, host = TESTNET_HOST) =>
  at(host, "/api/ext/inbox", { headers: { authorization: `Bearer ${token}` } });
/** A POST to the invoices route with no body, so no Content-Length, with the token if one is given. */
const invoicePost = (token?: string) =>
  at(TESTNET_HOST, "/api/ext/invoices", {
    method: "POST",
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });

describe("the extension's API", () => {
  const logs = quietLogs();
  let pg: PGlite;

  beforeAll(async () => {
    pg = await freshDb();
    h.db = pgliteDb(pg);
    await seedTenant(pg, { vault: VAULT, owner: OWNER, network: "testnet" });
    await seedTenant(pg, { vault: "acme.vaults.probarion.near", owner: OWNER, network: "mainnet" });
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await pg.exec(
      "delete from public.extension_tokens; delete from public.extension_pair_codes; delete from public.rate_limits;",
    );
    h.mandates = [];
    h.spends = [];
  });

  async function connected(code = "K7QM4XRA") {
    await createPairCode(h.db, OWNER, "testnet", codeHash(code));
    const r = await pair(pairRequest(`${code.slice(0, 4)}-${code.slice(4)}`));
    expect(r.status).toBe(200);
    return (await r.json()) as {
      token: string;
      account: string;
      network: string;
      expires_at: string;
    };
  }

  it("exchanges a code once for a token that reads the inbox", async () => {
    const c = await connected();
    expect(c).toMatchObject({ account: OWNER, network: "testnet" });
    expect(c.token).toMatch(/^pbx_[A-Za-z0-9_-]{43}$/);
    const r = await inbox(withToken(c.token));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      network: "testnet",
      account: OWNER,
      counts: { awaiting: 0, held: 0 },
    });
    expect(body.vaults.map((v: { vault: string; role: string }) => [v.vault, v.role])).toEqual([
      [VAULT, "owner"],
    ]);
    const again = await pair(pairRequest("K7QM-4XRA"));
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: "bad_code" });
  });

  it("refuses a malformed code, or a body without its length, before it reads anything", async () => {
    const r = await pair(pairRequest("nope"));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "bad_code_format" });
    // A well-formed code that exists: only the length can refuse these, and the code is not used up.
    await createPairCode(h.db, OWNER, "testnet", codeHash("K7QM4XRA"));
    const body = JSON.stringify({ code: "K7QM-4XRA", label: "Chrome on Windows" });
    const sized = (length: string | null) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (length !== null) headers["content-length"] = length;
      return at(TESTNET_HOST, "/api/ext/pair", { method: "POST", headers, body });
    };
    const noLength = sized(null);
    expect(noLength.headers.get("content-length")).toBeNull();
    for (const [name, req] of [
      ["no length", noLength],
      ["1025", sized("1025")],
      ["2048", sized("2048")],
      ["abc", sized("abc")],
    ] as const) {
      const refused = await pair(req);
      expect(refused.status, name).toBe(400);
      expect(await refused.json(), name).toMatchObject({ error: "invalid_input" });
    }
    expect((await pair(sized(String(Buffer.byteLength(body))))).status).toBe(200);
  });

  it("pairs a browser whose label holds a surrogate that is not part of a pair, without it", async () => {
    await createPairCode(h.db, OWNER, "testnet", codeHash("K7QM4XRA"));
    const body = '{"code":"K7QM-4XRA","label":"Chrome\\ud800 on Windows"}';
    const r = await pair(
      at(TESTNET_HOST, "/api/ext/pair", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      }),
    );
    expect(r.status).toBe(200);
    expect((await listTokens(h.db, OWNER, "testnet")).map((t) => t.label)).toEqual([
      "Chrome on Windows",
    ]);
  });

  it("limits code guesses per address", async () => {
    for (let i = 0; i < 10; i++) expect((await pair(pairRequest("AAAA-AAAA"))).status).toBe(401);
    const r = await pair(pairRequest("AAAA-AAAA"));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await pair(pairRequest("AAAA-AAAA", TESTNET_HOST, "198.51.100.9"))).status).toBe(401);
    // The same address on the other network has a bucket of its own.
    expect((await pair(pairRequest("AAAA-AAAA", MAINNET_HOST))).status).toBe(401);
  });

  it("limits code guesses on a network in total, apart from the other network", async () => {
    await pg.query(
      "insert into public.rate_limits (bucket, window_start, count) values ('ext:pair:testnet', now(), 300)",
    );
    const r = await pair(pairRequest("AAAA-AAAA", TESTNET_HOST, "198.51.100.10"));
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: "rate_limited" });
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await pair(pairRequest("AAAA-AAAA", MAINNET_HOST, "198.51.100.10"))).status).toBe(401);
  });

  it("needs the bearer token: no header, a cookie or another scheme is a 401", async () => {
    const cases: Record<string, string>[] = [
      {},
      { cookie: "pb_session=anything" },
      { authorization: "Basic abc" },
    ];
    for (const headers of cases) {
      const r = await inbox(at(TESTNET_HOST, "/api/ext/inbox", { headers }));
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ error: "bad_token" });
    }
  });

  it("is valid only at the address of its network, and a code only at its own", async () => {
    const c = await connected();
    const r = await inbox(withToken(c.token, MAINNET_HOST));
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: "bad_token" });
    const elsewhere = await revoke(
      at(MAINNET_HOST, "/api/ext/revoke", {
        method: "POST",
        headers: { authorization: `Bearer ${c.token}` },
      }),
    );
    expect(elsewhere.status).toBe(401);
    expect(await elsewhere.json()).toMatchObject({ error: "bad_token" });
    // Neither call touched it: the token still works at its own address.
    expect((await inbox(withToken(c.token))).status).toBe(200);
    await createPairCode(h.db, OWNER, "testnet", codeHash("M7QM4XRA"));
    const p = await pair(pairRequest("M7QM-4XRA", MAINNET_HOST));
    expect(p.status).toBe(401);
    expect(await p.json()).toMatchObject({ error: "bad_code" });
  });

  it("ends the calling token alone when the extension disconnects", async () => {
    const c = await connected();
    const other = await connected("M7QM4XRA");
    const r = await revoke(
      at(TESTNET_HOST, "/api/ext/revoke", {
        method: "POST",
        headers: { authorization: `Bearer ${c.token}` },
      }),
    );
    expect(r.status).toBe(204);
    expect((await inbox(withToken(c.token))).status).toBe(401);
    // The account's other connection still reads.
    expect((await inbox(withToken(other.token))).status).toBe(200);
  });

  it("lists the active mandates and the held spends, and sends no CORS header", async () => {
    h.mandates = [mandate({ id: 1 }), mandate({ id: 2, status: "revoked" })];
    h.spends = [spend({ id: 7 }), spend({ id: 8, status: "paid" })];
    const c = await connected();
    const r = await inbox(withToken(c.token));
    const body = await r.json();
    expect(body.counts).toEqual({ awaiting: 0, held: 1 });
    expect(body.vaults[0].mandates.map((m: { id: number }) => m.id)).toEqual([1]);
    expect(body.vaults[0].held[0]).toMatchObject({
      spend_id: 7,
      url: `https://testnet.probarion.test/console/${VAULT}`,
    });
    for (const [name] of r.headers) expect(name.startsWith("access-control-")).toBe(false);
  });

  it("reads the account's vaults again on every request", async () => {
    const c = await connected();
    expect((await (await inbox(withToken(c.token))).json()).vaults).toHaveLength(1);
    await pg.query("update public.tenant_members set role = 'viewer' where account_id = $1", [
      OWNER,
    ]);
    try {
      expect((await (await inbox(withToken(c.token))).json()).vaults).toEqual([]);
    } finally {
      await pg.query("update public.tenant_members set role = 'owner' where account_id = $1", [
        OWNER,
      ]);
    }
  });

  it("answers every route without a CORS header, never cached, and an error as { error, detail }", async () => {
    const c = await connected();
    const other = await connected("M7QM4XRA");
    const answers: [string, Response][] = [
      ["pair 400", await pair(pairRequest("nope"))],
      ["inbox 401", await inbox(at(TESTNET_HOST, "/api/ext/inbox"))],
      ["revoke 401", await revoke(at(TESTNET_HOST, "/api/ext/revoke", { method: "POST" }))],
      ["invoices 401", await invoices(invoicePost())],
      ["inbox 200", await inbox(withToken(c.token))],
      [
        "revoke 204",
        await revoke(
          at(TESTNET_HOST, "/api/ext/revoke", {
            method: "POST",
            headers: { authorization: `Bearer ${other.token}` },
          }),
        ),
      ],
      ["invoices 411", await invoices(invoicePost(c.token))],
    ];
    // Full buckets answer 429 at once.
    await pg.query(
      `insert into public.rate_limits (bucket, window_start, count) values ($1, now(), 60), ($2, now(), 10), ($3, now(), 20)
       on conflict (bucket) do update set window_start = excluded.window_start, count = excluded.count`,
      [
        `ext:inbox:testnet:${OWNER}`,
        "ext:pair:testnet:198.51.100.20",
        `ext:invoice:testnet:${OWNER}`,
      ],
    );
    answers.push(
      ["inbox 429", await inbox(withToken(c.token))],
      ["pair 429", await pair(pairRequest("AAAA-AAAA", TESTNET_HOST, "198.51.100.20"))],
      ["invoices 429", await invoices(invoicePost(c.token))],
    );
    for (const [name, r] of answers) {
      // Each row is the answer its name says.
      expect(r.status, name).toBe(Number(name.split(" ")[1]));
      for (const [header] of r.headers)
        expect(header.startsWith("access-control-"), name).toBe(false);
      expect(r.headers.get("cache-control"), name).toBe("no-store");
      if (r.status >= 400)
        expect(Object.keys(await r.json()).sort(), name).toEqual(["detail", "error"]);
    }
  });

  it("limits the inbox per account", async () => {
    const c = await connected();
    for (let i = 0; i < 60; i++) expect((await inbox(withToken(c.token))).status).toBe(200);
    const r = await inbox(withToken(c.token));
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: "rate_limited" });
    // The same account on the other network has a bucket of its own.
    await createPairCode(h.db, OWNER, "mainnet", codeHash("M7QM4XRA"));
    const p = await pair(pairRequest("M7QM-4XRA", MAINNET_HOST));
    expect(p.status).toBe(200);
    const onMainnet = (await p.json()) as { token: string };
    expect((await inbox(withToken(onMainnet.token, MAINNET_HOST))).status).toBe(200);
  }, 30_000);

  it("tags each route's request with its id, component:extension and the network of its address", async () => {
    const c = await connected();
    const withId = (req: Request, id: string) => {
      req.headers.set("x-request-id", id);
      return req;
    };
    h.tag.mockClear();
    await createPairCode(h.db, OWNER, "testnet", codeHash("M7QM4XRA"));
    expect((await pair(withId(pairRequest("M7QM-4XRA"), "rid-pair"))).status).toBe(200);
    expect(
      (await pair(withId(pairRequest("AAAA-AAAA", MAINNET_HOST), "rid-pair-main"))).status,
    ).toBe(401);
    expect((await inbox(withId(withToken(c.token), "rid-inbox"))).status).toBe(200);
    expect((await invoices(withId(invoicePost(c.token), "rid-invoices"))).status).toBe(411);
    expect(
      (
        await revoke(
          withId(
            at(TESTNET_HOST, "/api/ext/revoke", {
              method: "POST",
              headers: { authorization: `Bearer ${c.token}` },
            }),
            "rid-revoke",
          ),
        )
      ).status,
    ).toBe(204);
    expect(h.tag.mock.calls).toEqual([
      ["rid-pair", "extension", "testnet"],
      ["rid-pair-main", "extension", "mainnet"],
      ["rid-inbox", "extension", "testnet"],
      ["rid-invoices", "extension", "testnet"],
      ["rid-revoke", "extension", "testnet"],
    ]);
  });

  it("logs the connection with its request id, and never the token", async () => {
    const c = await connected();
    const paired = logs.lines.find((l) => l.includes('"msg":"ext.paired"'));
    expect(paired).toBeDefined();
    expect(paired).toContain('"connection":"');
    expect(paired).toContain('"request_id":"');
    for (const l of logs.lines) expect(l).not.toContain(c.token.slice(4));
  });

  it("finds the token's account in a vault: 400, 403 and 409 otherwise", async () => {
    const { extMember } = await import("@/lib/ext/auth");
    const token = {
      id: "00000000-0000-4000-8000-0000000000aa",
      account_id: OWNER,
      network: "testnet" as const,
      expires_at: "2030-01-01T00:00:00Z",
    };
    const refusal = async (r: unknown) =>
      r instanceof Response ? [r.status, ((await r.json()) as { error: string }).error] : null;
    expect(await extMember(token, VAULT)).toMatchObject({ vault_id: VAULT, role: "owner" });
    expect(await refusal(await extMember(token, 7))).toEqual([400, "invalid_input"]);
    expect(await refusal(await extMember({ ...token, account_id: "eve.testnet" }, VAULT))).toEqual([
      403,
      "not_member",
    ]);
    expect(await refusal(await extMember(token, VAULT, ["approver"]))).toEqual([403, "not_member"]);
    expect(await refusal(await extMember({ ...token, network: "mainnet" }, VAULT))).toEqual([
      409,
      "wrong_network",
    ]);
  });

  it("answers 503 unavailable as { error, detail }, and logs it with its request id, when the database is down", async () => {
    const c = await connected();
    h.dbDown = true;
    try {
      const answers: [string, Response][] = [
        ["pair", await pair(pairRequest("M7QM-4XRA"))],
        ["inbox", await inbox(withToken(c.token))],
        [
          "revoke",
          await revoke(
            at(TESTNET_HOST, "/api/ext/revoke", {
              method: "POST",
              headers: { authorization: `Bearer ${c.token}` },
            }),
          ),
        ],
        ["invoice", await invoices(invoicePost(c.token))],
      ];
      for (const [name, r] of answers) {
        expect(r.status, name).toBe(503);
        const body = (await r.json()) as Record<string, unknown>;
        expect(Object.keys(body).sort(), name).toEqual(["detail", "error"]);
        expect(body.error, name).toBe("unavailable");
        const line = logs.lines.find((l) => l.includes(`"msg":"ext.${name}_failed"`));
        expect(line, name).toBeDefined();
        expect(line, name).toContain('"request_id":"');
      }
    } finally {
      h.dbDown = false;
    }
  });
});
