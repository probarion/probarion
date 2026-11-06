-- Both networks from one deployment (rulings W-NET-R2 and W-NET-R3, task NET). One project, one database and one
-- Telegram bot now serve testnet and mainnet at once, so what was "the one network" is a column. The tenants, the
-- metrics, the Canary attempts and the watcher were already per network (0009, 0010). Four things were not, and this file
-- closes them. Nothing here changes a table; every function is redefined with `create or replace`, its body copied from the
-- migration that defined it last.
--
-- 1. public_canary_feed and public_canary_leaderboard (0008) take a required { network }, 'mainnet' or 'testnet' (anything
--    else, or none, is invalid_input), and count only that network's attempts. An attempt with no network (written before
--    0009 and not attributable) counts for none, as in metrics_compute. The feed stays executable by anon and
--    authenticated, the leaderboard by service_role only, as in 0008. canary_tokens_today stays global on purpose: a NEAR AI
--    token costs the same on both networks, so the daily budget is one budget.
-- 2. alert_claim (0011) refuses a pair whose event belongs to another tenant than the subscription. Today only the dispatch
--    calls it, with pairs from alerts_pending (which joins on the tenant), so no claim changes; the check makes the claim
--    itself safe for the day somebody calls it with a pair of their own. It answers { claimed: false } (no row is
--    written), the same as for any pair that cannot be claimed.
-- 3. alert_subscription_verify (0011) also answers the tenant's network, so the Telegram reply can link to the console of
--    the network the vault is on. One bot serves both networks; its webhook is registered at the default address.
--
-- 4. tenant_register (0008) no longer moves a tenant to another network. It used to write the registration's network over
--    the stored one, so a request at the other address could re-register a vault id, on the strength of the other chain
--    showing a vault at that string with the same owner string, and turn its owner away from the address it belongs to.
--    A tenant's network is fixed (W-NET-R4); a call that names another network raises network_mismatch, after the owner
--    check and before any change. An operator who has to move a tenant does it by hand.
--
-- Grants are repeated at the end, exactly as the functions had them.

-- (1) The Canary's public face, one network at a time.
create or replace function public.public_canary_feed(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_network text := p->>'network';
begin
  if v_network is null or v_network not in ('mainnet', 'testnet') then
    raise exception 'invalid_input';
  end if;
  return (
    select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]'::jsonb) from (
      select a.created_at, jsonb_build_object(
          'created_at', a.created_at, 'techniques', to_jsonb(a.techniques), 'proposal_action', a.proposal_action,
          'code_status', case when a.code_status = 'running' then 'killed' else a.code_status end,
          'code_rule', a.code_rule, 'raw', a.raw, 'raw_skipped_reason', a.raw_skipped_reason,
          'raw_detail', a.raw_detail, 'contract_status', a.contract_status, 'contract_code', a.contract_code,
          'tx_hash', a.tx_hash, 'is_team', a.is_team) as j
      from public.canary_attempts a
      where a.network = v_network
        and not (a.code_status = 'running' and a.created_at > now() - interval '90 seconds')
      order by a.created_at desc
      limit case when (p->>'limit') ~ '^[0-9]{1,9}$' then least(greatest((p->>'limit')::integer, 1), 100) else 50 end) x);
end $$;

