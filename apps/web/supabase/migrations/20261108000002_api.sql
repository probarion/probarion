-- Rate limits (interfaces v2 §13), tenant leases, tenant registration and membership. Service role only.
--
-- Every function here is `(p jsonb) returns jsonb` (Decision D2) and runs as its caller (security invoker): the
-- server calls them with the service key, which bypasses RLS, after its own membership check. None is executable by
-- anon or authenticated (granted explicitly to service_role at the end), so the public key cannot reach them.
--
-- rate_limits rows are never deleted by these functions. TODO(plan 04 Task 19, the metrics cron): it prunes them with
-- `delete from public.rate_limits where window_start < now() - interval '1 day'` (F29, D12). Nothing is scheduled here.

-- Fixed-window counter. One call is one hit: `allowed` is false once more than `max` hits land inside `window_seconds`
-- of the window's first hit. A blocked hit still counts but never moves `window_start`, so blocking cannot extend a
-- window. R8 (Task 5) burns an auth nonce with this: `max = 1`, so the first use passes and any replay is refused.
create or replace function public.rate_limit_take(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_bucket text := p->>'bucket';
  v_max integer := (p->>'max')::integer;
  v_window integer := (p->>'window_seconds')::integer;
  v_now timestamptz := coalesce((p->>'now')::timestamptz, now());
  v_start timestamptz;
  v_count integer;
begin
  -- 200 is the table's own limit on bucket; checking it here gives invalid_input instead of a raw check violation.
  if v_bucket is null or v_max is null or v_window is null or v_max < 1 or v_window < 1
     or length(v_bucket) > 200 then
    raise exception 'invalid_input';
  end if;
  insert into public.rate_limits as r (bucket, window_start, count)
  values (v_bucket, v_now, 1)
  on conflict (bucket) do update set
    window_start = case when r.window_start <= v_now - make_interval(secs => v_window) then v_now else r.window_start end,
    count = case when r.window_start <= v_now - make_interval(secs => v_window) then 1 else r.count + 1 end
  returning r.window_start, r.count into v_start, v_count;
  return jsonb_build_object(
    'allowed', v_count <= v_max,
    'remaining', greatest(v_max - v_count, 0),
    'reset_at', v_start + make_interval(secs => v_window));
end $$;

-- Per-tenant lease: serialises Payables / Canary cycles so the ledger never forks. A held lease expires on its own.
--
-- The lease is also a FENCE (W-T3-R1). `until` is the instant the lease runs out, and it is unique to this grant: a
-- later grant starts at or after the earlier one's `until` and runs at least a second, so its `until` is always larger.
-- tenant_release only clears the lease whose `until` it is given back. Without that, a worker that overran its lease
-- (A) would, on finishing, clear the lease its successor (B) holds, and a third worker (C) could start while B still
-- runs. The `until` is returned as the exact text the database wrote, to be passed back unchanged.
--
-- tenant_id must be a canonical uuid: anything else is invalid_input, not a cast error.
create or replace function public.tenant_lease(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant_text text := p->>'tenant_id';
  v_kind text := p->>'kind';
  v_secs integer := coalesce((p->>'seconds')::integer, 90);
  v_now timestamptz := coalesce((p->>'now')::timestamptz, now());
  v_until timestamptz;
  v_ok boolean;
begin
  if v_tenant_text is null
     or v_tenant_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_secs < 1 then
    raise exception 'invalid_input';
  end if;
  v_until := v_now + make_interval(secs => v_secs);
  if v_kind = 'process' then
    update public.tenants set process_lease_until = v_until
      where id = v_tenant_text::uuid and (process_lease_until is null or process_lease_until <= v_now)
      returning true into v_ok;
  elsif v_kind = 'watch' then
    update public.tenants set watch_lease_until = v_until
      where id = v_tenant_text::uuid and (watch_lease_until is null or watch_lease_until <= v_now)
      returning true into v_ok;
  else
    raise exception 'invalid_input';
  end if;
  return jsonb_build_object('acquired', coalesce(v_ok, false), 'until', case when v_ok then v_until end);
end $$;

-- Releases the lease only if it is still the one `until` names (see tenant_lease). `released` is false when the lease
-- was already released, or has been taken over since: either way the caller must not assume it still holds anything.
-- `until` is required. A release without it would be an unfenced "clear whatever is there", which is the bug.
create or replace function public.tenant_release(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant_text text := p->>'tenant_id';
  v_kind text := p->>'kind';
  v_until timestamptz;
  v_released boolean;
begin
  if v_tenant_text is null
     or v_tenant_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(v_kind, '') not in ('process', 'watch')
     or (p->>'until') is null then
    raise exception 'invalid_input';
  end if;
  begin
    v_until := (p->>'until')::timestamptz;
  exception when data_exception then
    raise exception 'invalid_input';
  end;
  if v_kind = 'process' then
    update public.tenants set process_lease_until = null
      where id = v_tenant_text::uuid and process_lease_until = v_until
      returning true into v_released;
  else
    update public.tenants set watch_lease_until = null
      where id = v_tenant_text::uuid and watch_lease_until = v_until
      returning true into v_released;
  end if;
  return jsonb_build_object('released', coalesce(v_released, false));
end $$;

-- Registers a vault (idempotent) and syncs its members: the owner is always `owner`, and the `approver` rows mirror
-- the vault's on-chain approver list. A vault is never re-registered under a different owner.
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
  values (v_vault, p->>'network', v_kind, left(coalesce(p->>'display_name', ''), 80), v_owner, v_kind in ('team', 'canary'))
  on conflict (vault_id) do nothing
  returning id, owner_account into v_id, v_existing_owner;
  if v_id is null then
    select id, owner_account into v_id, v_existing_owner from public.tenants where vault_id = v_vault;
  end if;
  if v_existing_owner <> v_owner then
    raise exception 'owner_mismatch';
  end if;
  insert into public.tenant_members (tenant_id, account_id, role) values (v_id, v_owner, 'owner')
    on conflict (tenant_id, account_id) do update set role = 'owner';
  delete from public.tenant_members
    where tenant_id = v_id and role = 'approver' and not (account_id = any (v_approvers));
  -- `distinct`: a repeated account would make DO UPDATE touch one row twice. A viewer who is an on-chain approver is
  -- promoted; the owner row is never touched (the owner is filtered out above, and only viewers are updated).
  insert into public.tenant_members as m (tenant_id, account_id, role)
    select distinct v_id, a, 'approver' from unnest(v_approvers) as a where a <> v_owner
    on conflict (tenant_id, account_id) do update set role = 'approver' where m.role = 'viewer';
  return jsonb_build_object('tenant_id', v_id);
end $$;

create or replace function public.member_tenants(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'tenant_id', t.id, 'vault_id', t.vault_id, 'network', t.network, 'kind', t.kind,
      'display_name', t.display_name, 'role', m.role) order by t.created_at), '[]'::jsonb)
  from public.tenant_members m join public.tenants t on t.id = m.tenant_id
  where m.account_id = p->>'account'
$$;

create or replace function public.member_role(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
      'tenant_id', t.id, 'vault_id', t.vault_id, 'network', t.network, 'kind', t.kind,
      'display_name', t.display_name, 'owner_account', t.owner_account,
      'zero_retention', t.zero_retention, 'proof_public', t.proof_public, 'role', m.role)
  from public.tenants t join public.tenant_members m on m.tenant_id = t.id
  where t.vault_id = p->>'vault_id' and m.account_id = p->>'account'
$$;

create or replace function public.tenant_settings_set(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant_text text := p->>'tenant_id';
  v_zero boolean;
  v_public boolean;
begin
  if v_tenant_text is null
     or v_tenant_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_input';
  end if;
  update public.tenants set
      zero_retention = coalesce((p->>'zero_retention')::boolean, zero_retention),
      proof_public = coalesce((p->>'proof_public')::boolean, proof_public)
    where id = v_tenant_text::uuid
    returning zero_retention, proof_public into v_zero, v_public;
  if v_zero is null then
    raise exception 'not_found';
  end if;
  return jsonb_build_object('zero_retention', v_zero, 'proof_public', v_public);
end $$;

create or replace function public.tenant_by_vault(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('tenant_id', t.id, 'vault_id', t.vault_id, 'network', t.network, 'kind', t.kind,
      'owner_account', t.owner_account, 'zero_retention', t.zero_retention, 'proof_public', t.proof_public,
      'display_name', t.display_name)
  from public.tenants t where t.vault_id = p->>'vault_id'
$$;

-- service_role only. (0001's default privileges already leave a new function to service_role; this states it.)
revoke execute on function
  public.rate_limit_take(jsonb), public.tenant_lease(jsonb), public.tenant_release(jsonb), public.tenant_register(jsonb),
  public.member_tenants(jsonb), public.member_role(jsonb), public.tenant_settings_set(jsonb), public.tenant_by_vault(jsonb)
  from public, anon, authenticated;
grant execute on function
  public.rate_limit_take(jsonb), public.tenant_lease(jsonb), public.tenant_release(jsonb), public.tenant_register(jsonb),
  public.member_tenants(jsonb), public.member_role(jsonb), public.tenant_settings_set(jsonb), public.tenant_by_vault(jsonb)
  to service_role;
