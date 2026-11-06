-- The public usage numbers (spec §14.5): counts only, never dollar volumes, and always in three separate segments:
-- the team's own vaults, external owners' vaults, and Canary participants. One database holds testnet and mainnet
-- tenants, so every number belongs to one network and the page asks for the network it runs on.
--
-- 1. metrics_daily gets a network. The table is empty in production today, and the change still works on one with rows:
--    an existing row becomes a testnet row (the default) and the key gains the network.
-- 2. metrics_compute({ network, day? }): service_role only, security invoker, with a pinned search_path. It replaces one
--    UTC day of one network's rows (default: today) with what the source tables say now, so running it again is harmless.
--    The first thing it does is take an advisory lock for that network and day, so two runs (the daily cron, and the page
--    refreshing itself when its numbers are an hour old) cannot interleave their delete and insert. Where each metric
--    comes from:
--    - vaults: tenants by `created_at`, by tenants.kind.
--    - mandates, payments (paid and burned), cross-chain payouts (burned), held: the `vault_events` the watcher records
--      from the chain, by `observed_at`, for the segment of the tenant's kind. These read 0 until the watcher runs.
--    - refused_by_code: ledger `decision` entries with verdict `refuse`. refused_by_contract: ledger `payment` entries
--      whose contract answered `refused` and that have a transaction hash: an on-chain refusal. An outcome that is
--      `unknown` or `failed` also carries a code and a hash, and is not a refusal; a spend a dry run stopped has no hash.
--    - model_decisions: ledger `decision` entries that carry attestation evidence.
--    - nearai_tokens_in / _out: what the model reported on each invoice, by `decided_at`.
--    - The Canary tenant's own ledger and invoices are left out of all of the above. The Canary's refusals, attempts,
--      model decisions and tokens come from `canary_attempts` instead, so nothing is counted twice. An attempt of a team
--      member (is_team) is counted under `team`; every other attempt under `canary`. The attempts carry no network, so
--      they count for a network only when that network has a Canary tenant. An attempt still `running` and younger than
--      90 s (the lease) is left out; an older one was killed and is one attempt and nothing else.
-- 3. public_usage_metrics({ network, days? }): security definer, executable by anon, with a pinned search_path. It reads
--    only metrics_daily and the counts of people, and returns that network's totals, the last `days` (default 7, from 1 to
--    90) days, the people (Canary participants as the smaller of the distinct browsers and the distinct addresses of
--    outside attempts, external owners as distinct owner wallets), the pilots (the pilots table has no network), the names
--    of pilots who consented in writing, and when the newest row was written.

-- (1) One set of numbers per network.
alter table public.metrics_daily
  add column network text not null default 'testnet' check (network in ('mainnet', 'testnet'));
alter table public.metrics_daily drop constraint metrics_daily_pkey;
alter table public.metrics_daily add primary key (day, network, segment, metric);

