-- Fails loudly if any public table lacks RLS, if anon holds any table privilege,
-- or if anon can execute anything except the public_* RPCs and pb_current_account().
-- probarion-claim: RLS
do $$
declare
  r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity loop
    raise exception 'rls_missing: %', r.relname;
  end loop;
  for r in select table_name, privilege_type from information_schema.role_table_grants
           where table_schema = 'public' and grantee = 'anon' loop
    raise exception 'anon_table_grant: % on %', r.privilege_type, r.table_name;
  end loop;
  for r in select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
             and p.proname not like 'public\_%' and p.proname <> 'pb_current_account' loop
    raise exception 'anon_can_execute: %', r.proname;
  end loop;
end $$;
