-- The watcher (plan 04 Task 20): /api/cron/watch polls every vault on the chain and writes what it sees into
-- vault_events, one row per (tenant, event_key), so reading the same chain twice adds nothing. The usage page already
-- counts these rows (0009), and the alerts (Task 21) read them. This file holds the three functions the watcher calls
-- and one column. Nothing here is a grant to anon or authenticated.
--
-- It resolves 0001's TODO(plan 04 Task 20) on `near_low`: the kind is in the table's check since 0001, so no kind is
-- added here. The watcher emits it once per UTC day while a vault's free NEAR is below 0.05 NEAR
-- (apps/web/src/lib/near/runway.ts). 0001's text is left as it is: a migration that production has applied is not edited.
--
-- 1. tenants.watch_last_at: when a run last looked at the tenant, whether it worked or not. tenants_for_watch lists the
--    tenants never looked at first and then the one looked at longest ago, so a run that stops at its time budget does
--    not always leave the same vaults for last, and a vault that keeps failing goes to the back instead of using up
--    every run's time. A tenant created before this column has none, which reads as "never".
-- 2. tenants_for_watch({ network, tenant_id? }): the tenants of one network (or one of them) with their cursors, in that
--    order. `network` is required, so the watcher of a testnet deployment never reads mainnet vaults.
-- 3. vault_event_insert({ events }): writes a batch of events in the order given, and skips a key the tenant already
--    has. A vault's first run records its whole history, and one call per event would cost thousands of round trips.
--    It answers how many rows it added. All or nothing: a bad event (a tenant that is not one, a kind outside the
--    table's check) fails the whole batch. A key that exists is never changed, so the row a first run wrote stays.
-- 4. tenant_watch_cursor_set({ tenant_id, spend_from?, mandate_from?, anchor_from?, ledger_seq? }): sets the cursors
--    that are given and leaves the others, and marks the tenant as looked at now. With only a tenant it moves no cursor:
--    that is how a run marks a vault as looked at before it reads the chain. A cursor is a plain non-negative whole number. It answers the
--    tenant id, or null when the tenant is gone. Two overlapping runs can leave the cursor of the slower one, which is
--    never beyond what that run read, so the next run reads some rows again; their keys exist and nothing is added.

alter table public.tenants add column watch_last_at timestamptz;

create or replace function public.tenants_for_watch(p jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_network text := p->>'network';
  v_tenant uuid := case when p->>'tenant_id' is null then null else public.agent_key_uuid(p->>'tenant_id') end;
begin
  if v_network is null or v_network not in ('mainnet', 'testnet') then
    raise exception 'invalid_input';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
        'tenant_id', t.id, 'vault_id', t.vault_id, 'network', t.network, 'kind', t.kind,
        'watch_spend_from', t.watch_spend_from, 'watch_mandate_from', t.watch_mandate_from,
        'watch_anchor_from', t.watch_anchor_from, 'watch_ledger_seq', t.watch_ledger_seq)
        order by t.watch_last_at nulls first, t.created_at, t.id), '[]'::jsonb)
    from public.tenants t
    where t.network = v_network and (v_tenant is null or t.id = v_tenant));
end $$;

create or replace function public.vault_event_insert(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_inserted integer;
begin
  if jsonb_typeof(p->'events') is distinct from 'array' then
    raise exception 'invalid_input';
  end if;
  insert into public.vault_events (tenant_id, event_key, kind, spend_id, mandate_id, anchor_seq, amount, code, tx_hash, payload)
  select public.agent_key_uuid(e.v->>'tenant_id'), e.v->>'event_key', e.v->>'kind', (e.v->>'spend_id')::bigint,
         (e.v->>'mandate_id')::bigint, (e.v->>'anchor_seq')::bigint, e.v->>'amount', e.v->>'code', e.v->>'tx_hash',
         case when jsonb_typeof(e.v->'payload') = 'object' then e.v->'payload' else '{}'::jsonb end
  from jsonb_array_elements(p->'events') with ordinality as e(v, n)
  order by e.n
  on conflict (tenant_id, event_key) do nothing;
  get diagnostics v_inserted = row_count;
  return jsonb_build_object('inserted', v_inserted);
end $$;

create or replace function public.tenant_watch_cursor_set(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_id uuid;
begin
  -- A cursor is a position or a ledger seq: a whole number that fits its column and a JavaScript number.
  if (p->>'spend_from' is not null and p->>'spend_from' !~ '^[0-9]{1,15}$')
     or (p->>'mandate_from' is not null and p->>'mandate_from' !~ '^[0-9]{1,15}$')
     or (p->>'anchor_from' is not null and p->>'anchor_from' !~ '^[0-9]{1,15}$')
     or (p->>'ledger_seq' is not null and p->>'ledger_seq' !~ '^[0-9]{1,9}$') then
    raise exception 'invalid_input';
  end if;
  update public.tenants set
      watch_spend_from = coalesce((p->>'spend_from')::bigint, watch_spend_from),
      watch_mandate_from = coalesce((p->>'mandate_from')::bigint, watch_mandate_from),
      watch_anchor_from = coalesce((p->>'anchor_from')::bigint, watch_anchor_from),
      watch_ledger_seq = coalesce((p->>'ledger_seq')::integer, watch_ledger_seq),
      watch_last_at = now()
    where id = v_tenant
    returning id into v_id;
  return case when v_id is null then null else jsonb_build_object('tenant_id', v_id) end;
end $$;

revoke execute on function public.tenants_for_watch(jsonb), public.vault_event_insert(jsonb), public.tenant_watch_cursor_set(jsonb)
  from public, anon, authenticated;
grant execute on function public.tenants_for_watch(jsonb), public.vault_event_insert(jsonb), public.tenant_watch_cursor_set(jsonb)
  to service_role;
