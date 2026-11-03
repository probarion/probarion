import type { PGlite } from "@electric-sql/pglite";
import type { MandateView } from "@probarion/core";
import type { SpendOutcome } from "@probarion/sdk";
import { KeyPair } from "near-api-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { type MemberTenant, memberRole } from "@/lib/db/tenants";
import { generateKey } from "@/lib/keys/service";
import { PROCESS_LEASE_SECONDS } from "@/lib/payables/pipeline";
import { LIMITS } from "@/lib/ratelimit";
import { freshDb, seedTenant } from "../../../../../../test/db/harness";
import { MASTER } from "../../../../../../test/db/keys-helpers";
import { pgliteDb } from "../../../../../../test/db/pglite-db";

const h = vi.hoisted(() => ({
  db: null as unknown as Db,
  member: null as unknown as MemberTenant,
  roles: [] as unknown[],
  auth: null as null | Response,
  mandates: (async () => []) as (vault: string, from: number, limit: number) => Promise<unknown[]>,
  process: (async () => null) as (i: unknown) => Promise<unknown>,
  made: [] as Record<string, unknown>[],
  failDb: null as null | string,
}));

vi.mock("@/lib/auth/guard", () => ({
  memberForApi: async (_vault: string, roles: unknown) => {
    h.roles.push(roles);
    return h.auth ?? { session: { accountId: "acme.near" }, member: h.member };
  },
}));
vi.mock("@/lib/crypto/server", () => ({ masterKey: () => MASTER }));
vi.mock("@/lib/db/clients", () => ({
  serviceDb: () => ({
    rpc: (fn: string, p?: Record<string, unknown>) =>
      fn === h.failDb ? Promise.reject(new Error("db down")) : h.db.rpc(fn, p),
  }),
}));
vi.mock("@/lib/near/server", () => ({
  getReader: () => ({ listMandates: (v: string, f: number, l: number) => h.mandates(v, f, l) }),
}));
vi.mock("@/lib/sdk/factory", () => ({
  makeTenantProbarion: (o: Record<string, unknown>) => {
    h.made.push(o);
    return { process: (i: unknown) => h.process(i) };
  },
}));

const { POST, maxDuration } = await import("./route");

const ORIGIN = "http://localhost:3000";
const VAULT = "acme.vaults.probarion.near";
const PO = new TextEncoder().encode("PO-1001 design retainer");
const PAID: SpendOutcome = {
  status: "paid",
  spendId: 1,
  code: null,
  txHash: "TX1",
  ledgerSeq: 1,
  decisionHash: "e".repeat(64),
  anchorTxHash: null,
};

let pg: PGlite;
let agentPk = "";
let agentSecret = "";

function mandate(id: number, pk: string): MandateView {
  return {
    id,
    payee: { type: "near", account_id: "vendor.near" },
    purpose_hash: sha256Hex(PO),
    max_per_payment: "100000000",
    max_total: "1000000000",
    spent: "0",
    reserved: "0",
    max_uses: 10,
    uses: 0,
    expires_at_ns: "1798761600000000000",
    approval_above: "50000000",
    agent_pk: pk,
    label: "m",
    status: "active",
    created_at_ns: "1793750400000000000",
  };
}

beforeAll(async () => {
  pg = await freshDb();
  h.db = pgliteDb(pg);
  const id = await seedTenant(pg, { vault: VAULT, owner: "acme.near" });
  for (const purpose of ["agent", "ledger"] as const) {
    const kp = KeyPair.fromRandom("ed25519");
    const k = await generateKey(
      h.db,
      MASTER,
      { tenantId: id, purpose, label: purpose, createdBy: "acme.near" },
      () => kp,
    );
    await h.db.rpc("agent_key_set_status", {
      tenant_id: id,
      id: k.id,
      from: "pending",
      status: "active",
    });
    if (purpose === "agent") {
      agentPk = k.publicKey;
      agentSecret = kp.toString();
    }
  }
  const m = await memberRole(h.db, VAULT, "acme.near");
  if (!m) throw new Error("no member");
  h.member = m;
});
afterAll(async () => {
  await pg.close();
});

