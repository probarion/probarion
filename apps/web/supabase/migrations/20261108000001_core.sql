-- Probarion web data model (interfaces §13). RLS on every table.
-- anon (public key) reads nothing directly; it gets only security-definer public_* RPCs.
-- authenticated members read only their tenant; the server uses the service role.

-- Explicit allowlist: no function is executable by anon/authenticated unless a migration grants it.
-- (PUBLIC's EXECUTE is a global default, so it is revoked globally; Supabase's anon/authenticated grants are per-schema.)
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- Same idea for tables, views and sequences created by any LATER migration: Supabase's default privileges give
-- anon/authenticated/service_role everything on them. anon (the public key) starts with nothing, and authenticated
-- starts read-only: no write, TRUNCATE, TRIGGER, REFERENCES or MAINTAIN. A later migration grants SELECT explicitly,
-- behind RLS. rls-assert.sql fails the build if an object slips through.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke insert, update, delete, truncate, trigger, references
  on tables from authenticated;
-- MAINTAIN (VACUUM, ANALYZE, REINDEX, CLUSTER, LOCK, REFRESH MATERIALIZED VIEW) exists from PostgreSQL 17.
do $$ begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'alter default privileges in schema public revoke maintain on tables from authenticated';
  end if;
end $$;

create or replace function public.pb_current_account() returns text
language sql stable
set search_path = public, pg_temp
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'near_account', '')
$$;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  vault_id text not null unique check (vault_id ~ '^[a-z0-9._-]{2,64}$'),
  network text not null check (network in ('mainnet', 'testnet')),
  kind text not null check (kind in ('team', 'external', 'canary')),
  display_name text not null default '' check (length(display_name) <= 80),
  owner_account text not null,
  zero_retention boolean not null default false,
  proof_public boolean not null default false,
  process_lease_until timestamptz,
  watch_lease_until timestamptz,
  watch_spend_from bigint not null default 0,
  watch_mandate_from bigint not null default 0,
  watch_anchor_from bigint not null default 0,
  watch_ledger_seq integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  account_id text not null,
  role text not null check (role in ('owner', 'approver', 'viewer')),
  added_at timestamptz not null default now(),
  primary key (tenant_id, account_id)
);
create index tenant_members_account_idx on public.tenant_members (account_id);

create or replace function public.pb_is_member(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant and m.account_id = public.pb_current_account()
  )
$$;

create table public.agent_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  purpose text not null check (purpose in ('agent', 'ledger')),
  public_key text not null check (public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  secret_ciphertext text not null,
  secret_nonce text not null,
  key_version integer not null default 1,
  label text not null default '' check (octet_length(label) <= 64),
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  created_by text not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  unique (tenant_id, public_key)
);
create unique index agent_keys_one_active_ledger on public.agent_keys (tenant_id)
  where purpose = 'ledger' and status = 'active';

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invoice_hash text not null check (invoice_hash ~ '^[0-9a-f]{64}$'),
  ref text not null check (octet_length(ref) between 1 and 64),
  filename text check (filename is null or length(filename) <= 200),
  media_type text not null check (media_type in ('application/pdf', 'text/plain')),
  retained boolean not null,
  content_ciphertext text,
  content_nonce text,
  facts jsonb,
  -- 'unconfirmed' (F6/R6): the spend was sent but its on-chain outcome is not known yet
  -- (SDK TxOutcomeUnknown). The tx hash lives in `outcome`; the spend is never sent again.
  status text not null default 'received' check (status in (
    'received', 'processing', 'decided', 'unconfirmed', 'error')),
  outcome jsonb,
  error text,
  request_id text not null,
  model_prompt_tokens integer,
  model_completion_tokens integer,
  created_by text not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (tenant_id, ref),
  -- TODO(R18, owned by plan 04 Task 13 and its settings/UI copy): in zero-retention mode (`retained = false`) the
  -- constraint below still allows `filename`, and a file name can carry details. R18 drops `filename` when nothing is
  -- retained; Task 13 adds `and filename is null` to the `not retained` branch in a new migration.
  constraint invoices_retention check (
    (retained and content_ciphertext is not null and content_nonce is not null)
    or (not retained and content_ciphertext is null and content_nonce is null and facts is null)
  )
);

create table public.ledger_entries (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  seq integer not null check (seq >= 0),
  kind text not null check (kind in ('decision', 'payment', 'approval', 'anchor', 'note')),
  body jsonb not null,
  body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  sig text not null,
  signer text not null,
  link text not null check (link ~ '^[0-9a-f]{64}$'),
  request_id text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, seq),
  unique (tenant_id, body_hash)
);

