-- Agent and ledger keys (plan 04 Task 10): generated on the server, sealed at rest, activated from what the chain
-- shows, and re-sealed by the OWNER's rotation (scripts/rotate-keys.ts, docs/ops/key-rotation.md).
--
-- Every function here is `(p jsonb) returns jsonb` (Decision D2) except the uuid helper, runs as its caller (security
-- invoker: the server calls them with the service key after its own membership check) and is executable by service_role
-- only (granted at the end, proven in test/db/keys.test.ts). None is a public_* function, and no function anon or
-- authenticated can execute reads secret_ciphertext or secret_nonce: a member reads key metadata through the column
-- grant of 0001, which leaves both sealed columns out.

-- 'removed' (Task 10 ruling): the chain answered, definitively, that the access key is gone (NO_KEY), or the owner
-- discarded a key that was still pending. 'revoked' stays for a key the vault no longer accepts while its access key may
-- still be there. Neither is final (W-T10-R1): a later sync that sees the full activation state again (the exact scoped
-- key, registered) makes the key active again, so a lagging node's NO_KEY never sticks. The one exception is a key the
-- owner discarded (discarded_at, W-T10-R2): a sync never makes it active; only the owner's Keep does, after the same
-- full check. revoked_at is when a key last left 'active' (or was discarded).
alter table public.agent_keys drop constraint agent_keys_status_check;
alter table public.agent_keys add constraint agent_keys_status_check
  check (status in ('pending', 'active', 'revoked', 'removed'));
alter table public.agent_keys add constraint agent_keys_status_dates check (
  (status <> 'active' or activated_at is not null)
  and (status not in ('revoked', 'removed') or revoked_at is not null));
alter table public.agent_keys add constraint agent_keys_key_version_positive check (key_version >= 1);
alter table public.agent_keys add constraint agent_keys_sealed_not_empty
  check (secret_ciphertext <> '' and secret_nonce <> '');

-- What the last sync saw on chain (agent_key_observe). Null = never read. chain_seen is sticky: the key was once
-- registered or had an access key. A key with chain_registered true and chain_has_key false is STUCK: the vault
-- registers it but its access key was never added (the AddKey of add_agent / set_ledger_key is a detached promise,
-- which fails when the vault lacks the NEAR to store the key).
alter table public.agent_keys add column chain_registered boolean;
alter table public.agent_keys add column chain_has_key boolean;
alter table public.agent_keys add column chain_checked_at timestamptz;
alter table public.agent_keys add column chain_seen boolean not null default false;
-- What the last sync saw: the access key is exactly the one the vault adds for this purpose (plain FunctionCall, the
-- vault as receiver, one method). With chain_registered, this is the full activation check (W-T10-R3).
alter table public.agent_keys add column chain_scoped boolean;

-- When the owner discarded the key (W-T10-R2). A discarded key is never made active by a sync, even if it later shows
-- up on chain exactly as the vault adds it: that is the discarded_on_chain state, and only the owner's Keep
-- (agent_key_keep, after the same full check) makes it active.
alter table public.agent_keys add column discarded_at timestamptz;

comment on column public.agent_keys.key_version is
  'Rotation counter: 1 when the key is sealed, +1 each time scripts/rotate-keys.ts re-seals the row. It does not name '
  'the master that sealed the row (a row the live app seals under a new master starts at 1 again), so the rotation '
  'finds which master opens a row by trial decryption: the old one, then the new one.';
comment on column public.agent_keys.revoked_at is 'When the key left active, as revoked or as removed.';
comment on column public.agent_keys.activated_at is
  'When the key FIRST became active. A key made active again (removed/revoked -> active) keeps this date, so an older '
  'key coming back never looks newer than the key that replaced it (W-T10-R2).';

-- A canonical uuid, or invalid_input: a malformed id must fail loudly, never as a cast error or an empty answer.
create or replace function public.agent_key_uuid(v text) returns uuid
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if v is null or v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_input';
  end if;
  return v::uuid;
end $$;