let logged: string[];
beforeEach(() => {
  h.auth = null;
  h.roles = [];
  h.made = [];
  h.failDb = null;
  h.mandates = async (_v, from) => (from === 0 ? [mandate(1, agentPk)] : []);
  h.process = async () => PAID;
  logged = [];
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});

let unique = 0;
/** A different invoice text each call, so tests do not see each other's invoices as duplicates. */
const fresh = (s = "Total 5 USDC") => {
  unique += 1;
  return `Invoice INV-${unique}\n${s}`;
};

function post(form: FormData | null, headers: Record<string, string> = {}): Promise<Response> {
  const req = new Request(`${ORIGIN}/api/console/${VAULT}/invoices`, {
    method: "POST",
    headers: { origin: ORIGIN, "x-request-id": "req-1", ...headers },
    ...(form ? { body: form } : {}),
  });
  return POST(req, { params: Promise.resolve({ vault: VAULT }) });
}

function invoiceForm(o: { text?: string; file?: File; purpose?: boolean } = {}): FormData {
  const f = new FormData();
  if (o.file) f.set("file", o.file);
  if (o.text !== undefined) f.set("text", o.text);
  if (o.purpose !== false) f.set("purpose", new File([PO], "po.pdf", { type: "application/pdf" }));
  return f;
}