create or replace function public.ledger_entries_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'ledger_append_only';
end $$;
-- Row triggers stop UPDATE and DELETE for every role, the table owner included. They do not fire on
-- TRUNCATE, so that privilege is revoked below (F29).
create trigger ledger_entries_no_rewrite before update or delete on public.ledger_entries
  for each row execute function public.ledger_entries_append_only();

create table public.vault_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  event_key text not null,
  -- 'near_low' (R3): the vault's free NEAR is below the alert threshold (emitted once per UTC day).
  -- TODO(plan 04 Task 20): the watcher emits it at most once per UTC day while free NEAR (balance minus storage
  -- stake) is below NEAR_LOW_ALERT_YOCTO, 0.05 NEAR, in apps/web/src/lib/near/runway.ts.
  -- TODO(plan 04 Task 21): alert_subscription_create puts it in a new subscription's default kinds (as below).
  kind text not null check (kind in (
    'mandate_created', 'spend_held', 'spend_pending', 'spend_paid', 'spend_burned', 'spend_failed',
    'spend_rejected', 'spend_expired', 'refused_by_contract', 'anchor', 'allowance_low', 'near_low')),
  spend_id bigint,
  mandate_id bigint,
  anchor_seq bigint,
  amount text,
  code text,
  tx_hash text,
  payload jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  unique (tenant_id, event_key)
);
create index vault_events_kind_day_idx on public.vault_events (kind, observed_at);

