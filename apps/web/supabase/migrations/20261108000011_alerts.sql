-- Owner alerts (plan 04 Task 21): a vault's owner and approvers get a message on Telegram or by email when the watcher
-- (0010) records a spend held for approval, a refusal by the contract, a payment, a payout to Base, a failed payout, a key
-- whose gas allowance is low, or a vault short of NEAR. Each message goes out once per subscription and event: the table
-- alerts_sent (0001) is unique on (subscription_id, vault_event_id), and alert_claim is the only way to a send. Nothing
-- here is a grant to anon or authenticated: every function is service_role only, and the server checks the member's role
-- first (lib/auth/guard.ts) or, for the stop and confirm links, a code or a keyed token.
--
-- It resolves 0001's TODO(plan 04 Task 21): a new subscription takes the table's own default kinds, which hold
-- `near_low`, because alert_subscription_create leaves the column out unless the caller gives a valid list. 0001's text is
-- left as it is: a migration production has applied is not edited. The two functions of 0010 that change here are
-- redefined with `create or replace`, copied from 0010 and then changed.
--
-- 1. No flood of history (R2). A vault's first watch records everything it ever did, observed now, and an owner who
--    subscribed before that would get one message per old spend. So tenants.watch_caught_up_at says when a run first
--    finished its cursors (tenant_watch_cursor_set with a cursor; a touch does not count), and a vault_events row is
--    written with initial = true while its tenant has not caught up. alerts_pending sends an initial event only when it
--    is still true: a low key or a low vault, or a hold whose window is still open (an approval is still possible). A
--    vault that already finished a run before this migration is marked as caught up here: a cursor past 0 proves it.
--    A first run that fails part way writes no cursor, so the next run's events are flagged too.
-- 2. The rules of alerts_pending. A subscription gets an event of a kind it chose, observed after the subscription was
--    made and within the last 24 hours, never one it already has (sent, in flight, or failed 3 times). A failed send
--    comes back up to 3 attempts in all; a send that has been `sending` for 2 minutes (a run that died) is taken again,
--    also up to 3 attempts. A Canary vault never alerts `refused_by_contract`: in live mode every visitor attempt makes one.
-- 3. alert_claim fences a send. It takes a row only for a subscription that is still active and confirmed, and answers the
--    attempt number; alert_mark needs that number, so a run that was taken over cannot overwrite the run that has the claim.
-- 4. Codes. A link code (email or Telegram) works once and for 24 hours, then it is gone. alert_link_peek reads one
--    without using it up (the confirmation page names the vault). Two confirmed subscriptions for the same chat or address
--    on one vault would send every alert twice, so the second is switched off as it is confirmed.

alter table public.tenants add column watch_caught_up_at timestamptz;
alter table public.vault_events add column initial boolean not null default false;
-- alerts_pending looks only at the last 24 hours of events.
create index vault_events_observed_at_idx on public.vault_events (observed_at);

-- A vault that already finished a run: a cursor past 0 is the proof (a vault with nothing in it stays null until its next run).
update public.tenants set watch_caught_up_at = watch_last_at
  where watch_last_at is not null
    and (watch_spend_from > 0 or watch_mandate_from > 0 or watch_anchor_from > 0 or watch_ledger_seq > 0);