-- A new key, always pending. The secret arrives sealed (secretbox under the agent_keys subkey); this function never
-- sees a plaintext and returns only the row id.
create or replace function public.agent_key_insert(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_label text := coalesce(p->>'label', '');
  v_id uuid;
begin
  if coalesce(p->>'purpose', '') not in ('agent', 'ledger')
     or coalesce(p->>'public_key', '') !~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$'
     or jsonb_typeof(p->'secret_ciphertext') is distinct from 'string' or p->>'secret_ciphertext' = ''
     or jsonb_typeof(p->'secret_nonce') is distinct from 'string' or p->>'secret_nonce' = ''
     or jsonb_typeof(p->'key_version') is distinct from 'number' or (p->>'key_version') !~ '^[1-9][0-9]{0,8}$'
     or octet_length(v_label) > 64
     or coalesce(p->>'created_by', '') = '' then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from public.tenants where id = v_tenant) then
    raise exception 'not_found';
  end if;
  begin
    insert into public.agent_keys (tenant_id, purpose, public_key, secret_ciphertext, secret_nonce, key_version, label,
                                   created_by)
    values (v_tenant, p->>'purpose', p->>'public_key', p->>'secret_ciphertext', p->>'secret_nonce',
            (p->>'key_version')::integer, v_label, p->>'created_by')
    returning id into v_id;
  exception when unique_violation then
    raise exception 'duplicate';
  end;
  return jsonb_build_object('id', v_id);
end $$;

-- A tenant's keys, oldest first, without the sealed columns.
create or replace function public.agent_key_list(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', k.id, 'tenant_id', k.tenant_id, 'purpose', k.purpose, 'public_key', k.public_key, 'label', k.label,
      'status', k.status, 'key_version', k.key_version, 'created_by', k.created_by, 'created_at', k.created_at,
      'activated_at', k.activated_at, 'revoked_at', k.revoked_at, 'chain_registered', k.chain_registered,
      'chain_has_key', k.chain_has_key, 'chain_scoped', k.chain_scoped, 'chain_checked_at', k.chain_checked_at,
      'chain_seen', k.chain_seen, 'discarded_at', k.discarded_at)
      order by k.created_at, k.id), '[]'::jsonb)
  from public.agent_keys k where k.tenant_id = public.agent_key_uuid(p->>'tenant_id')
$$;

