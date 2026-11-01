import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asRole, freshDb, seedTenant } from "./harness";

/** table -> a column list every role is allowed to select (agent_keys/invoices have secret columns). */
const TENANT_TABLES: Record<string, string> = {
  tenants: "id as tenant_id",
  tenant_members: "tenant_id",
  agent_keys: "tenant_id",
  invoices: "tenant_id",
  ledger_entries: "tenant_id",
  vault_events: "tenant_id",
  alert_subscriptions: "tenant_id",
  alerts_sent: "id",
};
const GLOBAL_TABLES = ["canary_attempts", "metrics_daily", "pilots", "rate_limits"];

describe("schema and RLS", () => {
  let pg: PGlite;
  let a: string;
  let b: string;

  beforeAll(async () => {
    pg = await freshDb();
    a = await seedTenant(pg, { vault: "a.vaults.probarion.near", owner: "alice.near" });
    b = await seedTenant(pg, { vault: "b.vaults.probarion.near", owner: "bob.near" });
    for (const [t, ch] of [
      [a, "a"],
      [b, "b"],
    ] as const) {
      await pg.query(
        `insert into agent_keys (tenant_id, purpose, public_key, secret_ciphertext, secret_nonce, created_by)
         values ($1, 'agent', $2, 'c2VjcmV0', 'bm9uY2U=', 'x')`,
        [t, `ed25519:${ch.toUpperCase()}${"1".repeat(43)}`],
      );
      await pg.query(
        `insert into invoices (tenant_id, invoice_hash, ref, media_type, retained, request_id, created_by)
         values ($1, $2, 'inv-1', 'text/plain', false, 'r', 'x')`,
        [t, ch.repeat(64)],
      );
      await pg.query(
        `insert into ledger_entries (tenant_id, seq, kind, body, body_hash, sig, signer, link, request_id)
         values ($1, 0, 'note', '{}', $2, 'ed25519:s', 'ed25519:p', $2, 'r')`,
        [t, (ch === "a" ? "c" : "d").repeat(64)],
      );
      const ev = await pg.query<{ id: number }>(
        `insert into vault_events (tenant_id, event_key, kind) values ($1, 'spend:1:Held', 'spend_held') returning id`,
        [t],
      );
      const sub = await pg.query<{ id: string }>(
        `insert into alert_subscriptions (tenant_id, channel, created_by) values ($1, 'email', 'x') returning id`,
        [t],
      );
      const evId = ev.rows[0]?.id;
      const subId = sub.rows[0]?.id;
      if (evId === undefined || subId === undefined) throw new Error("seed insert returned no id");
      await pg.query(
        `insert into alerts_sent (subscription_id, vault_event_id, status) values ($1, $2, 'sent')`,
        [subId, evId],
      );
    }
    await pg.query(
      `insert into canary_attempts (visitor_hash, ip_hash, mode, text_sha256, text_length, code_status, request_id)
       values ($1, $1, 'code-only', $1, 5, 'refused_by_code', 'r')`,
      ["e".repeat(64)],
    );
    await pg.query(
      `insert into metrics_daily (day, segment, metric, value) values ('2026-11-08', 'team', 'vaults', 1)`,
    );
    await pg.query(
      `insert into pilots (vault_account_id, owner_account_id, cohort) values ('acme.vaults.probarion.near', 'acme.near', 'external')`,
    );
    await pg.query(`insert into rate_limits (bucket, window_start, count) values ('x', now(), 1)`);
  });

  it("enables RLS on every table in public", async () => {
    const r = await pg.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(r.rows.map((x) => x.relname).sort()).toEqual(
      [...Object.keys(TENANT_TABLES), ...GLOBAL_TABLES].sort(),
    );
    expect(r.rows.filter((x) => !x.relrowsecurity)).toEqual([]);
  });

  it("anon cannot select from any table", async () => {
    for (const [t, cols] of Object.entries(TENANT_TABLES)) {
      await expect(
        asRole(pg, "anon", null, (tx) => tx.query(`select ${cols} from public.${t}`)),
        t,
      ).rejects.toThrow(/permission denied/);
    }
    for (const t of GLOBAL_TABLES) {
      await expect(
        asRole(pg, "anon", null, (tx) => tx.query(`select 1 from public.${t}`)),
        t,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("a member reads exactly their own tenant's rows", async () => {
    for (const [t, cols] of Object.entries(TENANT_TABLES)) {
      const r = await asRole(pg, "authenticated", "alice.near", (tx) =>
        tx.query<{ tenant_id?: string }>(`select ${cols} from public.${t}`),
      );
      expect(r.rows.length, t).toBe(1);
      if (r.rows[0]?.tenant_id !== undefined) expect(r.rows[0].tenant_id, t).toBe(a);
    }
  });

  it("a signed-in non-member reads nothing", async () => {
    for (const [t, cols] of Object.entries(TENANT_TABLES)) {
      const r = await asRole(pg, "authenticated", "mallory.near", (tx) =>
        tx.query(`select ${cols} from public.${t}`),
      );
      expect(r.rows.length, t).toBe(0);
    }
  });

  it("members never see global tables or secret columns", async () => {
    for (const t of GLOBAL_TABLES) {
      const r = await asRole(pg, "authenticated", "alice.near", (tx) =>
        tx.query(`select 1 from public.${t}`),
      );
      expect(r.rows.length, t).toBe(0);
    }
    await expect(
      asRole(pg, "authenticated", "alice.near", (tx) =>
        tx.query("select secret_ciphertext from public.agent_keys"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(pg, "authenticated", "alice.near", (tx) =>
        tx.query("select content_ciphertext from public.invoices"),
      ),
    ).rejects.toThrow(/permission denied/);
    const ok = await asRole(pg, "authenticated", "alice.near", (tx) =>
      tx.query<{ public_key: string }>("select public_key from public.agent_keys"),
    );
    expect(ok.rows).toHaveLength(1);
  });

  it("authenticated cannot write anything", async () => {
    await expect(
      asRole(pg, "authenticated", "alice.near", (tx) =>
        tx.query(
          `insert into public.tenants (vault_id, network, kind, owner_account) values ('x.near', 'mainnet', 'team', 'alice.near')`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(pg, "authenticated", "alice.near", (tx) =>
        tx.query(`update public.tenants set kind = 'team'`),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("keeps the ledger append-only, even for the table owner", async () => {
    await expect(
      pg.query(`update ledger_entries set request_id = 'x' where tenant_id = $1`, [a]),
    ).rejects.toThrow(/ledger_append_only/);
    await expect(pg.query(`delete from ledger_entries where tenant_id = $1`, [a])).rejects.toThrow(
      /ledger_append_only/,
    );
  });

  // F29: UPDATE/DELETE are blocked by the trigger; TRUNCATE skips row triggers, so it is a privilege.
  it("keeps the ledger append-only even for the service key (no TRUNCATE, no TRIGGER)", async () => {
    await expect(
      asRole(pg, "service_role", null, (tx) => tx.query("truncate public.ledger_entries")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(pg, "service_role", null, (tx) =>
        tx.query(
          "create trigger sneaky before insert on public.ledger_entries for each row execute function public.ledger_entries_append_only()",
        ),
      ),
    ).rejects.toThrow(/permission denied|must be owner/);
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      for (const priv of ["TRUNCATE", "TRIGGER"]) {
        const r = await pg.query<{ ok: boolean }>(
          "select has_table_privilege($1, 'public.ledger_entries', $2) as ok",
          [role, priv],
        );
        expect(r.rows[0]?.ok, `${role} ${priv}`).toBe(false);
      }
    }
    // The service key still does its job: it reads and inserts, and the trigger still blocks rewrites.
    const rows = await asRole(pg, "service_role", null, (tx) =>
      tx.query("select 1 from public.ledger_entries"),
    );
    expect(rows.rows.length).toBe(2);
    await expect(
      asRole(pg, "service_role", null, (tx) => tx.query("delete from public.ledger_entries")),
    ).rejects.toThrow(/ledger_append_only/);
  });

  it("refuses invoice content when retention is off", async () => {
    await expect(
      pg.query(
        `insert into invoices (tenant_id, invoice_hash, ref, media_type, retained, content_ciphertext, content_nonce, request_id, created_by)
         values ($1, $2, 'inv-2', 'text/plain', false, 'eA==', 'eA==', 'r', 'x')`,
        [a, "f".repeat(64)],
      ),
    ).rejects.toThrow(/invoices_retention/);
  });

  // F6 / R3: an unknown on-chain outcome is recorded with its hash and never retried; low NEAR is an event.
  it("accepts the unconfirmed outcome and the near_low event kind", async () => {
    const outcome = await pg.transaction(async (tx) => {
      const canary = await tx.query<{ code_status: string }>(
        `insert into canary_attempts (visitor_hash, ip_hash, mode, text_sha256, text_length, code_status, tx_hash, request_id)
         values ($1, $1, 'live', $1, 5, 'unconfirmed', 'H1', 'r') returning code_status`,
        ["9".repeat(64)],
      );
      const invoice = await tx.query<{ status: string }>(
        `insert into invoices (tenant_id, invoice_hash, ref, media_type, retained, status, request_id, created_by)
         values ($1, $2, 'inv-unconfirmed', 'text/plain', false, 'unconfirmed', 'r', 'x') returning status`,
        [a, "8".repeat(64)],
      );
      const ev = await tx.query<{ kind: string }>(
        `insert into vault_events (tenant_id, event_key, kind) values ($1, 'near_low:2026-11-08', 'near_low') returning kind`,
        [a],
      );
      await tx.rollback();
      return [canary.rows[0]?.code_status, invoice.rows[0]?.status, ev.rows[0]?.kind];
    });
    expect(outcome).toEqual(["unconfirmed", "unconfirmed", "near_low"]);
    await expect(
      pg.query(
        `insert into canary_attempts (visitor_hash, ip_hash, mode, text_sha256, text_length, code_status, request_id)
         values ($1, $1, 'live', $1, 5, 'made_up', 'r')`,
        ["7".repeat(64)],
      ),
    ).rejects.toThrow(/code_status/);
  });

  it("passes the SQL RLS assertions on the fully migrated schema", async () => {
    const sql = readFileSync(fileURLToPath(new URL("./rls-assert.sql", import.meta.url)), "utf8");
    await expect(pg.exec(sql)).resolves.toBeDefined();
  });
});
