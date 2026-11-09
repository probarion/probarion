import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/port";
import { freshDb, seedTenant } from "./harness";
import { pgliteDb } from "./pglite-db";

// The queries the OWNER runs by hand from docs/ops/metrics.md (site audit P1-17), taken from the doc itself and run on
// the real schema, so the doc cannot drift from the tables or count the wrong thing.

const DOC = readFileSync(
  fileURLToPath(new URL("../../../../docs/ops/metrics.md", import.meta.url)),
  "utf8",
);

/** The SQL block right after `<!-- query: name -->` in the doc. */
function query(name: string): string {
  const at = DOC.indexOf(`<!-- query: ${name} -->`);
  if (at < 0) throw new Error(`docs/ops/metrics.md has no query named ${name}`);
  const block = /```sql\n([\s\S]*?)```/.exec(DOC.slice(at))?.[1];
  if (!block) throw new Error(`docs/ops/metrics.md has no SQL block after the query named ${name}`);
  return block;
}

const H = (c: string) => c.repeat(64);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DAY = 86_400_000;

let pg: PGlite;
let service: Db;

beforeAll(async () => {
  pg = await freshDb();
  service = pgliteDb(pg);
});
afterAll(async () => {
  await pg.close();
});

describe("Canary attempts by source", () => {
  let n = 0;
  const attempt = (over: Record<string, unknown>) => {
    n += 1;
    return service.rpc("canary_attempt_insert", {
      visitor_hash: H("1"),
      ip_hash: H("2"),
      mode: "live",
      text_sha256: n.toString(16).padStart(64, "0"),
      text_length: 10,
      code_status: "refused_by_code",
      request_id: "r",
      network: "mainnet",
      ...over,
    });
  };

  it("counts outside attempts and browsers by the source their link named, on one network", async () => {
    await attempt({ via: "x" });
    await attempt({ via: "x" });
    await attempt({ via: "x", visitor_hash: H("3") });
    await attempt({ via: "readme" });
    await attempt({});
    await attempt({ via: "x", is_team: true });
    await attempt({ via: "x", network: "testnet" });
    const r = await pg.query(query("canary-by-source"));
    expect(r.rows).toEqual([
      { via: "x", attempts: 3, browsers: 2 },
      { via: "(none)", attempts: 1, browsers: 1 },
      { via: "readme", attempts: 1, browsers: 1 },
    ]);
  });
});