-- The sealed secret of the tenant's ledger key: { tenant_id, purpose: 'ledger' }. At most one ledger key is active
-- (agent_keys_one_active_ledger); null when there is none. Any other purpose is invalid_input (W-T10-R3): there is no
-- "the" agent key. A Payables / Canary cycle signs a spend with the agent key its mandate is bound to
-- (agent_key_secret_for). Only the server cycles call these, and they open the secret in memory.
create or replace function public.agent_key_secret(p jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_out jsonb;
begin
  if p->>'purpose' is distinct from 'ledger' then
    raise exception 'invalid_input';
  end if;
  select jsonb_build_object('public_key', k.public_key, 'secret_ciphertext', k.secret_ciphertext,
                            'secret_nonce', k.secret_nonce, 'key_version', k.key_version)
    into v_out
    from public.agent_keys k
    where k.tenant_id = v_tenant and k.purpose = 'ledger' and k.status = 'active'
    order by k.activated_at desc, k.created_at desc, k.id
    limit 1;
  return v_out;
end $$;

-- The sealed secret of exactly this AGENT key: { tenant_id, public_key }, and only while it is active for this tenant
-- (W-T10-R2). Null otherwise (not this tenant's, not active, unknown, or not an agent key: a mandate's agent_pk equal to
-- the ledger key never hands out the ledger secret, W-T10-R3). A malformed public key is invalid_input.
create or replace function public.agent_key_secret_for(p jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_out jsonb;
begin
  if coalesce(p->>'public_key', '') !~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    raise exception 'invalid_input';
  end if;
  select jsonb_build_object('public_key', k.public_key, 'purpose', k.purpose, 'secret_ciphertext', k.secret_ciphertext,
                            'secret_nonce', k.secret_nonce, 'key_version', k.key_version)
    into v_out
    from public.agent_keys k
    where k.tenant_id = v_tenant and k.public_key = p->>'public_key' and k.purpose = 'agent' and k.status = 'active';
  return v_out;
end $$;

-- The one way a key becomes active (both agent_key_set_status and agent_key_keep use it). A ledger key retires any other
-- active ledger key of the tenant in the same statement (set_ledger_key deleted it on chain). activated_at keeps the
-- FIRST activation date. Not a (p jsonb) entry point: no caller but these two functions.
create or replace function public.agent_key_make_active(p_tenant uuid, p_id uuid, p_purpose text) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  if p_purpose = 'ledger' then
    update public.agent_keys set status = 'revoked', revoked_at = now()
      where tenant_id = p_tenant and purpose = 'ledger' and status = 'active' and id <> p_id;
  end if;
  update public.agent_keys set
      status = 'active', activated_at = coalesce(activated_at, now()), revoked_at = null, discarded_at = null
    where id = p_id and tenant_id = p_tenant;
end $$;

-- Compare-and-set: { tenant_id, id, from, status }. The transitions are pending -> active, active -> revoked, active ->
-- removed, and revoked/removed -> active (anything else is invalid_input). The caller (syncKeyStatuses) asks for
-- "-> active" only after the full activation check on exact chain state. A row whose status is no longer `from` is
-- left as it is and answered with changed = false (another sync got there first). A discarded key is never made active
-- here (discarded: only agent_key_keep does that). Activation goes through agent_key_make_active: a ledger key retires
-- the other active one, and activated_at keeps the first activation date (W-T10-R2). (Should a stale read retire the
-- true ledger key, the next sync activates it again the same way.)
create or replace function public.agent_key_set_status(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_id uuid := public.agent_key_uuid(p->>'id');
  v_from text := p->>'from';
  v_to text := p->>'status';
  v_purpose text;
  v_status text;
  v_discarded timestamptz;
begin
  if coalesce(v_from, '') || '>' || coalesce(v_to, '')
     not in ('pending>active', 'active>revoked', 'active>removed', 'revoked>active', 'removed>active') then
    raise exception 'invalid_input';
  end if;
  select k.purpose, k.status, k.discarded_at into v_purpose, v_status, v_discarded
    from public.agent_keys k where k.id = v_id and k.tenant_id = v_tenant
    for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_status <> v_from then
    return jsonb_build_object('id', v_id, 'status', v_status, 'changed', false);
  end if;
  if v_to = 'active' then
    if v_discarded is not null then
      raise exception 'discarded';
    end if;
    perform public.agent_key_make_active(v_tenant, v_id, v_purpose);
  else
    update public.agent_keys set status = v_to, revoked_at = now() where id = v_id;
  end if;
  return jsonb_build_object('id', v_id, 'status', v_to, 'changed', true);
end $$;

-- What one sync saw: { tenant_id, keys: [{ id, registered, has_key, scoped }] }, all booleans, for keys of this tenant only
-- (an id of another tenant is not_found, and then nothing of the batch is written).
create or replace function public.agent_key_observe(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  r jsonb;
  v_rows integer;
  n integer := 0;
begin
  if jsonb_typeof(p->'keys') is distinct from 'array' then
    raise exception 'invalid_input';
  end if;
  for r in select value from jsonb_array_elements(p->'keys') loop
    if jsonb_typeof(r->'registered') is distinct from 'boolean'
       or jsonb_typeof(r->'has_key') is distinct from 'boolean'
       or jsonb_typeof(r->'scoped') is distinct from 'boolean' then
      raise exception 'invalid_input';
    end if;
    update public.agent_keys set
        chain_registered = (r->>'registered')::boolean,
        chain_has_key = (r->>'has_key')::boolean,
        chain_scoped = (r->>'scoped')::boolean,
        chain_checked_at = now(),
        chain_seen = chain_seen or (r->>'registered')::boolean or (r->>'has_key')::boolean
      where id = public.agent_key_uuid(r->>'id') and tenant_id = v_tenant;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'not_found';
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('observed', n);
end $$;

-- A recent unused pending key to hand out again instead of generating another (W-T10-R1): { tenant_id, purpose, label,
-- max_age_seconds }. Pending, never seen on chain, younger than max_age_seconds; the newest wins and takes the new
-- label. Null when there is none.
create or replace function public.agent_key_reuse_pending(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_label text := coalesce(p->>'label', '');
  v_out jsonb;
begin
  if coalesce(p->>'purpose', '') not in ('agent', 'ledger') or octet_length(v_label) > 64
     or jsonb_typeof(p->'max_age_seconds') is distinct from 'number'
     or (p->>'max_age_seconds') !~ '^[1-9][0-9]{0,8}$' then
    raise exception 'invalid_input';
  end if;
  update public.agent_keys k set label = v_label
    where k.id = (
      select c.id from public.agent_keys c
      where c.tenant_id = v_tenant and c.purpose = p->>'purpose' and c.status = 'pending' and not c.chain_seen
        and c.created_at > now() - make_interval(secs => (p->>'max_age_seconds')::integer)
      order by c.created_at desc, c.id
      limit 1
      for update)
    returning jsonb_build_object('id', k.id, 'public_key', k.public_key) into v_out;
  return v_out;
end $$;

-- The owner discards a key that is still pending: pending -> removed, marked discarded (W-T10-R1, W-T10-R2). Any other
-- status is left as it is and answered with changed = false. A sync never makes a discarded key active again; if it
-- shows up on chain, the owner either removes it there or keeps it (agent_key_keep).
create or replace function public.agent_key_discard(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_id uuid := public.agent_key_uuid(p->>'id');
  v_status text;
begin
  select k.status into v_status from public.agent_keys k where k.id = v_id and k.tenant_id = v_tenant for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_status <> 'pending' then
    return jsonb_build_object('id', v_id, 'status', v_status, 'changed', false);
  end if;
  update public.agent_keys set status = 'removed', revoked_at = now(), discarded_at = now() where id = v_id;
  return jsonb_build_object('id', v_id, 'status', 'removed', 'changed', true);
end $$;

-- The owner keeps a discarded key that is on chain after all (W-T10-R2): { tenant_id, id }. The caller (keepKey) asks
-- only after the same full activation check a sync runs. Clears the discard marker and makes the key active through
-- agent_key_make_active. A key that is not discarded, or already active, is answered with changed = false.
create or replace function public.agent_key_keep(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_id uuid := public.agent_key_uuid(p->>'id');
  v_purpose text;
  v_status text;
  v_discarded timestamptz;
begin
  select k.purpose, k.status, k.discarded_at into v_purpose, v_status, v_discarded
    from public.agent_keys k where k.id = v_id and k.tenant_id = v_tenant
    for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_discarded is null or v_status = 'active' then
    return jsonb_build_object('id', v_id, 'status', v_status, 'changed', false);
  end if;
  perform public.agent_key_make_active(v_tenant, v_id, v_purpose);
  return jsonb_build_object('id', v_id, 'status', 'active', 'changed', true);
end $$;

-- Every active key of every tenant, with its vault, for the watcher's allowance check (Task 20). No sealed column.
create or replace function public.agent_keys_active_all(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('tenant_id', k.tenant_id, 'vault_id', t.vault_id,
      'public_key', k.public_key, 'purpose', k.purpose) order by t.vault_id, k.created_at, k.id), '[]'::jsonb)
  from public.agent_keys k join public.tenants t on t.id = k.tenant_id
  where k.status = 'active'
$$;

-- Rotation, step 1: every sealed value under the master. Agent keys in every status (a revoked key is still a secret),
-- and every invoice that holds content (retained ones: 0001's invoices_retention check).
create or replace function public.key_rotation_rows(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'agent_keys', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'secret_ciphertext', k.secret_ciphertext,
        'secret_nonce', k.secret_nonce, 'key_version', k.key_version) order by k.id) from public.agent_keys k),
        '[]'::jsonb),
    'invoices', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'tenant_id', i.tenant_id,
        'content_ciphertext', i.content_ciphertext, 'content_nonce', i.content_nonce) order by i.id)
        from public.invoices i where i.content_ciphertext is not null), '[]'::jsonb))
