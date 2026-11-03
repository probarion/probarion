import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite, type Transaction } from "@electric-sql/pglite";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

export type Role = "anon" | "authenticated" | "service_role";

/** What a Supabase project provides before our migrations run (roles + default grants). */
export const SUPABASE_STUB = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export async function freshDb(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUB);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) await pg.exec(readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8"));
  return pg;
}

/** Runs fn inside a transaction as `role`, with PostgREST-style JWT claims. */
export async function asRole<T>(
  pg: PGlite,
  role: Role,
  account: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return pg.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    const claims = account ? { role, near_account: account } : { role };
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    return fn(tx);
  });
}

export async function seedTenant(
  pg: PGlite,
  t: {
    vault: string;
    owner: string;
    kind?: "team" | "external" | "canary";
    approvers?: string[];
    proofPublic?: boolean;
  },
): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into public.tenants (vault_id, network, kind, owner_account, proof_public)
     values ($1, 'mainnet', $2, $3, $4) returning id`,
    [t.vault, t.kind ?? "external", t.owner, t.proofPublic ?? false],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("seedTenant: insert returned no id");
  await pg.query(
    `insert into public.tenant_members (tenant_id, account_id, role) values ($1, $2, 'owner')`,
    [id, t.owner],
  );
  for (const a of t.approvers ?? []) {
    await pg.query(
      `insert into public.tenant_members (tenant_id, account_id, role) values ($1, $2, 'approver')`,
      [id, a],
    );
  }
  return id;
}