create table public.alert_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel text not null check (channel in ('telegram', 'email')),
  target text,
  link_code text unique,
  kinds text[] not null default array[
    'spend_held', 'refused_by_contract', 'spend_paid', 'spend_burned', 'spend_failed', 'allowance_low',
    'near_low']::text[],
  verified_at timestamptz,
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint alert_target_when_verified check (verified_at is null or target is not null),
  constraint alert_email_shape check (channel <> 'email' or target is null or target ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

create table public.alerts_sent (
  id bigint generated always as identity primary key,
  subscription_id uuid not null references public.alert_subscriptions(id) on delete cascade,
  vault_event_id bigint not null references public.vault_events(id) on delete cascade,
  status text not null check (status in ('sending', 'sent', 'failed')),
  attempts integer not null default 1,
  provider_id text,
  error text,
  updated_at timestamptz not null default now(),
  unique (subscription_id, vault_event_id)
);

create table public.canary_attempts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  visitor_hash text not null check (visitor_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  is_team boolean not null default false,
  mode text not null check (mode in ('live', 'code-only')),
  text_sha256 text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  text_length integer not null check (text_length between 1 and 4000),
  techniques text[] not null default '{}',
  proposal_action text check (proposal_action in ('pay', 'hold', 'refuse')),
  proposal_mandate_id bigint,
  proposal_amount text,
  -- The 7 outcomes of a Canary attempt, plus 'error' and 'unconfirmed' (F6/R6). 'unconfirmed' means the
  -- spend was sent but its on-chain outcome is unknown (SDK TxOutcomeUnknown): it is recorded with its
  -- tx hash and never retried.
  code_status text not null check (code_status in (
    'refused_by_code', 'refused_by_contract', 'held', 'paid', 'burned', 'settled', 'failed', 'unconfirmed',
    'error')),
  code_rule text,
  raw boolean not null default false,
  raw_skipped_reason text,
  contract_status text,
  contract_code text,
  tx_hash text,
  spend_id bigint,
  decision_hash text,
  raw_decision_hash text,
  request_id text not null,
  est_tokens integer not null default 0,
  model_prompt_tokens integer,
  model_completion_tokens integer
);
create index canary_attempts_created_idx on public.canary_attempts (created_at desc);

create table public.metrics_daily (
  day date not null,
  segment text not null check (segment in ('team', 'external', 'canary')),
  metric text not null check (metric in (
    'vaults', 'mandates', 'spends_paid', 'cross_chain_payouts', 'held', 'refused_by_code', 'refused_by_contract',
    'canary_attempts', 'canary_raw_attempts', 'model_decisions', 'nearai_tokens_in', 'nearai_tokens_out')),
  value numeric not null default 0,
  computed_at timestamptz not null default now(),
  primary key (day, segment, metric)
);

-- Columns exactly as interfaces v2 §13 (plus id and created_at). cohort matches tenants.kind; /open groups by it.
create table public.pilots (
  id uuid primary key default gen_random_uuid(),
  vault_account_id text,
  owner_account_id text,
  cohort text not null check (cohort in ('team', 'external', 'canary')),
  consent_name boolean not null default false,
  consent_at timestamptz,
  display_name text check (display_name is null or length(display_name) <= 80),
  created_at timestamptz not null default now(),
  constraint pilots_consent_dated check (not consent_name or consent_at is not null)
);

-- interfaces v2 §13: shared fixed-window counters for serverless rate limits.
-- TODO(plan 04 Task 19, the metrics cron): rows are never deleted. The cron prunes them with
-- `delete from public.rate_limits where window_start < now() - interval '1 day'` (F29, D12).
create table public.rate_limits (
  bucket text primary key check (length(bucket) <= 200),
  window_start timestamptz not null,
  count integer not null check (count >= 0)
);

-- Row-level security on every table.
alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.agent_keys enable row level security;
alter table public.invoices enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.vault_events enable row level security;
alter table public.alert_subscriptions enable row level security;
alter table public.alerts_sent enable row level security;
alter table public.canary_attempts enable row level security;
alter table public.metrics_daily enable row level security;
alter table public.pilots enable row level security;
alter table public.rate_limits enable row level security;

create policy tenants_member_read on public.tenants for select to authenticated using (public.pb_is_member(id));
create policy tenant_members_member_read on public.tenant_members for select to authenticated using (public.pb_is_member(tenant_id));
create policy agent_keys_member_read on public.agent_keys for select to authenticated using (public.pb_is_member(tenant_id));
create policy invoices_member_read on public.invoices for select to authenticated using (public.pb_is_member(tenant_id));
create policy ledger_entries_member_read on public.ledger_entries for select to authenticated using (public.pb_is_member(tenant_id));
create policy vault_events_member_read on public.vault_events for select to authenticated using (public.pb_is_member(tenant_id));
create policy alert_subscriptions_member_read on public.alert_subscriptions for select to authenticated using (public.pb_is_member(tenant_id));
create policy alerts_sent_member_read on public.alerts_sent for select to authenticated using (
  exists (select 1 from public.alert_subscriptions s where s.id = subscription_id and public.pb_is_member(s.tenant_id))
);
-- canary_attempts, metrics_daily, pilots, rate_limits: no policies (deny); public data goes through public_* RPCs.

-- Privileges: Supabase grants ALL on these tables to anon/authenticated/service_role by default. anon keeps nothing.
-- authenticated starts from nothing too and gets an explicit SELECT on the tenant tables, always behind RLS. The four
-- global tables (canary_attempts, metrics_daily, pilots, rate_limits) get no authenticated grant at all.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on public.tenants, public.tenant_members, public.ledger_entries, public.vault_events, public.alerts_sent
  to authenticated;
-- Column grants: the secrets (ciphertexts, nonces, alert link codes and targets) are never selectable by a member.
grant select (id, tenant_id, purpose, public_key, key_version, label, status, created_by, created_at, activated_at, revoked_at)
  on public.agent_keys to authenticated;
grant select (id, tenant_id, invoice_hash, ref, filename, media_type, retained, facts, status, outcome, error, request_id,
  model_prompt_tokens, model_completion_tokens, created_by, created_at, decided_at)
  on public.invoices to authenticated;
-- `link_code` is the secret that confirms a subscription, and `target` is an email address or Telegram chat id. The console
-- reads both only through the service role (alert_subscriptions_list, Task 21), never as `authenticated`, so neither is
-- granted. A later migration can add `target` here if a direct member read of it is ever needed.
grant select (id, tenant_id, channel, kinds, verified_at, active, created_by, created_at)
  on public.alert_subscriptions to authenticated;

-- F29: the ledger stays append-only even for the service key. The row trigger blocks UPDATE and DELETE but not
-- TRUNCATE, and a role holding TRIGGER could add triggers on the table. No Supabase role keeps either privilege.
revoke truncate, trigger on public.ledger_entries from public, anon, authenticated, service_role;

-- MAINTAIN (PostgreSQL 17+) lets a role VACUUM, REINDEX, CLUSTER or LOCK a table. `revoke all` above took it from
-- authenticated; the service key does not need it either.
do $$ begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on all tables in schema public from service_role';
  end if;
end $$;

revoke execute on function public.pb_is_member(uuid) from public, anon;
grant execute on function public.pb_is_member(uuid) to authenticated, service_role;
grant execute on function public.pb_current_account() to anon, authenticated, service_role;