-- (2) One day of one network.
create or replace function public.metrics_compute(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_network text := p->>'network';
  v_day date;
  v_from timestamptz;
  v_to timestamptz;
  v_young timestamptz := now() - interval '90 seconds';
begin
  if v_network is null or v_network not in ('mainnet', 'testnet') then
    raise exception 'invalid_input';
  end if;
  -- Only YYYY-MM-DD: Postgres would also read 'yesterday' or 'infinity' as a date.
  if p->>'day' is not null and p->>'day' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'invalid_input';
  end if;
  begin
    v_day := coalesce((p->>'day')::date, (now() at time zone 'UTC')::date);
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'invalid_input';
  end;
  -- Held until this transaction ends: the second run for the same network and day waits here, then replaces what the
  -- first wrote.
  perform pg_advisory_xact_lock(hashtext('metrics_compute:' || v_network || ':' || v_day::text));
  v_from := v_day::timestamp at time zone 'UTC';
  v_to := (v_day + 1)::timestamp at time zone 'UTC';

  delete from public.metrics_daily where day = v_day and network = v_network;
  insert into public.metrics_daily (day, network, segment, metric, value, computed_at)
  select v_day, v_network, x.segment, x.metric, sum(x.value), now()
  from (
    select t.kind as segment, 'vaults'::text as metric, count(*)::numeric as value
      from public.tenants t
      where t.network = v_network and t.created_at >= v_from and t.created_at < v_to
      group by t.kind
    union all
    select t.kind, m.metric, count(*)::numeric
      from public.vault_events e
      join public.tenants t on t.id = e.tenant_id
      join (values ('mandate_created', 'mandates'), ('spend_paid', 'spends_paid'), ('spend_burned', 'spends_paid'),
                   ('spend_burned', 'cross_chain_payouts'), ('spend_held', 'held')) as m(kind, metric) on m.kind = e.kind
      where t.network = v_network and e.observed_at >= v_from and e.observed_at < v_to
      group by t.kind, m.metric
    union all
    select t.kind, 'refused_by_code', count(*)::numeric
      from public.ledger_entries l join public.tenants t on t.id = l.tenant_id
      where t.network = v_network and t.kind <> 'canary'
        and l.kind = 'decision' and l.body->>'verdict' = 'refuse'
        and l.created_at >= v_from and l.created_at < v_to
      group by t.kind
    union all
    select t.kind, 'refused_by_contract', count(*)::numeric
      from public.ledger_entries l join public.tenants t on t.id = l.tenant_id
      where t.network = v_network and t.kind <> 'canary'
        and l.kind = 'payment' and l.body->'contract'->>'status' = 'refused'
        and coalesce(l.body->'contract'->>'tx_hash', '') <> ''
        and l.created_at >= v_from and l.created_at < v_to
      group by t.kind
    union all
    select t.kind, 'model_decisions', count(*)::numeric
      from public.ledger_entries l join public.tenants t on t.id = l.tenant_id
      where t.network = v_network and t.kind <> 'canary'
        and l.kind = 'decision' and jsonb_typeof(l.body->'evidence') = 'object'
        and l.created_at >= v_from and l.created_at < v_to
      group by t.kind
    union all
    select t.kind, k.metric, sum(k.v)::numeric
      from public.invoices i
      join public.tenants t on t.id = i.tenant_id
      cross join lateral (values ('nearai_tokens_in', i.model_prompt_tokens),
                                 ('nearai_tokens_out', i.model_completion_tokens)) as k(metric, v)
      where t.network = v_network and t.kind <> 'canary' and k.v is not null
        and i.decided_at >= v_from and i.decided_at < v_to
      group by t.kind, k.metric
    union all
    select case when a.is_team then 'team' else 'canary' end, k.metric, sum(k.v)::numeric
      from public.canary_attempts a
      cross join lateral (values
        ('canary_attempts', 1),
        ('canary_raw_attempts', case when a.raw and a.code_status <> 'running' then 1 else 0 end),
        ('refused_by_code', case when a.code_status = 'refused_by_code' then 1 else 0 end),
        ('refused_by_contract', case when a.contract_status = 'refused_by_contract' and a.code_status <> 'running' then 1 else 0 end),
        ('model_decisions', case when a.model_prompt_tokens is not null and a.code_status <> 'running' then 1 else 0 end),
        ('nearai_tokens_in', case when a.code_status <> 'running' then coalesce(a.model_prompt_tokens, 0) else 0 end),
        ('nearai_tokens_out', case when a.code_status <> 'running' then coalesce(a.model_completion_tokens, 0) else 0 end)
      ) as k(metric, v)
      where exists (select 1 from public.tenants c where c.kind = 'canary' and c.network = v_network)
        and a.created_at >= v_from and a.created_at < v_to
        and not (a.code_status = 'running' and a.created_at > v_young)
        and k.v <> 0
      group by 1, 2
  ) x
  group by x.segment, x.metric
  having sum(x.value) > 0;

  return jsonb_build_object('day', v_day, 'network', v_network,
    'rows', (select count(*) from public.metrics_daily where day = v_day and network = v_network));
end $$;

-- (3) What the page reads. It never takes more than counts, and a pilot's name only with its written consent.
create or replace function public.public_usage_metrics(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_network text := p->>'network';
  v_days integer := case when (p->>'days') ~ '^-?[0-9]{1,9}$' then least(greatest((p->>'days')::integer, 1), 90) else 7 end;
  v_today date := (now() at time zone 'UTC')::date;
begin
  if v_network is null or v_network not in ('mainnet', 'testnet') then
    raise exception 'invalid_input';
  end if;
  return jsonb_build_object(
    'network', v_network,
    'totals', coalesce((
      select jsonb_agg(jsonb_build_object('segment', s.segment, 'metric', s.metric, 'value', s.v) order by s.segment, s.metric)
      from (select segment, metric, sum(value) as v from public.metrics_daily
            where network = v_network group by segment, metric) s), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object('segment', s.segment, 'metric', s.metric, 'value', s.v) order by s.segment, s.metric)
      from (select segment, metric, sum(value) as v from public.metrics_daily
            where network = v_network and day > v_today - v_days group by segment, metric) s), '[]'::jsonb),
    -- Outside visitors of the Canary: the smaller of the distinct browser cookies and the distinct addresses, so that a
    -- script that rotates one of them cannot raise the figure. A running row younger than the lease is not counted.
    'canary_participants', case
      when exists (select 1 from public.tenants c where c.kind = 'canary' and c.network = v_network) then (
        select least(count(distinct a.visitor_hash), count(distinct a.ip_hash))
        from public.canary_attempts a
        where not a.is_team and not (a.code_status = 'running' and a.created_at > now() - interval '90 seconds'))
      else 0 end,
    'external_owners', (select count(distinct t.owner_account) from public.tenants t
                        where t.kind = 'external' and t.network = v_network),
    'team_vaults', coalesce((select sum(m.value) from public.metrics_daily m
                             where m.network = v_network and m.segment = 'team' and m.metric = 'vaults'), 0),
    'pilots', coalesce((
      select jsonb_agg(jsonb_build_object('cohort', c.cohort, 'n', c.n) order by c.cohort)
      from (select cohort, count(*) as n from public.pilots group by cohort) c), '[]'::jsonb),
    'pilot_names', coalesce((
      select jsonb_agg(btrim(q.display_name) order by q.consent_at, q.display_name)
      from (select display_name, consent_at from public.pilots
            where consent_name and btrim(coalesce(display_name, '')) <> '') q), '[]'::jsonb),
    'updated_at', (select max(m.computed_at) from public.metrics_daily m where m.network = v_network));
end $$;

revoke execute on function public.metrics_compute(jsonb), public.public_usage_metrics(jsonb)
  from public, anon, authenticated;
grant execute on function public.metrics_compute(jsonb) to service_role;
grant execute on function public.public_usage_metrics(jsonb) to anon, authenticated, service_role;
