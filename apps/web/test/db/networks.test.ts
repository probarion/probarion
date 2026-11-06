import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDb, SUPABASE_STUB, seedTenant } from "./harness";
import { at } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

// Migration 0012 (W-NET-R8): the Canary's public face is per network, an alert is claimed only for an event of its own
// vault, the Telegram link answers the vault's network, and a registration cannot move a tenant to the other network
// (W-NET-R4). The functions are called as the app calls them, as each role.
const MIGRATIONS = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
const H = (c: string) => c.repeat(64);

const MAINNET_V = "acme.vaults.probarion.near";
const TESTNET_V = "acme.vaults.probarion.testnet";

describe("migration 0012: both networks", () => {
  let pg: PGlite;
  let mainnet: string;
  let testnet: string;

  beforeAll(async () => {
    pg = await freshDb();
    mainnet = await seedTenant(pg, { vault: MAINNET_V, owner: "acme.near" });
    testnet = await seedTenant(pg, { vault: TESTNET_V, owner: "acme.testnet", network: "testnet" });
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await pg.exec(
      "truncate public.canary_attempts; delete from public.alerts_sent; delete from public.vault_events; delete from public.alert_subscriptions;",
    );
  });

  const service = () => pgliteDb(pg);
  const anon = () => pgliteDb(pg, "anon");

  describe("the Canary board and feed", () => {
    let n = 0;
    /** One attempt on `network` through the real insert function (null: a row written before attempts had a network). */
    async function attempt(
      network: "mainnet" | "testnet" | null,
      over: Record<string, unknown> = {},
    ) {
      n += 1;
      if (network === null) {
        await pg.query(
          `insert into canary_attempts (visitor_hash, ip_hash, mode, text_sha256, text_length, code_status, request_id, techniques)
           values ($1, $2, 'live', $3, 10, 'refused_by_code', 'r', '{payee_change}')`,
          [H("1"), H("2"), n.toString(16).padStart(64, "0")],
        );
        return;
      }
      await service().rpc("canary_attempt_insert", {
        visitor_hash: over.visitor ?? H("1"),
        ip_hash: over.ip ?? H("2"),
        mode: "live",
        text_sha256: n.toString(16).padStart(64, "0"),
        text_length: 10,
        code_status: "refused_by_code",
        request_id: "r",
        network,
        techniques: over.techniques ?? [network === "mainnet" ? "payee_change" : "fake_invoice"],
        est_tokens: 100,
        is_team: over.team ?? false,
      });
    }
    type Feed = { techniques: string[] }[];
    type Board = {
      browsers: number;
      attempts_external: number;
      attempts_team: number;
      techniques: { technique: string; attempts: number }[];
    };
    const feed = (network: unknown, role: "anon" | "service" = "anon") =>
      (role === "anon" ? anon() : service()).rpc<Feed>("public_canary_feed", { network });
    const board = (network: unknown) =>
      service().rpc<Board>("public_canary_leaderboard", { network });

    it("requires a network, mainnet or testnet, and answers invalid_input for anything else", async () => {
      for (const p of [
        {},
        { network: null },
        { network: "" },
        { network: "devnet" },
        { network: "Mainnet" },
        { network: 1 },
        { network: ["mainnet"] },
      ]) {
        await expect(anon().rpc("public_canary_feed", p), JSON.stringify(p)).rejects.toMatchObject({
          code: "invalid_input",
        });
        await expect(
          service().rpc("public_canary_leaderboard", p),
          JSON.stringify(p),
        ).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
    });

    it("lists only that network's attempts in the feed", async () => {
      await attempt("mainnet");
      await attempt("mainnet");
      await attempt("testnet");
      expect(await feed("mainnet")).toHaveLength(2);
      expect(await feed("testnet")).toHaveLength(1);
      expect((await feed("mainnet")).every((r) => r.techniques[0] === "payee_change")).toBe(true);
      expect(at(await feed("testnet")).techniques).toEqual(["fake_invoice"]);
    });

    it("counts only that network's attempts on the board: visitors, techniques and the team apart", async () => {
      await attempt("mainnet", { visitor: H("a"), ip: H("b") });
      await attempt("mainnet", { visitor: H("c"), ip: H("d") });
      await attempt("mainnet", { team: true });
      await attempt("testnet", { visitor: H("e"), ip: H("f") });
      const m = await board("mainnet");
      expect(m).toMatchObject({ browsers: 2, attempts_external: 2, attempts_team: 1 });
      expect(m.techniques).toEqual([
        {
          technique: "payee_change",
          attempts: 2,
          refused_by_code: 2,
          refused_by_contract: 0,
          held: 0,
        },
      ]);
      const t = await board("testnet");
      expect(t).toMatchObject({ browsers: 1, attempts_external: 1, attempts_team: 0 });
      expect(t.techniques.map((x) => x.technique)).toEqual(["fake_invoice"]);
    });

    it("counts an attempt with no network for neither network", async () => {
      await attempt(null);
      await attempt("mainnet");
      expect(await feed("mainnet")).toHaveLength(1);
      expect(await feed("testnet")).toEqual([]);
      expect(await board("testnet")).toMatchObject({ browsers: 0, attempts_external: 0 });
      expect(await board("mainnet")).toMatchObject({ attempts_external: 1 });
    });

    it("is empty and zero for a network with no attempt, whatever the other one holds", async () => {
      await attempt("mainnet");
      expect(await feed("testnet")).toEqual([]);
      expect(await board("testnet")).toMatchObject({
        browsers: 0,
        addresses: 0,
        attempts_external: 0,
        techniques: [],
      });
    });

    it("keeps the daily token budget global: both networks' attempts count in canary_tokens_today", async () => {
      await attempt("mainnet");
      await attempt("testnet");
      const total = await service().rpc<number>("canary_tokens_today", {});
      const each = await pg.query<{ est_tokens: number }>("select est_tokens from canary_attempts");
      expect(total).toBe(each.rows.reduce((sum, r) => sum + Number(r.est_tokens), 0));
      expect(total).toBeGreaterThan(0);
    });
  });

  describe("alert_claim", () => {
    async function subscription(tenant: string) {
      const { id, link_code } = await service().rpc<{ id: string; link_code: string }>(
        "alert_subscription_create",
        { tenant_id: tenant, channel: "telegram", created_by: "x.near" },
      );
      await service().rpc("alert_subscription_verify", {
        channel: "telegram",
        link_code,
        target: "424242",
      });
      return id;
    }
    async function eventOf(tenant: string, key = "spend:1:held") {
      const r = await pg.query<{ id: string }>(
        "insert into vault_events (tenant_id, event_key, kind, observed_at) values ($1, $2, 'spend_held', now() + interval '1 second') returning id",
        [tenant, key],
      );
      return Number(at(r.rows).id);
    }
    const claim = (sub: string, event: number) =>
      service().rpc<{ claimed: boolean; id: number | null; attempt: number | null }>(
        "alert_claim",
        {
          subscription_id: sub,
          vault_event_id: event,
        },
      );
    const sent = async () => (await pg.query("select 1 from alerts_sent")).rows.length;

    it("claims an event of the subscription's own vault", async () => {
      const sub = await subscription(mainnet);
      expect(await claim(sub, await eventOf(mainnet))).toMatchObject({ claimed: true, attempt: 1 });
      expect(await sent()).toBe(1);
    });

    it("refuses an event of another vault, on the same network and on the other one, and writes nothing", async () => {
      const other = await seedTenant(pg, {
        vault: "other.vaults.probarion.near",
        owner: "other.near",
      });
      const sub = await subscription(mainnet);
      for (const foreign of [await eventOf(other), await eventOf(testnet)]) {
        expect(await claim(sub, foreign)).toEqual({ claimed: false, id: null, attempt: null });
      }
      expect(await sent()).toBe(0);
      await pg.query("delete from tenants where id = $1", [other]);
    });

    it("refuses an event that does not exist, and still refuses a bad event id", async () => {
      const sub = await subscription(mainnet);
      expect(await claim(sub, 999_999_999)).toMatchObject({ claimed: false });
      await expect(
        service().rpc("alert_claim", { subscription_id: sub, vault_event_id: "x" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("still lets a failed alert of its own vault be claimed again", async () => {
      const sub = await subscription(testnet);
      const event = await eventOf(testnet);
      const first = await claim(sub, event);
      await service().rpc("alert_mark", {
        id: first.id,
        attempt: first.attempt,
        status: "failed",
        error: "x",
      });
      await pg.query("update alerts_sent set updated_at = now() - interval '6 minutes'");
      expect(await claim(sub, event)).toMatchObject({ claimed: true, attempt: 2 });
    });
  });

  describe("alert_subscription_verify", () => {
    it("answers the network of the vault, for either network", async () => {
      for (const [tenant, vault, network] of [
        [mainnet, MAINNET_V, "mainnet"],
        [testnet, TESTNET_V, "testnet"],
      ] as const) {
        const { link_code } = await service().rpc<{ link_code: string }>(
          "alert_subscription_create",
          {
            tenant_id: tenant,
            channel: "telegram",
            created_by: "x.near",
          },
        );
        expect(
          await service().rpc("alert_subscription_verify", {
            channel: "telegram",
            link_code,
            target: "1",
          }),
        ).toMatchObject({ tenant_id: tenant, vault_id: vault, network, duplicate: false });
      }
    });

    it("keeps its answer for a code that is not good: null", async () => {
      expect(
        await service().rpc("alert_subscription_verify", {
          channel: "telegram",
          link_code: "0".repeat(32),
          target: "1",
        }),
      ).toBeNull();
    });
  });

  describe("who may call them", () => {
    const grants = async (fn: string) => {
      const r = await pg.query<{ role: string; ok: boolean }>(
        `select r.role, has_function_privilege(r.role, ('public.' || $1)::regprocedure, 'execute') as ok
           from (values ('anon'), ('authenticated'), ('service_role')) as r(role)`,
        [fn],
      );
      const publicExec = await pg.query<{ n: number }>(
        `select (select count(*)::int from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE') as n
           from pg_proc p where p.oid = ('public.' || $1)::regprocedure`,
        [fn],
      );
      return {
        ...Object.fromEntries(r.rows.map((x) => [x.role, x.ok])),
        public: at(publicExec.rows).n,
      };
    };

    it("keeps the feed public (anon, authenticated, service_role) and PUBLIC without EXECUTE", async () => {
      expect(await grants("public_canary_feed(jsonb)")).toEqual({
        anon: true,
        authenticated: true,
        service_role: true,
        public: 0,
      });
    });

    it.each([
      "public_canary_leaderboard(jsonb)",
      "alert_claim(jsonb)",
      "alert_subscription_verify(jsonb)",
      "tenant_register(jsonb)",
    ])("keeps %s for the service role alone", async (fn) => {
      expect(await grants(fn)).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
        public: 0,
      });
    });

    it("refuses the anon and authenticated roles in fact, not only in the grants table", async () => {
      for (const role of ["anon", "authenticated"] as const) {
        const db = pgliteDb(pg, role, "visitor.near");
        await expect(db.rpc("public_canary_leaderboard", { network: "mainnet" })).rejects.toThrow(
          /permission denied/,
        );
        await expect(
          db.rpc("alert_claim", {
            subscription_id: "00000000-0000-4000-8000-000000000000",
            vault_event_id: "1",
          }),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.rpc("alert_subscription_verify", {
            channel: "telegram",
            link_code: "0".repeat(32),
            target: "1",
          }),
        ).rejects.toThrow(/permission denied/);
        expect(await db.rpc("public_canary_feed", { network: "mainnet" })).toEqual([]);
      }
    });
  });

  describe("the migration itself", () => {
    it("redefines the five functions and edits no older file", async () => {
      const files = readdirSync(MIGRATIONS)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      expect(files.at(-1)).toBe("20261108000012_networks.sql");
      const sql = readFileSync(`${MIGRATIONS}/20261108000012_networks.sql`, "utf8");
      for (const fn of [
        "public_canary_feed",
        "public_canary_leaderboard",
        "alert_claim",
        "alert_subscription_verify",
        "tenant_register",
      ]) {
        expect(sql, fn).toMatch(
          new RegExp(`create or replace function public\\.${fn}\\(p jsonb\\)`),
        );
      }
      expect(sql).not.toMatch(/\balter table\b|\bcreate table\b|\bdrop\b/i);
    });

    it("applies to a database that already holds attempts and subscriptions, and keeps them", async () => {
      // Everything up to 0011, some rows in the tables the migration's functions read, then 0012.
      const pre = new PGlite();
      try {
        await pre.exec(SUPABASE_STUB);
        const files = readdirSync(MIGRATIONS)
          .filter((f) => f.endsWith(".sql"))
          .sort();
        for (const f of files.slice(0, -1))
          await pre.exec(readFileSync(`${MIGRATIONS}/${f}`, "utf8"));
        await pre.query(
          "insert into public.tenants (vault_id, network, kind, owner_account) values ($1, 'mainnet', 'canary', 'p.near')",
          [MAINNET_V],
        );
        await pre.query(
          `insert into canary_attempts (visitor_hash, ip_hash, mode, text_sha256, text_length, code_status, request_id, network)
           values ($1, $2, 'live', $3, 10, 'refused_by_code', 'r', 'mainnet')`,
          [H("1"), H("2"), H("3")],
        );
        await pre.exec(readFileSync(`${MIGRATIONS}/${files.at(-1)}`, "utf8"));
        const db = pgliteDb(pre, "anon");
        expect(await db.rpc<unknown[]>("public_canary_feed", { network: "mainnet" })).toHaveLength(
          1,
        );
        expect(await db.rpc<unknown[]>("public_canary_feed", { network: "testnet" })).toHaveLength(
          0,
        );
      } finally {
        await pre.close();
      }
    });
  });
});
