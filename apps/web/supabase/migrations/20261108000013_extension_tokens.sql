-- The browser extension's connections (plan 06 Task E1a; spec 2026-11-06-probarion-chrome-extension-design.md §4.1-4.2).
--
-- A member connects the Probarion extension from /extension, signed in with a wallet. The server mints a token for that
-- account on that network and hands it to the extension once: by a message the page posts to its own window, or in
-- exchange for an 8-character pairing code the person types into the extension. Only the token's sha256 is stored. A
-- token is valid on the network it was minted on, for 30 days, until it is revoked; an account keeps at most 5 live
-- tokens per network (a sixth ends the oldest). A code lives 10 minutes and is used once; an account holds at most 3
-- open codes per network.
--
-- What a token can do is decided in the app (lib/ext): read the account's waiting items and queue an invoice. It never
-- pays: queueing is a path of its own (migration 0014), and paying still needs the owner's wallet-signed Confirm (0007).
--
-- No member reads these tables (RLS on, no policy, no grant). The functions take (p jsonb), return jsonb, are security
-- definer with a pinned search_path, and are executable by the service role only.

create table public.extension_tokens (
  id uuid primary key default gen_random_uuid(),
  account_id text not null check (account_id <> '' and length(account_id) <= 64),
  network text not null check (network in ('mainnet', 'testnet')),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  hint text not null check (hint ~ '^[A-Za-z0-9_-]{4}$'),
  label text not null check (length(label) between 1 and 64),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index extension_tokens_account on public.extension_tokens (account_id, network, created_at desc);

create table public.extension_pair_codes (
  code_sha256 text primary key check (code_sha256 ~ '^[0-9a-f]{64}$'),
  account_id text not null check (account_id <> '' and length(account_id) <= 64),
  network text not null check (network in ('mainnet', 'testnet')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index extension_pair_codes_account on public.extension_pair_codes (account_id, network, created_at desc);

alter table public.extension_tokens enable row level security;
alter table public.extension_pair_codes enable row level security;
revoke all on public.extension_tokens, public.extension_pair_codes from anon, authenticated;
-- MAINTAIN (PostgreSQL 17+): the service key does not need it on these tables either (as 0001 does for the others).
do $$ begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.extension_tokens, public.extension_pair_codes from service_role';
  end if;
end $$;

-- { account_id, network, token_sha256, hint, label }: a token alive 30 days. A sixth live token of the account on the
-- network ends the oldest. Answers { id, expires_at }.
create or replace function public.ext_token_mint(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_account text := p->>'account_id';
  v_network text := p->>'network';
  v_row public.extension_tokens;
begin
  if coalesce(v_account, '') = '' or length(v_account) > 64
     or coalesce(v_network, '') not in ('mainnet', 'testnet')
     or coalesce(p->>'token_sha256', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p->>'hint', '') !~ '^[A-Za-z0-9_-]{4}$'
     or coalesce(length(p->>'label'), 0) not between 1 and 64 then
    raise exception 'invalid_input';
  end if;
  -- One mint at a time per account and network, so that two at once cannot both keep a sixth live token.
  perform pg_advisory_xact_lock(hashtextextended('probarion/ext/token/' || v_account || '/' || v_network, 0));
  insert into public.extension_tokens (account_id, network, token_sha256, hint, label, expires_at)
  values (v_account, v_network, p->>'token_sha256', p->>'hint', p->>'label', now() + interval '30 days')
  returning * into v_row;
  update public.extension_tokens set revoked_at = now()
    where id in (
      select t.id from public.extension_tokens t
      where t.account_id = v_account and t.network = v_network and t.revoked_at is null and t.expires_at > now()
      order by t.created_at desc, t.id desc
      offset 5);
  return jsonb_build_object('id', v_row.id, 'expires_at', v_row.expires_at);
end $$;

-- { token_sha256, network }: the live token with this hash on this network, or null. Records the use at most once a
-- minute. Answers { id, account_id, network, expires_at } or null.
create or replace function public.ext_token_use(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.extension_tokens;
begin
  if coalesce(p->>'token_sha256', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p->>'network', '') not in ('mainnet', 'testnet') then
    raise exception 'invalid_input';
  end if;
  select t.* into v_row from public.extension_tokens t
    where t.token_sha256 = p->>'token_sha256' and t.network = p->>'network'
      and t.revoked_at is null and t.expires_at > now();
  if not found then
    return 'null'::jsonb;
  end if;
  if v_row.last_used_at is null or v_row.last_used_at < now() - interval '1 minute' then
    update public.extension_tokens set last_used_at = now() where id = v_row.id;
  end if;
  return jsonb_build_object('id', v_row.id, 'account_id', v_row.account_id, 'network', v_row.network,
                            'expires_at', v_row.expires_at);
end $$;

-- { account_id, network }: the account's live tokens on the network, newest first, never their hashes.
create or replace function public.ext_token_list(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if coalesce(p->>'account_id', '') = '' or coalesce(p->>'network', '') not in ('mainnet', 'testnet') then
    raise exception 'invalid_input';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'hint', t.hint, 'label', t.label,
               'created_at', t.created_at, 'last_used_at', t.last_used_at, 'expires_at', t.expires_at)
             order by t.created_at desc, t.id desc), '[]'::jsonb)
    from public.extension_tokens t
    where t.account_id = p->>'account_id' and t.network = p->>'network'
      and t.revoked_at is null and t.expires_at > now());
end $$;

-- { account_id, network, id }: ends one of the account's own tokens. Answers { revoked }.
create or replace function public.ext_token_revoke(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if coalesce(p->>'account_id', '') = '' or coalesce(p->>'network', '') not in ('mainnet', 'testnet')
     or coalesce(p->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_input';
  end if;
  update public.extension_tokens set revoked_at = now()
    where id = (p->>'id')::uuid and account_id = p->>'account_id' and network = p->>'network'
      and revoked_at is null
    returning id into v_id;
  return jsonb_build_object('revoked', v_id is not null);
end $$;

-- { account_id, network, code_sha256 }: a pairing code alive 10 minutes. Sweeps used and expired codes, and keeps the
-- account's three newest open codes on the network. Answers { expires_at }. A code another account holds right now is
-- a unique violation (`duplicate`): the caller draws another.
create or replace function public.ext_code_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_account text := p->>'account_id';
  v_network text := p->>'network';
  v_exp timestamptz := now() + interval '10 minutes';
begin
  if coalesce(v_account, '') = '' or length(v_account) > 64
     or coalesce(v_network, '') not in ('mainnet', 'testnet')
     or coalesce(p->>'code_sha256', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input';
  end if;
  -- One code at a time per account and network, so that two at once cannot both keep a fourth open code.
  perform pg_advisory_xact_lock(hashtextextended('probarion/ext/code/' || v_account || '/' || v_network, 0));
  delete from public.extension_pair_codes where used_at is not null or expires_at <= now();
  insert into public.extension_pair_codes (code_sha256, account_id, network, expires_at)
  values (p->>'code_sha256', v_account, v_network, v_exp);
  delete from public.extension_pair_codes
    where code_sha256 in (
      select c.code_sha256 from public.extension_pair_codes c
      where c.account_id = v_account and c.network = v_network
      order by c.created_at desc, c.code_sha256 desc
      offset 3);
  return jsonb_build_object('expires_at', v_exp);
end $$;

-- { code_sha256, network, token_sha256, hint, label }: in ONE transaction, uses an open code of this network and mints
-- a token for the code's account. Answers { ok: true, id, account_id, network, expires_at } or { ok: false } (unknown,
-- used, expired or another network's: one answer for all). A token that cannot be minted rolls the code back.
create or replace function public.ext_code_exchange(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code public.extension_pair_codes;
  v_minted jsonb;
begin
  if coalesce(p->>'code_sha256', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p->>'network', '') not in ('mainnet', 'testnet') then
    raise exception 'invalid_input';
  end if;
  select c.* into v_code from public.extension_pair_codes c
    where c.code_sha256 = p->>'code_sha256' and c.network = p->>'network'
      and c.used_at is null and c.expires_at > now()
    for update;
  if not found then
    return jsonb_build_object('ok', false);
  end if;
  update public.extension_pair_codes set used_at = now() where code_sha256 = v_code.code_sha256;
  v_minted := public.ext_token_mint(jsonb_build_object('account_id', v_code.account_id, 'network', v_code.network,
      'token_sha256', p->>'token_sha256', 'hint', p->>'hint', 'label', p->>'label'));
  return jsonb_build_object('ok', true, 'id', v_minted->>'id', 'account_id', v_code.account_id,
                            'network', v_code.network, 'expires_at', v_minted->'expires_at');
end $$;

revoke all on function public.ext_token_mint(jsonb), public.ext_token_use(jsonb), public.ext_token_list(jsonb),
  public.ext_token_revoke(jsonb), public.ext_code_create(jsonb), public.ext_code_exchange(jsonb)
  from public, anon, authenticated;
grant execute on function public.ext_token_mint(jsonb), public.ext_token_use(jsonb), public.ext_token_list(jsonb),
  public.ext_token_revoke(jsonb), public.ext_code_create(jsonb), public.ext_code_exchange(jsonb)
  to service_role;