-- 0010's vault_event_insert, with `initial` set from the tenant's watch_caught_up_at.
create or replace function public.vault_event_insert(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_inserted integer;
begin
  if jsonb_typeof(p->'events') is distinct from 'array' then
    raise exception 'invalid_input';
  end if;
  insert into public.vault_events (tenant_id, event_key, kind, spend_id, mandate_id, anchor_seq, amount, code, tx_hash, payload, initial)
  select x.tenant_id, x.event_key, x.kind, x.spend_id, x.mandate_id, x.anchor_seq, x.amount, x.code, x.tx_hash, x.payload,
         coalesce(t.watch_caught_up_at is null, false)
  from (
    select public.agent_key_uuid(e.v->>'tenant_id') as tenant_id, e.v->>'event_key' as event_key, e.v->>'kind' as kind,
           (e.v->>'spend_id')::bigint as spend_id, (e.v->>'mandate_id')::bigint as mandate_id,
           (e.v->>'anchor_seq')::bigint as anchor_seq, e.v->>'amount' as amount, e.v->>'code' as code,
           e.v->>'tx_hash' as tx_hash,
           case when jsonb_typeof(e.v->'payload') = 'object' then e.v->'payload' else '{}'::jsonb end as payload,
           e.n
    from jsonb_array_elements(p->'events') with ordinality as e(v, n)
  ) x
  left join public.tenants t on t.id = x.tenant_id
  order by x.n
  on conflict (tenant_id, event_key) do nothing;
  get diagnostics v_inserted = row_count;
  return jsonb_build_object('inserted', v_inserted);
end $$;

-- 0010's tenant_watch_cursor_set, which also marks the vault as caught up the first time a cursor is given.
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
      watch_caught_up_at = case
        when p->>'spend_from' is not null or p->>'mandate_from' is not null
             or p->>'anchor_from' is not null or p->>'ledger_seq' is not null
        then coalesce(watch_caught_up_at, now()) else watch_caught_up_at end,
      watch_last_at = now()
    where id = v_tenant
    returning id into v_id;
  return case when v_id is null then null else jsonb_build_object('tenant_id', v_id) end;
end $$;

-- A new subscription: { tenant_id, channel, created_by, target? (email only), kinds? }. Answers { id, link_code }. The
-- link code is 122 random bits. `kinds` is left to the table's default unless it is an array, and an array may hold only the
-- kinds of the vault_events check (a test holds the two lists together). A vault keeps at most 20 live subscriptions; the
-- vault's unconfirmed ones whose link has expired are dropped first, so they do not count.
create or replace function public.alert_subscription_create(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_channel text := p->>'channel';
  v_target text := lower(btrim(p->>'target'));
  v_kinds text[];
  v_code text := replace(gen_random_uuid()::text, '-', '');
  v_result jsonb;
begin
  if v_channel is null or v_channel not in ('telegram', 'email') or coalesce(p->>'created_by', '') = '' then
    raise exception 'invalid_input';
  end if;
  if v_channel = 'email' and (v_target is null or length(v_target) > 254 or v_target !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'invalid_input';
  end if;
  if jsonb_typeof(p->'kinds') = 'array' then
    if jsonb_array_length(p->'kinds') = 0
       or exists (select 1 from jsonb_array_elements(p->'kinds') k
                   where jsonb_typeof(k) is distinct from 'string'
                      or (k #>> '{}') not in ('mandate_created', 'spend_held', 'spend_pending', 'spend_paid', 'spend_burned',
                                              'spend_failed', 'spend_rejected', 'spend_expired', 'refused_by_contract',
                                              'anchor', 'allowance_low', 'near_low')) then
      raise exception 'invalid_input';
    end if;
    v_kinds := array(select jsonb_array_elements_text(p->'kinds'));
  end if;
  delete from public.alert_subscriptions
    where tenant_id = v_tenant and verified_at is null and created_at < now() - interval '24 hours';
  if (select count(*) from public.alert_subscriptions where tenant_id = v_tenant and active) >= 20 then
    raise exception 'limit_reached';
  end if;
  if v_kinds is null then
    insert into public.alert_subscriptions (tenant_id, channel, target, link_code, created_by)
    values (v_tenant, v_channel, case when v_channel = 'email' then v_target end, v_code, p->>'created_by')
    returning jsonb_build_object('id', id, 'link_code', link_code) into v_result;
  else
    insert into public.alert_subscriptions (tenant_id, channel, target, link_code, kinds, created_by)
    values (v_tenant, v_channel, case when v_channel = 'email' then v_target end, v_code, v_kinds, p->>'created_by')
    returning jsonb_build_object('id', id, 'link_code', link_code) into v_result;
  end if;
  return v_result;
end $$;

-- Confirms a subscription by its link code: { channel, link_code, target? (the Telegram chat id) }. The code works once and
-- for 24 hours. Answers { tenant_id, vault_id, kinds, duplicate }, or null for a code that is unknown, used, expired,
-- mistyped, for the other channel or for a subscription that was removed. A Telegram link also takes the chat id, which is
-- the subscription's target. When the same chat (or address) is already confirmed on that vault, this one is consumed and
-- switched off at once (duplicate = true), so the chat is not told everything twice.
create or replace function public.alert_subscription_verify(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_channel text := p->>'channel';
  v_code text := p->>'link_code';
  v_target text := p->>'target';
  s public.alert_subscriptions%rowtype;
  v_duplicate boolean;
begin
  if v_channel is null or v_channel not in ('telegram', 'email') then
    raise exception 'invalid_input';
  end if;
  if v_channel = 'telegram' and coalesce(v_target, '') !~ '^-?[0-9]{1,20}$' then
    raise exception 'invalid_input';
  end if;
  if coalesce(v_code, '') !~ '^[0-9a-f]{32}$' then
    return null;
  end if;
  update public.alert_subscriptions a set
      target = case when a.channel = 'telegram' then v_target else a.target end,
      verified_at = now(),
      link_code = null
    where a.link_code = v_code and a.channel = v_channel and a.active and a.created_at > now() - interval '24 hours'
    returning a.* into s;
  if s.id is null then
    return null;
  end if;
  v_duplicate := exists (
    select 1 from public.alert_subscriptions o
     where o.tenant_id = s.tenant_id and o.channel = s.channel and o.target = s.target
       and o.active and o.verified_at is not null and o.id <> s.id);
  if v_duplicate then
    update public.alert_subscriptions set active = false where id = s.id;
  end if;
  return jsonb_build_object('tenant_id', s.tenant_id,
      'vault_id', (select t.vault_id from public.tenants t where t.id = s.tenant_id),
      'kinds', to_jsonb(s.kinds), 'duplicate', v_duplicate);
end $$;

-- What a link code is for, without using it up: { channel, link_code } -> { vault_id }, or null where verify would refuse.
create or replace function public.alert_link_peek(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('vault_id', t.vault_id)
    from public.alert_subscriptions a join public.tenants t on t.id = a.tenant_id
   where a.link_code = p->>'link_code' and a.channel = p->>'channel' and a.active
     and a.created_at > now() - interval '24 hours'
$$;

-- The console's list: { tenant_id } -> the vault's live subscriptions, oldest first. Live is active and either confirmed or
-- waiting inside its 24 hours. It has the address (the page is for members), and never a link code.
create or replace function public.alert_subscriptions_list(p jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'channel', a.channel, 'target', a.target,
                                                 'kinds', to_jsonb(a.kinds), 'verified_at', a.verified_at,
                                                 'created_at', a.created_at) order by a.created_at, a.id), '[]'::jsonb)
      from public.alert_subscriptions a
     where a.tenant_id = v_tenant and a.active
       and (a.verified_at is not null or a.created_at > now() - interval '24 hours'));
end $$;

-- The member's Remove button: { tenant_id, id }. Only a subscription of that tenant; null when there is none.
create or replace function public.alert_subscription_deactivate(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid := public.agent_key_uuid(p->>'id');
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_done uuid;
begin
  update public.alert_subscriptions set active = false where id = v_id and tenant_id = v_tenant returning id into v_done;
  return case when v_done is null then null else jsonb_build_object('id', v_done) end;
end $$;

-- The email's stop link: { id }. The server has already checked the keyed token. It always answers the same, whether the
-- subscription is there, already off, or was never real, so the answer tells a caller nothing about ids.
create or replace function public.alert_subscription_stop(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
begin
  update public.alert_subscriptions set active = false where id = public.agent_key_uuid(p->>'id');
  return jsonb_build_object('stopped', true);
end $$;

-- Telegram's /stop: { chat_id }. Switches off every active Telegram subscription of that chat and counts the vaults.
create or replace function public.alert_telegram_stop(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_chat text := p->>'chat_id';
  v_stopped integer;
begin
  if coalesce(v_chat, '') !~ '^-?[0-9]{1,20}$' then
    raise exception 'invalid_input';
  end if;
  with off as (
    update public.alert_subscriptions set active = false
      where channel = 'telegram' and target = v_chat and active
    returning tenant_id)
  select count(distinct tenant_id) into v_stopped from off;
  return jsonb_build_object('stopped', v_stopped);
end $$;

-- What is waiting to be sent: { network, limit? (1 to 9999, default 200) } -> one entry per (subscription, event), oldest
-- event first. See the header for the rules. The answer holds the target (an address or a chat id) because dispatch sends to it.
create or replace function public.alerts_pending(p jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_network text := p->>'network';
  v_limit integer;
begin
  if v_network is null or v_network not in ('mainnet', 'testnet') then
    raise exception 'invalid_input';
  end if;
  if p->>'limit' is not null and p->>'limit' !~ '^[1-9][0-9]{0,3}$' then
    raise exception 'invalid_input';
  end if;
  v_limit := coalesce((p->>'limit')::integer, 200);
  return (
    select coalesce(jsonb_agg(x.j order by x.event_id, x.subscription_id), '[]'::jsonb)
    from (
      select e.id as event_id, s.id as subscription_id,
             jsonb_build_object(
               'subscription_id', s.id, 'vault_event_id', e.id, 'channel', s.channel, 'target', s.target,
               'vault_id', t.vault_id,
               'event', jsonb_build_object('kind', e.kind, 'event_key', e.event_key, 'spend_id', e.spend_id,
                                           'mandate_id', e.mandate_id, 'amount', e.amount, 'code', e.code,
                                           'tx_hash', e.tx_hash, 'payload', e.payload, 'observed_at', e.observed_at)) as j
      from public.vault_events e
      join public.tenants t on t.id = e.tenant_id
      join public.alert_subscriptions s on s.tenant_id = e.tenant_id
      left join public.alerts_sent a on a.subscription_id = s.id and a.vault_event_id = e.id
      where t.network = v_network
        and s.active and s.verified_at is not null and e.kind = any (s.kinds)
        and e.observed_at >= s.created_at and e.observed_at > now() - interval '24 hours'
        and (not e.initial
             or e.kind in ('allowance_low', 'near_low')
             or (e.kind = 'spend_held' and case
                   when e.payload->>'held_until_ns' ~ '^[0-9]{1,30}$'
                   then (e.payload->>'held_until_ns')::numeric > extract(epoch from now()) * 1000000000
                   else false end))
        and not (t.kind = 'canary' and e.kind = 'refused_by_contract')
        and (a.id is null
             or (a.attempts < 3 and (a.status = 'failed'
                                     or (a.status = 'sending' and a.updated_at < now() - interval '2 minutes'))))
      order by e.id, s.id
      limit v_limit) x);
end $$;

-- The only way to a send: { subscription_id, vault_event_id } -> { claimed, id, attempt }. A new row is claimed at once. An
-- existing one only when it failed or has been `sending` for 2 minutes, and under 3 attempts, which counts the claim. Two
-- callers cannot both win. A subscription that was removed or never confirmed is not claimed.
create or replace function public.alert_claim(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_subscription uuid := public.agent_key_uuid(p->>'subscription_id');
  v_event bigint;
  v_id bigint;
  v_attempt integer;
begin
  if coalesce(p->>'vault_event_id', '') !~ '^[0-9]{1,15}$' then
    raise exception 'invalid_input';
  end if;
  v_event := (p->>'vault_event_id')::bigint;
  insert into public.alerts_sent as a (subscription_id, vault_event_id, status, attempts)
  select s.id, v_event, 'sending', 1
    from public.alert_subscriptions s
   where s.id = v_subscription and s.active and s.verified_at is not null
  on conflict (subscription_id, vault_event_id) do update
    set status = 'sending', attempts = a.attempts + 1, updated_at = now()
    where a.attempts < 3 and (a.status = 'failed' or (a.status = 'sending' and a.updated_at < now() - interval '2 minutes'))
  returning a.id, a.attempts into v_id, v_attempt;
  return jsonb_build_object('claimed', v_id is not null, 'id', v_id, 'attempt', v_attempt);
end $$;

-- The answer to a claim: { id, attempt, status ('sent' or 'failed'), provider_id?, error? }. Only the claim that is still
-- `sending` at that attempt can be marked, once. Anything else answers null and changes nothing.
create or replace function public.alert_mark(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id bigint;
begin
  if coalesce(p->>'status', '') not in ('sent', 'failed')
     or coalesce(p->>'id', '') !~ '^[0-9]{1,15}$' or coalesce(p->>'attempt', '') !~ '^[0-9]{1,4}$' then
    raise exception 'invalid_input';
  end if;
  update public.alerts_sent set status = p->>'status', provider_id = left(p->>'provider_id', 200),
                               error = left(p->>'error', 500), updated_at = now()
    where id = (p->>'id')::bigint and status = 'sending' and attempts = (p->>'attempt')::integer
  returning id into v_id;
  return case when v_id is null then null else jsonb_build_object('id', v_id, 'status', p->>'status') end;
end $$;

revoke execute on function public.vault_event_insert(jsonb), public.tenant_watch_cursor_set(jsonb),
  public.alert_subscription_create(jsonb), public.alert_subscription_verify(jsonb), public.alert_link_peek(jsonb),
  public.alert_subscriptions_list(jsonb), public.alert_subscription_deactivate(jsonb), public.alert_subscription_stop(jsonb),
  public.alert_telegram_stop(jsonb), public.alerts_pending(jsonb), public.alert_claim(jsonb), public.alert_mark(jsonb)
  from public, anon, authenticated;
grant execute on function public.vault_event_insert(jsonb), public.tenant_watch_cursor_set(jsonb),
  public.alert_subscription_create(jsonb), public.alert_subscription_verify(jsonb), public.alert_link_peek(jsonb),
  public.alert_subscriptions_list(jsonb), public.alert_subscription_deactivate(jsonb), public.alert_subscription_stop(jsonb),
  public.alert_telegram_stop(jsonb), public.alerts_pending(jsonb), public.alert_claim(jsonb), public.alert_mark(jsonb)
  to service_role;