describe("how far outside owners get", () => {
  let k = 0;
  /** An agent key; `activated` false leaves it pending, as a key the chain never showed. */
  const key = (tenant: string, o: { activated?: boolean; revoked?: boolean } = {}) => {
    k += 1;
    const activated = o.activated ?? true;
    return pg.query(
      `insert into public.agent_keys
         (tenant_id, purpose, public_key, secret_ciphertext, secret_nonce, status, created_by, activated_at, revoked_at)
       values ($1, 'agent', $2, 'c', 'n', $3, 'owner.near', $4, $5)`,
      [
        tenant,
        `ed25519:${B58[k]}${"1".repeat(43)}`,
        o.revoked ? "revoked" : activated ? "active" : "pending",
        activated ? new Date() : null,
        o.revoked ? new Date() : null,
      ],
    );
  };
  let e = 0;
  /** A chain event the watcher recorded; `initial` marks one it read while catching up on the vault's history. */
  const event = (tenant: string, kind: string, daysAgo: number, initial = false) => {
    e += 1;
    return pg.query(
      "insert into public.vault_events (tenant_id, event_key, kind, observed_at, initial) values ($1, $2, $3, $4, $5)",
      [tenant, `e:${e}`, kind, new Date(Date.now() - daysAgo * DAY), initial],
    );
  };
  /** A vault that got all the way: a key, a mandate, a first payment `paidDaysAgo` days ago, more after it. */
  async function full(
    vault: string,
    o: { kind?: "team" | "external" | "canary"; network?: "mainnet" | "testnet" },
  ) {
    const t = await seedTenant(pg, { vault, owner: `${vault}.owner`, ...o });
    await key(t);
    await event(t, "mandate_created", 12);
    await event(t, "spend_paid", 10);
    await event(t, "spend_paid", 2);
    return t;
  }

  beforeAll(async () => {
    // Nothing past the vault: its only key is still pending.
    await key(await seedTenant(pg, { vault: "a.vaults.probarion.near", owner: "a.near" }), {
      activated: false,
    });
    // A key that was active, then revoked: it still got that far.
    await key(await seedTenant(pg, { vault: "b.vaults.probarion.near", owner: "b.near" }), {
      revoked: true,
    });
    const c = await seedTenant(pg, { vault: "c.vaults.probarion.near", owner: "c.near" });
    await key(c);
    await event(c, "mandate_created", 3);
    // Paid 10 days ago, and paid again 2 days ago: still at it a week after the first payment.
    await full("d.vaults.probarion.near", {});
    // Paid through Base 9 days ago; since then only an anchor and a low-NEAR alert, which are not the owner at work.
    const e2 = await seedTenant(pg, { vault: "e.vaults.probarion.near", owner: "e.near" });
    await key(e2);
    await event(e2, "mandate_created", 11);
    await event(e2, "spend_burned", 9);
    await event(e2, "anchor", 1);
    await event(e2, "near_low", 1);
    // Paid for the first time yesterday: too new to say whether it stays.
    const f = await seedTenant(pg, { vault: "f.vaults.probarion.near", owner: "f.near" });
    await key(f);
    await event(f, "mandate_created", 1);
    await event(f, "spend_paid", 1);
    // Paid 10 days ago and again 5 days ago, then nothing: busy in its first week only.
    const g = await seedTenant(pg, { vault: "g.vaults.probarion.near", owner: "g.near" });
    await key(g);
    await event(g, "mandate_created", 11);
    await event(g, "spend_paid", 10);
    await event(g, "spend_paid", 5);
    // Its later payment is old history the watcher was still catching up on, not the owner at work since.
    const h = await seedTenant(pg, { vault: "h.vaults.probarion.near", owner: "h.near" });
    await key(h);
    await event(h, "mandate_created", 11);
    await event(h, "spend_paid", 10);
    await event(h, "spend_paid", 2, true);
    // Not outside owners on mainnet: the team's own, a Canary, and an outside vault on testnet.
    await full("team.vaults.probarion.near", { kind: "team" });
    await full("canary.vaults.probarion.near", { kind: "canary" });
    await full("t.vaults.probarion.testnet", { network: "testnet" });
  });

  it("counts each stage of the funnel, each one within the one before", async () => {
    const r = await pg.query(query("owner-funnel"));
    expect(r.rows).toEqual([
      {
        vaults: 8,
        with_agent_key: 7,
        with_mandate: 6,
        first_payment: 5,
        first_payment_7_days_ago: 4,
        active_7_days_later: 1,
      },
    ]);
  });

  it("counts outside vaults by the UTC week (from Monday) of their first payment", async () => {
    const sql = query("first-payments-by-week").trim().replace(/;$/, "");
    const r = await pg.query<{ week: string; vaults: number }>(
      `select week::text as week, vaults from (${sql}) q`,
    );
    /** The Monday, UTC, of the week a day `daysAgo` days back falls in. */
    const monday = (daysAgo: number) => {
      const d = new Date(Date.now() - daysAgo * DAY);
      const back = (d.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back))
        .toISOString()
        .slice(0, 10);
    };
    // The first payments of d, e, f, g and h.
    const expected = new Map<string, number>();
    for (const w of [10, 9, 1, 10, 10].map(monday).sort())
      expected.set(w, (expected.get(w) ?? 0) + 1);
    expect(r.rows.map((x) => [x.week, x.vaults])).toEqual([...expected.entries()]);
  });
});
