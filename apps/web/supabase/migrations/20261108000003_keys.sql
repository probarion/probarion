-- Agent and ledger keys (plan 04 Task 10): generated on the server, sealed at rest, activated from what the chain
-- shows, and re-sealed by the OWNER's rotation (scripts/rotate-keys.ts, docs/ops/key-rotation.md).
--
-- Every function here is `(p jsonb) returns jsonb` (Decision D2) except the uuid helper, runs as its caller (security
-- invoker: the server calls them with the service key after its own membership check) and is executable by service_role
-- only (granted at the end, proven in test/db/keys.test.ts). None is a public_* function, and no function anon or
-- authenticated can execute reads secret_ciphertext or secret_nonce: a member reads key metadata through the column
-- grant of 0001, which leaves both sealed columns out.

-- 'removed' (Task 10 ruling): the chain answered, definitively, that the access key is gone (NO_KEY). 'revoked' stays for
-- a key the vault no longer accepts while its access key may still be there. revoked_at is when a key left 'active'
-- for either of the two.
alter table public.agent_keys drop constraint agent_keys_status_check;
alter table public.agent_keys add constraint agent_keys_status_check
  check (status in ('pending', 'active', 'revoked', 'removed'));
alter table public.agent_keys add constraint agent_keys_status_dates check (
  (status <> 'active' or activated_at is not null)
  and (status not in ('revoked', 'removed') or revoked_at is not null));
alter table public.agent_keys add constraint agent_keys_key_version_positive check (key_version >= 1);
alter table public.agent_keys add constraint agent_keys_sealed_not_empty
  check (secret_ciphertext <> '' and secret_nonce <> '');

comment on column public.agent_keys.key_version is
  'Rotation counter: 1 when the key is sealed, +1 each time scripts/rotate-keys.ts re-seals the row. It does not name '
  'the master that sealed the row (a row the live app seals under a new master starts at 1 again), so the rotation '
  'finds which master opens a row by trial decryption: the old one, then the new one.';
comment on column public.agent_keys.revoked_at is 'When the key left active, as revoked or as removed.';

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
      'activated_at', k.activated_at, 'revoked_at', k.revoked_at) order by k.created_at, k.id), '[]'::jsonb)
  from public.agent_keys k where k.tenant_id = public.agent_key_uuid(p->>'tenant_id')
$$;

-- The sealed secret of the tenant's active key for a purpose: the most recently activated agent key, or THE ledger key
-- (at most one is active, agent_keys_one_active_ledger). Null when there is none. Only the server cycles (Payables,
-- Canary) call it, and they open the secret in memory.
create or replace function public.agent_key_secret(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('public_key', k.public_key, 'secret_ciphertext', k.secret_ciphertext,
                            'secret_nonce', k.secret_nonce, 'key_version', k.key_version)
  from public.agent_keys k
  where k.tenant_id = public.agent_key_uuid(p->>'tenant_id') and k.purpose = p->>'purpose' and k.status = 'active'
  order by k.activated_at desc, k.created_at desc, k.id
  limit 1
$$;

-- Compare-and-set: { tenant_id, id, from, status }. Only pending -> active, active -> revoked and active -> removed exist
-- (anything else is invalid_input); revoked and removed are final. A row whose status is no longer `from` is left as it
-- is and answered with changed = false (another sync got there first). Activating a ledger key retires any other active
-- ledger key of the tenant in the same statement: set_ledger_key deleted it on chain.
create or replace function public.agent_key_set_status(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_id uuid := public.agent_key_uuid(p->>'id');
  v_from text := p->>'from';
  v_to text := p->>'status';
  v_purpose text;
  v_status text;
begin
  if coalesce(v_from, '') || '>' || coalesce(v_to, '') not in ('pending>active', 'active>revoked', 'active>removed') then
    raise exception 'invalid_input';
  end if;
  select k.purpose, k.status into v_purpose, v_status
    from public.agent_keys k where k.id = v_id and k.tenant_id = v_tenant
    for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_status <> v_from then
    return jsonb_build_object('id', v_id, 'status', v_status, 'changed', false);
  end if;
  if v_to = 'active' and v_purpose = 'ledger' then
    update public.agent_keys set status = 'revoked', revoked_at = now()
      where tenant_id = v_tenant and purpose = 'ledger' and status = 'active' and id <> v_id;
  end if;
  update public.agent_keys set
      status = v_to,
      activated_at = case when v_to = 'active' then now() else activated_at end,
      revoked_at = case when v_to in ('revoked', 'removed') then now() else revoked_at end
    where id = v_id;
  return jsonb_build_object('id', v_id, 'status', v_to, 'changed', true);
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
  public.agent_key_secret(jsonb), public.agent_key_set_status(jsonb), public.agent_keys_active_all(jsonb),
  public.key_rotation_rows(jsonb), public.key_rotation_apply(jsonb)
  from public, anon, authenticated;
grant execute on function
  public.agent_key_uuid(text), public.agent_key_insert(jsonb), public.agent_key_list(jsonb),
  public.agent_key_secret(jsonb), public.agent_key_set_status(jsonb), public.agent_keys_active_all(jsonb),
  public.key_rotation_rows(jsonb), public.key_rotation_apply(jsonb)
  to service_role;