$$;

-- Rotation, step 2: write a batch the caller has already re-sealed AND verified under the new master. All or nothing:
-- each item is compare-and-set on the ciphertext it was read with (`old_ciphertext`), an agent key's key_version must go
-- up, and any item that does not match exactly one row (changed since it was read, gone, or twice in the batch) raises
-- rotation_conflict, which rolls back every update of the call.
create or replace function public.key_rotation_apply(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  r jsonb;
  v_rows integer;
  n_keys integer := 0;
  n_invoices integer := 0;
begin
  if jsonb_typeof(p->'agent_keys') is distinct from 'array' or jsonb_typeof(p->'invoices') is distinct from 'array' then
    raise exception 'invalid_input';
  end if;
  for r in select value from jsonb_array_elements(p->'agent_keys') loop
    if coalesce(r->>'old_ciphertext', '') = '' or coalesce(r->>'ciphertext', '') = '' or coalesce(r->>'nonce', '') = ''
       or jsonb_typeof(r->'key_version') is distinct from 'number' or (r->>'key_version') !~ '^[1-9][0-9]{0,8}$' then
      raise exception 'invalid_input';
    end if;
    update public.agent_keys set
        secret_ciphertext = r->>'ciphertext', secret_nonce = r->>'nonce', key_version = (r->>'key_version')::integer
      where id = public.agent_key_uuid(r->>'id') and secret_ciphertext = r->>'old_ciphertext'
        and key_version < (r->>'key_version')::integer;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'rotation_conflict';
    end if;
    n_keys := n_keys + 1;
  end loop;
  for r in select value from jsonb_array_elements(p->'invoices') loop
    if coalesce(r->>'old_ciphertext', '') = '' or coalesce(r->>'ciphertext', '') = ''
       or coalesce(r->>'nonce', '') = '' then
      raise exception 'invalid_input';
    end if;
    update public.invoices set content_ciphertext = r->>'ciphertext', content_nonce = r->>'nonce'
      where id = public.agent_key_uuid(r->>'id') and content_ciphertext = r->>'old_ciphertext';
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'rotation_conflict';
    end if;
    n_invoices := n_invoices + 1;
  end loop;
  return jsonb_build_object('agent_keys', n_keys, 'invoices', n_invoices);
end $$;

revoke execute on function
  public.agent_key_uuid(text), public.agent_key_insert(jsonb), public.agent_key_list(jsonb),
  public.agent_key_secret(jsonb), public.agent_key_set_status(jsonb), public.agent_key_observe(jsonb),
  public.agent_key_reuse_pending(jsonb), public.agent_key_discard(jsonb), public.agent_key_keep(jsonb),
  public.agent_key_secret_for(jsonb), public.agent_key_make_active(uuid, uuid, text), public.agent_keys_active_all(jsonb),
  public.key_rotation_rows(jsonb), public.key_rotation_apply(jsonb)
  from public, anon, authenticated;
grant execute on function
  public.agent_key_uuid(text), public.agent_key_insert(jsonb), public.agent_key_list(jsonb),
  public.agent_key_secret(jsonb), public.agent_key_set_status(jsonb), public.agent_key_observe(jsonb),
  public.agent_key_reuse_pending(jsonb), public.agent_key_discard(jsonb), public.agent_key_keep(jsonb),
  public.agent_key_secret_for(jsonb), public.agent_key_make_active(uuid, uuid, text), public.agent_keys_active_all(jsonb),
  public.key_rotation_rows(jsonb), public.key_rotation_apply(jsonb)
  to service_role;
