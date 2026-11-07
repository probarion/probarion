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
// invoice_confirm_nonces (0007) belongs to a tenant, and extension_tokens and extension_pair_codes (0013) to an account and a network, but no member reads them: like the global tables, they have no policy and no grant.
const GLOBAL_TABLES = [
  "canary_attempts",
  "metrics_daily",
  "metrics_runs",
  "pilots",
  "rate_limits",
  "invoice_confirm_nonces",
  "extension_tokens",
  "extension_pair_codes",
];

const RLS_ASSERT_SQL = readFileSync(
  fileURLToPath(new URL("./rls-assert.sql", import.meta.url)),
  "utf8",
);

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
      `insert into metrics_runs (network, computed_at, canary_participants, external_owners) values ('mainnet', now(), 1, 1)`,
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
    // The four global tables have no policy (RLS denies all) and, since fix round 1, no authenticated grant either:
    // a member does not even get an empty result, so one forgotten policy can never open them.
    for (const t of GLOBAL_TABLES) {
      await expect(
        asRole(pg, "authenticated", "alice.near", (tx) => tx.query(`select 1 from public.${t}`)),
        t,
      ).rejects.toThrow(/permission denied/);
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

  // The console reads `target` (email or chat id) and `link_code` (the confirmation secret) only through the service role.
  it("a member cannot select an alert subscription's link_code or target", async () => {
    for (const col of ["link_code", "target", "*"]) {
      await expect(
        asRole(pg, "authenticated", "alice.near", (tx) =>
          tx.query(`select ${col} from public.alert_subscriptions`),
        ),
        col,
      ).rejects.toThrow(/permission denied/);
    }
    // A filter or sort on a secret column leaks it just the same.
    await expect(
      asRole(pg, "authenticated", "alice.near", (tx) =>
        tx.query("select id from public.alert_subscriptions where link_code is not null"),
      ),
    ).rejects.toThrow(/permission denied/);
    const ok = await asRole(pg, "authenticated", "alice.near", (tx) =>
      tx.query<{ channel: string; kinds: string[] }>(
        "select id, tenant_id, channel, kinds, verified_at, active, created_by, created_at from public.alert_subscriptions",
      ),
    );
    expect(ok.rows).toHaveLength(1);
    expect(ok.rows[0]?.kinds).toContain("near_low");
    // The service role (the server) still reads everything.
    const all = await asRole(pg, "service_role", null, (tx) =>
      tx.query("select link_code, target from public.alert_subscriptions"),
    );
    expect(all.rows).toHaveLength(2);
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
    // The service key still reads the ledger; it writes only through ledger_append (migration 0004 revokes INSERT, UPDATE
    // and DELETE), and the trigger still blocks rewrites for every role that could reach it.
    const rows = await asRole(pg, "service_role", null, (tx) =>
      tx.query("select 1 from public.ledger_entries"),
    );
    expect(rows.rows.length).toBe(2);
    await expect(
      asRole(pg, "service_role", null, (tx) => tx.query("delete from public.ledger_entries")),
    ).rejects.toThrow(/permission denied|ledger_append_only/);
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

  // Objects a LATER migration creates must start with nothing for anon and read-only for authenticated.
  it("gives tables, views and sequences created after the migration no anon rights and no authenticated write rights", async () => {
    const seen = await pg.transaction(async (tx) => {
      await tx.exec(`
        create table public.pb_probe (id bigint generated always as identity primary key, v text);
        create view public.pb_probe_view as select id from public.pb_probe;
        create sequence public.pb_probe_seq;`);
      const bad: string[] = [];
      const tablePrivs = async (role: string, rel: string, privs: string[], want: boolean) => {
        for (const p of privs) {
          const r = await tx.query<{ ok: boolean }>(
            "select has_table_privilege($1, $2, $3) as ok",
            [role, rel, p],
          );
          if (r.rows[0]?.ok !== want) bad.push(`${role} ${p} on ${rel}`);
        }
      };
      const seqPrivs = async (role: string, seq: string) => {
        for (const p of ["USAGE", "SELECT", "UPDATE"]) {
          const r = await tx.query<{ ok: boolean }>(
            "select has_sequence_privilege($1, $2, $3) as ok",
            [role, seq, p],
          );
          if (r.rows[0]?.ok) bad.push(`${role} ${p} on sequence ${seq}`);
        }
      };
      const all = [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
        "MAINTAIN",
      ];
      const idSeq = await tx.query<{ s: string }>(
        "select pg_get_serial_sequence('public.pb_probe', 'id') as s",
      );
      expect(idSeq.rows[0]?.s).toBe("public.pb_probe_id_seq");
      for (const rel of ["public.pb_probe", "public.pb_probe_view"]) {
        await tablePrivs("anon", rel, all, false);
        await tablePrivs(
          "authenticated",
          rel,
          all.filter((p) => p !== "SELECT"),
          false,
        );
      }
      for (const seq of ["public.pb_probe_id_seq", "public.pb_probe_seq"]) {
        await seqPrivs("anon", seq);
        await seqPrivs("authenticated", seq);
      }
      // The server is not locked out of what it needs.
      await tablePrivs(
        "service_role",
        "public.pb_probe",
        ["SELECT", "INSERT", "UPDATE", "DELETE"],
        true,
      );
      await tx.rollback();
      return bad;
    });
    expect(seen).toEqual([]);
  });

  it("revokes MAINTAIN from authenticated and service_role on the existing tables", async () => {
    const r = await pg.query<{ relname: string; role: string }>(
      `select c.relname, x.role from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join (values ('authenticated'), ('service_role')) as x(role)
       where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege(x.role, c.oid, 'MAINTAIN')`,
    );
    expect(r.rows).toEqual([]);
  });

  it("passes the SQL RLS assertions on the fully migrated schema", async () => {
    await expect(pg.exec(RLS_ASSERT_SQL)).resolves.toBeDefined();
  });
});

/**
 * Each check in rls-assert.sql must fire on a bad object. The bad object is created inside a transaction that is rolled
 * back, so nothing leaks into the other tests. A control object of the same shape, made safe, must pass.
 */
describe("rls-assert.sql catches what it claims to", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await freshDb();
  });

  const fires = (setup: string, pattern: RegExp) =>
    expect(
      pg.transaction(async (tx) => {
        await tx.exec(setup);
        await tx.exec(RLS_ASSERT_SQL);
      }),
    ).rejects.toThrow(pattern);

  const passes = async (setup: string) => {
    await pg.transaction(async (tx) => {
      await tx.exec(setup);
      await tx.exec(RLS_ASSERT_SQL);
      await tx.rollback();
    });
  };

  it("passes on the clean schema", async () => {
    await passes("select 1");
  });

  it("fires on a partitioned table without RLS", async () => {
    await fires(
      "create table public.bad_part (id int) partition by range (id)",
      /rls_missing: bad_part/,
    );
    await passes(
      "create table public.ok_part (id int) partition by range (id); alter table public.ok_part enable row level security",
    );
  });

  it("fires on a column-level grant to anon", async () => {
    const table =
      "create table public.bad_col (a int); alter table public.bad_col enable row level security;";
    await fires(
      `${table} grant select (a) on public.bad_col to anon`,
      /anon_column_grant: bad_col/,
    );
    await fires(
      `${table} grant update (a) on public.bad_col to anon`,
      /anon_column_grant: bad_col/,
    );
    await passes(table);
  });

  it("fires on a table-level DELETE, TRUNCATE or TRIGGER privilege for anon", async () => {
    const table =
      "create table public.bad_anon (a int); alter table public.bad_anon enable row level security;";
    await fires(
      `${table} grant delete on public.bad_anon to anon`,
      /anon_table_grant: DELETE on bad_anon/,
    );
    await passes(table);
  });

  it("fires on a sequence privilege for anon", async () => {
    await fires(
      "create sequence public.bad_seq; grant usage on sequence public.bad_seq to anon",
      /anon_sequence_grant: bad_seq/,
    );
    await passes("create sequence public.ok_seq");
  });

  it("fires on a write privilege for authenticated", async () => {
    const table =
      "create table public.bad_write (a int); alter table public.bad_write enable row level security;";
    for (const grant of [
      "grant insert on public.bad_write to authenticated",
      "grant update on public.bad_write to authenticated",
      "grant delete on public.bad_write to authenticated",
      "grant truncate on public.bad_write to authenticated",
      "grant trigger on public.bad_write to authenticated",
      "grant update (a) on public.bad_write to authenticated",
      "grant insert (a) on public.bad_write to authenticated",
    ]) {
      await fires(`${table} ${grant}`, /authenticated_write_grant: bad_write/);
    }
    await passes(`${table} grant select on public.bad_write to authenticated`);
  });

  it("fires on a view that lets authenticated or anon bypass RLS, and accepts a security_invoker view", async () => {
    await fires(
      "create view public.bad_view as select id from public.tenants; grant select on public.bad_view to authenticated",
      /view_bypasses_rls: bad_view/,
    );
    // Even with no explicit grant: the default privileges leave authenticated SELECT on a new view.
    await fires(
      "create view public.bad_view2 as select id from public.tenants",
      /view_bypasses_rls: bad_view2/,
    );
    await fires(
      "create view public.bad_view3 as select id from public.tenants; grant select (id) on public.bad_view3 to anon",
      /anon_column_grant: bad_view3/,
    );
    await passes(
      "create view public.ok_view with (security_invoker = true) as select id from public.tenants",
    );
    await passes(
      "create view public.ok_view2 with (security_invoker = on) as select id from public.tenants",
    );
    await passes(
      "create view public.hidden_view as select id from public.tenants; revoke all on public.hidden_view from anon, authenticated",
    );
  });

  it("fires on a materialized view readable by authenticated", async () => {
    await fires(
      "create materialized view public.bad_mv as select id from public.tenants",
      /view_bypasses_rls: bad_mv/,
    );
    await passes(
      "create materialized view public.hidden_mv as select id from public.tenants; revoke all on public.hidden_mv from anon, authenticated",
    );
  });

  it("fires on a security-definer function without a search_path", async () => {
    await fires(
      "create function public.bad_definer() returns int language sql security definer as $$ select 1 $$",
      /definer_without_search_path: bad_definer/,
    );
    await passes(
      "create function public.ok_definer() returns int language sql security definer set search_path = public, pg_temp as $$ select 1 $$",
    );
    await passes("create function public.ok_invoker() returns int language sql as $$ select 1 $$");
  });

  it("fires on a function anon can execute that is not a public_* RPC", async () => {
    await fires(
      "create function public.bad_exec() returns int language sql as $$ select 1 $$; grant execute on function public.bad_exec() to anon",
      /anon_can_execute: bad_exec/,
    );
    await passes(
      "create function public.public_ok() returns int language sql as $$ select 1 $$; grant execute on function public.public_ok() to anon",
    );
  });
});