const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("POST /api/console/[vault]/invoices", () => {
  it("lets the tenant lease outlast the route's longest run, with a margin", () => {
    expect(maxDuration + 30).toBeLessThanOrEqual(PROCESS_LEASE_SECONDS);
  });

  it("refuses another origin before anything else", async () => {
    const r = await post(invoiceForm({ text: fresh() }), { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(h.roles).toEqual([]);
  });

  it("lets only an owner or an approver run a cycle", async () => {
    h.auth = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    const r = await post(invoiceForm({ text: fresh() }));
    expect(r.status).toBe(403);
    expect(h.roles).toEqual([["owner", "approver"]]);
  });

  it("runs the cycle for an uploaded text file, signing with the mandate's key", async () => {
    const text = fresh("Total 25 USDC");
    const r = await post(
      // Only the base name is kept, without control characters.
      invoiceForm({ file: new File([text], "C:\\bills\\in\u0007v.txt", { type: "text/plain" }) }),
    );
    expect(r.status).toBe(200);
    expect(await body(r)).toMatchObject({
      status: "decided",
      outcome: { status: "paid" },
      recorded: true,
      requestId: "req-1",
    });
    expect(h.made).toEqual([
      expect.objectContaining({ agentKey: agentSecret, requestId: "req-1" }),
    ]);
    const row = await pg.query<{ filename: string; media_type: string }>(
      "select filename, media_type from invoices order by created_at desc limit 1",
    );
    expect(row.rows[0]).toEqual({ filename: "inv.txt", media_type: "text/plain" });
  });

  it("runs the cycle for pasted text", async () => {
    const r = await post(invoiceForm({ text: fresh() }));
    expect(r.status).toBe(200);
    const row = await pg.query<{ filename: string | null }>(
      "select filename from invoices order by created_at desc limit 1",
    );
    expect(row.rows[0]?.filename).toBeNull();
  });

  it("says what is missing: no invoice, an unreadable or unsupported file, a file too large", async () => {
    expect((await post(invoiceForm({ text: "  " }))).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    const fake = await post(
      invoiceForm({ file: new File(["hello"], "inv.pdf", { type: "application/pdf" }) }),
    );
    expect(fake.status).toBe(400);
    expect(await body(fake)).toMatchObject({ error: "unreadable", detail: "Not a PDF file" });
    const png = await post(
      invoiceForm({ file: new File(["x"], "scan.png", { type: "image/png" }) }),
    );
    expect(png.status).toBe(415);
    const big = await post(
      invoiceForm({ file: new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.txt") }),
    );
    expect(big.status).toBe(413);
    expect(
      (await post(invoiceForm({ text: fresh() }), { "content-length": String(20 * 1024 * 1024) }))
        .status,
    ).toBe(413);
    expect(h.made).toEqual([]);
  });

  it("asks for the purpose document when none is attached", async () => {
    const r = await post(invoiceForm({ text: fresh(), purpose: false }));
    expect(r.status).toBe(409);
    expect(await body(r)).toMatchObject({
      error: "no_mandate",
      detail: expect.stringMatching(/purpose document/),
    });
  });

  it("answers a re-upload as a duplicate, with the invoice it duplicates", async () => {
    const text = fresh();
    const first = await body(await post(invoiceForm({ text })));
    const r = await post(invoiceForm({ text }));
    expect(r.status).toBe(409);
    expect(await body(r)).toMatchObject({
      error: "duplicate",
      invoiceId: first.invoiceId,
      status: "decided",
    });
  });

  it("shows an unconfirmed outcome as payment sent, confirmation pending", async () => {
    h.process = async () => ({
      ...PAID,
      status: "unconfirmed",
      spendId: null,
      code: "TxOutcomeUnknown",
    });
    const text = fresh();
    const r = await post(invoiceForm({ text }));
    expect(r.status).toBe(200);
    expect(await body(r)).toMatchObject({
      status: "unconfirmed",
      notice: expect.stringMatching(/^Payment sent, confirmation pending/),
    });
    const again = await body(await post(invoiceForm({ text })));
    expect(again).toMatchObject({
      error: "duplicate",
      status: "unconfirmed",
      detail: expect.stringMatching(/already sent/),
    });
  });

  it("names the mandate whose key is not active, and sends nothing", async () => {
    const stranger = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    h.mandates = async (_v, from) => (from === 0 ? [mandate(7, stranger)] : []);
    const r = await post(invoiceForm({ text: fresh() }));
    expect(r.status).toBe(409);
    expect(await body(r)).toMatchObject({
      error: "key_unavailable",
      detail: expect.stringContaining("Mandate #7"),
    });
    expect(h.made).toEqual([]);
  });

  it("answers 503 when the chain or the database cannot be read, and 502 when the cycle fails", async () => {
    h.mandates = async () => {
      throw new Error("all RPC endpoints failed");
    };
    expect((await post(invoiceForm({ text: fresh() }))).status).toBe(503);
    h.mandates = async (_v, from) => (from === 0 ? [mandate(1, agentPk)] : []);
    h.failDb = "agent_key_list";
    const down = await post(invoiceForm({ text: fresh() }));
    expect(down.status).toBe(503);
    expect(await body(down)).toMatchObject({ error: "unavailable" });
    expect(logged.some((l) => l.includes("payables.route_failed"))).toBe(true);
    h.failDb = "rate_limit_take";
    const noLimiter = await post(invoiceForm({ text: fresh() }));
    expect(noLimiter.status).toBe(503);
    expect(await body(noLimiter)).toMatchObject({ error: "unavailable" });
    h.failDb = null;
    h.process = async () => {
      throw new Error("ledger moved since this decision was attested; retry");
    };
    const failed = await post(invoiceForm({ text: fresh() }));
    expect(failed.status).toBe(502);
    expect(await body(failed)).toMatchObject({ error: "failed", invoiceId: expect.any(String) });
  });

  it("rate-limits uploads per vault", async () => {
    const [max, windowSeconds] = LIMITS.invoiceUpload;
    for (let i = 0; i < max; i++) {
      await h.db.rpc("rate_limit_take", {
        bucket: `invoices:${h.member.tenant_id}`,
        max,
        window_seconds: windowSeconds,
      });
    }
    expect((await post(invoiceForm({ text: fresh() }))).status).toBe(429);
  });
});
