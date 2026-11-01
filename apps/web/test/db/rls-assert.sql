-- Fails loudly if any public table lacks RLS; if anon holds any table, column or sequence privilege; if authenticated
-- can write; if a view or materialized view in public lets anon/authenticated bypass RLS; if a security-definer
-- function has no pinned search_path; or if anon can execute anything except the public_* RPCs and pb_current_account().
-- probarion-claim: RLS
do $$
declare
  r record;
begin
  -- RLS on every table, plain or partitioned.
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity loop
    raise exception 'rls_missing: %', r.relname;
  end loop;

  -- anon (the public key) holds nothing on tables, views, columns or sequences.
  for r in select table_name, privilege_type from information_schema.role_table_grants
           where table_schema = 'public' and grantee = 'anon' loop
    raise exception 'anon_table_grant: % on %', r.privilege_type, r.table_name;
  end loop;
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
             and has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') loop
    raise exception 'anon_column_grant: %', r.relname;
  end loop;
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
             and has_table_privilege('anon', c.oid, 'DELETE,TRUNCATE,TRIGGER') loop
    raise exception 'anon_table_privilege: %', r.relname;
  end loop;
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'S'
             -- CASE: Postgres may run the function before it applies the relkind filter, and it errors on a non-sequence.
             and case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE') else false end loop
    raise exception 'anon_sequence_grant: %', r.relname;
  end loop;

  -- authenticated reads (behind RLS) and never writes: no INSERT, UPDATE, DELETE, TRUNCATE or TRIGGER on any table,
  -- and no column-level INSERT or UPDATE either.
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
             and (has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
                  or has_any_column_privilege('authenticated', c.oid, 'INSERT,UPDATE')) loop
    raise exception 'authenticated_write_grant: %', r.relname;
  end loop;

  -- A view runs with its owner's rights unless it is security_invoker, so a readable view over a tenant table skips RLS.
  -- (A materialized view has no security_invoker option at all: it is never safe to expose.)
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('v', 'm')
             and (has_any_column_privilege('anon', c.oid, 'SELECT') or has_any_column_privilege('authenticated', c.oid, 'SELECT'))
             and (c.relkind = 'm'
                  or not exists (select 1 from unnest(coalesce(c.reloptions, '{}'::text[])) o
                                 where o ~* '^security_invoker=(true|on|yes|1)$')) loop
    raise exception 'view_bypasses_rls: %', r.relname;
  end loop;

  -- A security-definer function without its own search_path can be hijacked through a schema the caller controls.
  for r in select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where starts_with(cfg, 'search_path='))
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    raise exception 'definer_without_search_path: %', r.proname;
  end loop;

  -- anon may execute only the public_* RPCs and pb_current_account(). The allowlist is by name (plan-mandated), so it
  -- cannot see what a public_* function does: the task that adds each public_* function must test that function's own
  -- opt-in gating (for example proof_public) itself.
  for r in select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
             and p.proname not like 'public\_%' and p.proname <> 'pb_current_account' loop
    raise exception 'anon_can_execute: %', r.proname;
  end loop;
end $$;