create or replace function public.public_canary_leaderboard(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_network text := p->>'network';
begin
  if v_network is null or v_network not in ('mainnet', 'testnet') then
    raise exception 'invalid_input';
  end if;
  return (
    with v as (
      select * from public.canary_attempts a
      where a.network = v_network
        and not (a.code_status = 'running' and a.created_at > now() - interval '90 seconds'))
    select jsonb_build_object(
      'browsers', (select count(distinct visitor_hash) from v where not is_team),
      'addresses', (select count(distinct ip_hash) from v where not is_team),
      'attempts_external', (select count(*) from v where not is_team),
      'attempts_team', (select count(*) from v where is_team),
      'raw_external', (select count(*) from v where raw and not is_team),
      'techniques', coalesce((
        select jsonb_agg(jsonb_build_object('technique', t.technique, 'attempts', t.attempts, 'refused_by_code', t.by_code,
                                            'refused_by_contract', t.by_contract, 'held', t.held) order by t.attempts desc, t.technique)
        from (
          select x.technique, count(*) as attempts,
                 count(*) filter (where a.code_status = 'refused_by_code') as by_code,
                 count(*) filter (where a.contract_status = 'refused_by_contract') as by_contract,
                 count(*) filter (where a.code_status = 'held' or a.contract_status = 'held') as held
          from v a, unnest(a.techniques) as x(technique)
          where not a.is_team group by x.technique) t), '[]'::jsonb),
      'contract_codes', coalesce((
        select jsonb_agg(jsonb_build_object('code', c.contract_code, 'n', c.n) order by c.n desc, c.contract_code)
        from (select contract_code, count(*) as n from v
              where contract_code is not null and contract_status = 'refused_by_contract' and not is_team
              group by contract_code) c), '[]'::jsonb)));
end $$;

-- (2) A claim is for an event of the subscription's own vault.
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
     and exists (select 1 from public.vault_events e where e.id = v_event and e.tenant_id = s.tenant_id)
  on conflict (subscription_id, vault_event_id) do update
    set status = 'sending', attempts = a.attempts + 1, updated_at = now()
    where a.attempts < 3 and ((a.status = 'failed' and a.updated_at < now() - interval '5 minutes' * a.attempts)
                              or (a.status = 'sending' and a.updated_at < now() - interval '2 minutes'))
  returning a.id, a.attempts into v_id, v_attempt;
  return jsonb_build_object('claimed', v_id is not null, 'id', v_id, 'attempt', v_attempt);
end $$;

-- (3) Confirms a subscription by its link code (0011's body), and answers the vault's network as well:
-- { tenant_id, vault_id, network, kinds, duplicate }, or null for a code that is unknown, used, expired, mistyped, for the
-- other channel or for a subscription that was removed.
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
      'network', (select t.network from public.tenants t where t.id = s.tenant_id),
      'kinds', to_jsonb(s.kinds), 'duplicate', v_duplicate);
end $$;

-- (4) Registration: 0008's body, plus the network that cannot change.
create or replace function public.tenant_register(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_vault text := p->>'vault_id';
  v_owner text := p->>'owner_account';
  v_kind text := coalesce(p->>'kind', 'external');
  v_raw jsonb := case when jsonb_typeof(p->'approvers') is null or jsonb_typeof(p->'approvers') = 'null'
                      then '[]'::jsonb else p->'approvers' end;
  v_approvers text[];
  v_id uuid;
  v_existing_owner text;
  v_existing_network text;
  v_inserted boolean := false;
begin
  -- vault_id has the same pattern as tenants.vault_id's check, so a bad one is invalid_input, not a constraint error.
  if v_vault is null or v_vault !~ '^[a-z0-9._-]{2,64}$' or v_owner is null
     or coalesce(p->>'network', '') not in ('mainnet', 'testnet')
     or v_kind not in ('team', 'external', 'canary')
     or jsonb_typeof(v_raw) <> 'array' then
    raise exception 'invalid_input';
  end if;
  -- Only strings (JSON null entries are skipped): an object or a number is not an account id.
  if exists (select 1 from jsonb_array_elements(v_raw) e where jsonb_typeof(e) not in ('string', 'null')) then
    raise exception 'invalid_input';
  end if;
  v_approvers := array(select a from jsonb_array_elements_text(v_raw) as a where a is not null);
  -- Insert first. If the vault is already registered (an earlier call, a double click, or a concurrent call that
  -- committed first) nothing is inserted and we use the existing row, so the second call returns the same tenant
  -- instead of failing on the unique vault_id. Either way the owner must match.
  insert into public.tenants (vault_id, network, kind, display_name, owner_account, proof_public)
  values (v_vault, p->>'network', v_kind, left(coalesce(p->>'display_name', split_part(v_vault, '.', 1)), 80), v_owner,
          v_kind = 'team')
  on conflict (vault_id) do nothing
  returning id, owner_account, network, true into v_id, v_existing_owner, v_existing_network, v_inserted;
  if v_id is null then
    select id, owner_account, network into v_id, v_existing_owner, v_existing_network
      from public.tenants where vault_id = v_vault;
  end if;
  -- The insert was skipped and the row it conflicted with is gone again (deleted by a concurrent transaction). Stop
  -- here: with a NULL id the owner check below is NULL (so it passes) and the member rows would fail on a not-null.
  if v_id is null then
    raise exception 'not_found';
  end if;
  if v_existing_owner <> v_owner then
    raise exception 'owner_mismatch';
  end if;
  -- A tenant's network is fixed once it is registered (W-NET-R4): a vault id on one chain is another account from the
  -- same string on the other. A registration that names another network changes nothing.
  if v_existing_network <> p->>'network' then
    raise exception 'network_mismatch';
  end if;
  -- An existing tenant takes, only from `external`, the kind of this registration. A missing display_name keeps the
  -- stored one. proof_public is left alone, except that a tenant that is (or becomes) the Canary is private. The network
  -- is not touched.
  if not coalesce(v_inserted, false) then
    update public.tenants set
        kind = case when kind = 'external' then v_kind else kind end,
        display_name = left(coalesce(p->>'display_name', display_name), 80),
        proof_public = case when (case when kind = 'external' then v_kind else kind end) = 'canary'
                            then false else proof_public end
      where id = v_id;
  end if;
  insert into public.tenant_members (tenant_id, account_id, role) values (v_id, v_owner, 'owner')
    on conflict (tenant_id, account_id) do update set role = 'owner', promoted_from_viewer = false;
  -- Approvers the chain no longer lists: a promoted viewer goes back to viewer, any other approver is removed.
  update public.tenant_members set role = 'viewer', promoted_from_viewer = false
    where tenant_id = v_id and role = 'approver' and promoted_from_viewer and not (account_id = any (v_approvers));
  delete from public.tenant_members
    where tenant_id = v_id and role = 'approver' and not (account_id = any (v_approvers));
  -- `distinct`: a repeated account would make DO UPDATE touch one row twice. A viewer who is an on-chain approver is
  -- promoted and remembered as such; the owner row is never touched (the owner is filtered out, and only viewers are
  -- updated).
  insert into public.tenant_members as m (tenant_id, account_id, role)
    select distinct v_id, a, 'approver' from unnest(v_approvers) as a where a <> v_owner
    on conflict (tenant_id, account_id) do update set role = 'approver', promoted_from_viewer = true
      where m.role = 'viewer';
  return jsonb_build_object('tenant_id', v_id);
end $$;

-- Grants, as before: the feed is public by design (anon, authenticated, service_role); the leaderboard scans the table, and
-- the claim, the verify and the registration are the server's own (service_role only).
revoke execute on function public.public_canary_feed(jsonb), public.public_canary_leaderboard(jsonb),
  public.alert_claim(jsonb), public.alert_subscription_verify(jsonb), public.tenant_register(jsonb)
  from public, anon, authenticated;
grant execute on function public.public_canary_leaderboard(jsonb), public.alert_claim(jsonb),
  public.alert_subscription_verify(jsonb), public.tenant_register(jsonb) to service_role;
grant execute on function public.public_canary_feed(jsonb) to anon, authenticated, service_role;
