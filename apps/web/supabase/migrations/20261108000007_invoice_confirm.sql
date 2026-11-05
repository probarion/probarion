-- The owner's Confirm and Reject for an invoice in awaiting_owner (plan 04 Task 14, rulings W-T14-R0 and W-T14-R1).
--
-- An invoice waits for the owner when no attested model confirmed the amount the code read (0006). The owner pays it
-- with a NEP-413 wallet signature over a message the server builds, or rejects it. This file adds:
--   - the row's mandate (`mandate_id`, written with the outcome), so a confirmation names the mandate it pays under;
--   - a frozen snapshot: while a row waits, its suggested_amount, mandate_id and invoice_hash cannot change;
--   - single-use confirmation nonces, each issued to one account for one row snapshot (id, suggested_amount,
--     mandate_id, invoice_hash) and alive five minutes;
--   - invoice_confirm_begin: in ONE transaction it burns the nonce, checks it was issued for this account, row and
--     tenant and has not expired, re-runs the duplicate guard, and compare-and-sets the row from awaiting_owner with
--     the nonce's snapshot to processing, recording the confirmation (the server-built message, the key, the full
--     signature, the nonce and the final block at which the key was read as FullAccess). Two clicks pay once;
--   - invoice_confirm_abort: back to awaiting_owner when the confirmed cycle stopped before anything was sent;
--   - Reject (status `rejected`): a compare-and-set with the same snapshot condition, which frees the row's guard
--     keys, so a corrected re-upload is a new invoice;
--   - invoice_content: a retained invoice's sealed file, for the owner's review on the server;
--   - invoice_payee_recent: every invoice of a payee from the last 90 days, shown before the owner confirms.
--
-- The vault itself accepts each invoice_hash and ref once, so a function cut off after the compare-and-set cannot pay
-- twice; the watcher (Task 20) reconciles a row left in processing.
--
-- The functions new here take `(p jsonb)`, return jsonb and are security definer with a pinned search_path. The two
-- replaced from 0006 (invoice_set_outcome, invoice_json), the invoice_confirm_iso helper and the trigger function run
-- as their caller. All are executable by the service role only; the server calls them after its own membership check.

-- `rejected` joins the statuses.
alter table public.invoices drop constraint invoices_status_check;
alter table public.invoices add constraint invoices_status_check check (status in (
  'received', 'processing', 'decided', 'unconfirmed', 'awaiting_owner', 'error', 'rejected'));

alter table public.invoices
  add column mandate_id bigint check (mandate_id is null or mandate_id > 0),
  add column confirmed_by text check (confirmed_by is null or (confirmed_by <> '' and length(confirmed_by) <= 64)),
  add column confirmed_at timestamptz,
  add column confirm_message text
    check (confirm_message is null or length(confirm_message) between 1 and 2000),
  add column confirm_public_key text
    check (confirm_public_key is null or confirm_public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  add column confirm_signature text
    check (confirm_signature is null or confirm_signature ~ '^[A-Za-z0-9+/]{86}==$'),
  add column confirm_nonce text check (confirm_nonce is null or confirm_nonce ~ '^[0-9a-f]{64}$'),
  add column confirm_key_block_height bigint
    check (confirm_key_block_height is null or confirm_key_block_height >= 0),
  add column confirm_key_block_hash text
    check (confirm_key_block_hash is null or confirm_key_block_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  add column rejected_by text check (rejected_by is null or (rejected_by <> '' and length(rejected_by) <= 64)),
  add column rejected_at timestamptz;
-- A confirmation is recorded whole or not at all.
alter table public.invoices add constraint invoices_confirmation_whole check (
  num_nonnulls(confirmed_by, confirmed_at, confirm_message, confirm_public_key, confirm_signature, confirm_nonce,
               confirm_key_block_height, confirm_key_block_hash) in (0, 8));
alter table public.invoices add constraint invoices_rejected_whole check (
  (status = 'rejected') = (rejected_by is not null) and (rejected_by is null) = (rejected_at is null));
comment on column public.invoices.mandate_id is 'The mandate the cycle signed under (its agent key), set with the outcome.';
comment on column public.invoices.confirm_message is
  'The exact message the server built and verified the owner''s NEP-413 signature over (recipient probarion.xyz/payables/confirm).';
comment on column public.invoices.confirm_key_block_height is
  'The final block at which the signer key was read as a FullAccess key of the vault owner.';

-- Members read these like the other non-secret columns. The signature and the message are a public proof, not a secret.
grant select (mandate_id, confirmed_by, confirmed_at, confirm_message, confirm_public_key, confirm_signature,
              confirm_nonce, confirm_key_block_height, confirm_key_block_hash, rejected_by, rejected_at)
  on public.invoices to authenticated;

-- While a row waits for the owner, what the owner sees and signs for cannot change under them.
create or replace function public.invoice_snapshot_frozen() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if old.status = 'awaiting_owner'
     and (new.suggested_amount is distinct from old.suggested_amount
          or new.mandate_id is distinct from old.mandate_id
          or new.invoice_hash is distinct from old.invoice_hash) then
    raise exception 'invoice_snapshot_frozen: a waiting invoice keeps its suggested amount, mandate and invoice hash';
  end if;
  return new;
end $$;
create trigger invoices_snapshot_frozen before update on public.invoices
  for each row execute function public.invoice_snapshot_frozen();

-- One confirmation nonce: 32 random bytes (hex), purpose 'confirm' only, issued to one account for one row snapshot.
-- No member reads this table (RLS on, no policy, no grant): the server reads it through the functions below.
create table public.invoice_confirm_nonces (
  nonce text primary key check (nonce ~ '^[0-9a-f]{64}$'),
  purpose text not null default 'confirm' check (purpose = 'confirm'),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  issued_to text not null check (issued_to <> '' and length(issued_to) <= 64),
  suggested_amount text not null check (suggested_amount ~ '^[1-9][0-9]{0,38}$'),
  mandate_id bigint not null check (mandate_id > 0),
  invoice_hash text not null check (invoice_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index invoice_confirm_nonces_invoice on public.invoice_confirm_nonces (invoice_id);
alter table public.invoice_confirm_nonces enable row level security;
revoke all on public.invoice_confirm_nonces from anon, authenticated;
-- MAINTAIN (PostgreSQL 17+): the service key does not need it on this table either (as 0001 does for the others).
do $$ begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.invoice_confirm_nonces from service_role';
  end if;
end $$;

-- 0006's invoice_set_outcome, plus `mandate_id`: the mandate the cycle signed under (null keeps the row's).
create or replace function public.invoice_set_outcome(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_id uuid := public.agent_key_uuid(p->>'id');
  v_status text := p->>'status';
  v_outcome jsonb := case when jsonb_typeof(p->'outcome') = 'object' then p->'outcome' end;
  v_anchor text := nullif(p->>'anchor_tx_hash', '');
  v_suggested text := p->>'suggested_amount';
  v_mandate text := p->>'mandate_id';
  v_changed boolean;
  v_now text;
begin
  if coalesce(v_status, '') not in ('decided', 'unconfirmed', 'awaiting_owner', 'error')
     or (v_status in ('decided', 'unconfirmed', 'awaiting_owner') and v_outcome is null)
     or (v_status = 'awaiting_owner' and (coalesce(v_suggested, '') !~ '^[1-9][0-9]{0,38}$'
         or coalesce(v_outcome->>'status', '') not in ('held', 'refused_by_code')
         or jsonb_typeof(v_outcome->'spendId') is distinct from 'null'
         or jsonb_typeof(v_outcome->'txHash') is distinct from 'null'))
     or (v_status <> 'awaiting_owner' and v_suggested is not null)
     or (v_status = 'error' and (v_outcome is not null or coalesce(p->>'error', '') = '' or v_anchor is not null))
     or (v_outcome->>'status' = 'unconfirmed' and v_status <> 'unconfirmed')
     or (v_anchor is not null and v_anchor !~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$')
     or (v_mandate is not null and v_mandate !~ '^[1-9][0-9]{0,17}$')
     or coalesce(p->>'model_prompt_tokens', '0') !~ '^[0-9]{1,9}$'
     or coalesce(p->>'model_completion_tokens', '0') !~ '^[0-9]{1,9}$' then
    raise exception 'invalid_input';
  end if;
  update public.invoices set
      status = v_status,
      outcome = v_outcome,
      suggested_amount = v_suggested,
      mandate_id = coalesce(v_mandate::bigint, mandate_id),
      error = case when v_status = 'error' then left(p->>'error', 500) end,
      anchor_tx_hash = v_anchor,
      model_prompt_tokens = (p->>'model_prompt_tokens')::integer,
      model_completion_tokens = (p->>'model_completion_tokens')::integer,
      decided_at = now()
    where id = v_id and tenant_id = v_tenant and status = 'processing'
    returning true into v_changed;
  if v_changed then
    return jsonb_build_object('id', v_id, 'status', v_status, 'changed', true);
  end if;
  select i.status into v_now from public.invoices i where i.id = v_id and i.tenant_id = v_tenant;
  if v_now is null then
    raise exception 'not_found';
  end if;
  return jsonb_build_object('id', v_id, 'status', v_now, 'changed', false);
end $$;

-- One invoice as the console reads it (0006's, plus the mandate, the confirmation and the rejection): never the
-- sealed content or its nonce.
create or replace function public.invoice_json(i public.invoices) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('id', i.id, 'invoice_hash', i.invoice_hash, 'ref', i.ref, 'filename', i.filename,
      'media_type', i.media_type, 'document_sha256', i.document_sha256, 'retained', i.retained, 'facts', i.facts,
      'amount_issue', i.amount_issue, 'status', i.status, 'suggested_amount', i.suggested_amount,
      'outcome', i.outcome, 'error', i.error,
      'anchor_tx_hash', i.anchor_tx_hash,
      'request_id', i.request_id, 'model_prompt_tokens', i.model_prompt_tokens,
      'model_completion_tokens', i.model_completion_tokens, 'created_by', i.created_by, 'created_at', i.created_at,
      'decided_at', i.decided_at, 'mandate_id', i.mandate_id,
      'confirmed_by', i.confirmed_by, 'confirmed_at', i.confirmed_at, 'confirm_message', i.confirm_message,
      'confirm_public_key', i.confirm_public_key, 'confirm_signature', i.confirm_signature,
      'confirm_nonce', i.confirm_nonce, 'confirm_key_block_height', i.confirm_key_block_height,
      'confirm_key_block_hash', i.confirm_key_block_hash, 'rejected_by', i.rejected_by, 'rejected_at', i.rejected_at)
$$;

-- The ISO-8601 UTC form, to the second, that the confirmation message carries.
create or replace function public.invoice_confirm_iso(t timestamptz) returns text
language sql immutable set search_path = public, pg_temp as $$
  select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

-- { tenant_id, id, nonce, issued_to }: a nonce for this waiting row's snapshot, alive five minutes. It ends the earlier
-- live nonces of this row and account, and sweeps the tenant's expired ones. Answers the snapshot and the expiry the
-- message carries, or { ok: false, reason: not_awaiting | no_mandate, status }.
create or replace function public.invoice_confirm_issue(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_id uuid := public.agent_key_uuid(p->>'id');
  v_nonce text := p->>'nonce';
  v_to text := p->>'issued_to';
  v_row public.invoices;
  v_exp timestamptz := date_trunc('second', now()) + interval '5 minutes';
begin
  if coalesce(v_nonce, '') !~ '^[0-9a-f]{64}$' or coalesce(v_to, '') = '' or length(v_to) > 64 then
    raise exception 'invalid_input';
  end if;
  select i.* into v_row from public.invoices i where i.id = v_id and i.tenant_id = v_tenant;
  if not found then
    raise exception 'not_found';
  end if;
  if v_row.status <> 'awaiting_owner' or v_row.suggested_amount is null then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting', 'status', v_row.status);
  end if;
  if v_row.mandate_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_mandate', 'status', v_row.status);
  end if;
  delete from public.invoice_confirm_nonces where tenant_id = v_tenant and expires_at < now();
  update public.invoice_confirm_nonces set used_at = now()
    where invoice_id = v_id and issued_to = v_to and used_at is null;
  insert into public.invoice_confirm_nonces (nonce, purpose, tenant_id, invoice_id, issued_to, suggested_amount,
                                             mandate_id, invoice_hash, expires_at)
  values (v_nonce, 'confirm', v_tenant, v_id, v_to, v_row.suggested_amount, v_row.mandate_id, v_row.invoice_hash,
          v_exp);
  return jsonb_build_object('ok', true, 'nonce', v_nonce, 'invoice_id', v_id,
      'suggested_amount', v_row.suggested_amount, 'mandate_id', v_row.mandate_id, 'invoice_hash', v_row.invoice_hash,
      'expires_at', public.invoice_confirm_iso(v_exp));
end $$;

-- { nonce }: the record of a confirmation nonce, so the server can rebuild the message it was issued for; null when
-- unknown. Reading it burns nothing.
create or replace function public.invoice_confirm_nonce(p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('nonce', n.nonce, 'purpose', n.purpose, 'tenant_id', n.tenant_id,
      'invoice_id', n.invoice_id, 'issued_to', n.issued_to, 'suggested_amount', n.suggested_amount,
      'mandate_id', n.mandate_id, 'invoice_hash', n.invoice_hash, 'expires_at', public.invoice_confirm_iso(n.expires_at),
      'used', n.used_at is not null, 'expired', n.expires_at <= now())
  from public.invoice_confirm_nonces n
  where n.nonce = p->>'nonce' and n.purpose = 'confirm'
$$;

-- { tenant_id, id, nonce, account, message, public_key, signature, key_block_height, key_block_hash, request_id },
-- called after the server verified the signature over the message it rebuilt. One transaction:
--   1. the nonce, locked: unknown -> nonce_unknown; used -> nonce_used; otherwise burned now, whatever follows;
--   2. issued for another tenant, row or account -> nonce_mismatch; expired -> expired;
--   3. the row, locked: not awaiting_owner -> not_awaiting; another suggestion, mandate or hash than the nonce's
--      snapshot -> row_changed;
--   4. the duplicate guard (0006's, against every other row of the tenant): a row with the same fingerprint or
--      invoice number that is processing, unconfirmed, or decided paid, burned, settled or held on chain ->
--      duplicate (another waiting row does not block: it sent nothing);
--   5. the compare-and-set to processing, on the nonce's snapshot, recording the confirmation.
-- Every refusal leaves the row as it was.
create or replace function public.invoice_confirm_begin(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_id uuid := public.agent_key_uuid(p->>'id');
  v_nonce text := p->>'nonce';
  v_account text := p->>'account';
  v_n public.invoice_confirm_nonces;
  v_row public.invoices;
  v_dup uuid;
  v_dup_status text;
  v_changed boolean;
begin
  if coalesce(v_nonce, '') !~ '^[0-9a-f]{64}$'
     or coalesce(v_account, '') = '' or length(v_account) > 64
     or coalesce(length(p->>'message'), 0) not between 1 and 2000
     or coalesce(p->>'public_key', '') !~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$'
     or coalesce(p->>'signature', '') !~ '^[A-Za-z0-9+/]{86}==$'
     or jsonb_typeof(p->'key_block_height') is distinct from 'number'
     or (p->>'key_block_height') !~ '^[0-9]{1,18}$'
     or coalesce(p->>'key_block_hash', '') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     or coalesce(p->>'request_id', '') = '' then
    raise exception 'invalid_input';
  end if;

  select n.* into v_n from public.invoice_confirm_nonces n
    where n.nonce = v_nonce and n.purpose = 'confirm' for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'nonce_unknown');
  end if;
  if v_n.used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'nonce_used');
  end if;
  update public.invoice_confirm_nonces set used_at = now() where nonce = v_nonce;
  if v_n.tenant_id <> v_tenant or v_n.invoice_id <> v_id or v_n.issued_to <> v_account then
    return jsonb_build_object('ok', false, 'reason', 'nonce_mismatch');
  end if;
  if v_n.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  select i.* into v_row from public.invoices i where i.id = v_id and i.tenant_id = v_tenant for update;
  if v_row.status <> 'awaiting_owner' then
    return jsonb_build_object('ok', false, 'reason', 'not_awaiting', 'status', v_row.status);
  end if;
  if v_row.suggested_amount is distinct from v_n.suggested_amount or v_row.invoice_hash <> v_n.invoice_hash
     or v_row.mandate_id is distinct from v_n.mandate_id then
    return jsonb_build_object('ok', false, 'reason', 'row_changed', 'status', v_row.status);
  end if;

  select i.id, i.status into v_dup, v_dup_status from public.invoices i
    where i.tenant_id = v_tenant and i.id <> v_id
      and ((v_row.fingerprint_sha256 is not null and i.fingerprint_sha256 = v_row.fingerprint_sha256)
           or (v_row.invoice_number_hmac is not null and i.invoice_number_hmac = v_row.invoice_number_hmac))
      and (i.status in ('processing', 'unconfirmed')
           or (i.status = 'decided'
               and (i.outcome->>'status' in ('paid', 'burned', 'settled')
                    or (i.outcome->>'status' = 'held' and i.outcome->>'spendId' is not null))))
    order by i.created_at, i.id
    limit 1;
  if v_dup is not null then
    return jsonb_build_object('ok', false, 'reason', 'duplicate', 'status', v_row.status,
                              'duplicate_id', v_dup, 'duplicate_status', v_dup_status);
  end if;

  update public.invoices set
      status = 'processing',
      confirmed_by = v_account,
      confirmed_at = now(),
      confirm_message = p->>'message',
      confirm_public_key = p->>'public_key',
      confirm_signature = p->>'signature',
      confirm_nonce = v_nonce,
      confirm_key_block_height = (p->>'key_block_height')::bigint,
      confirm_key_block_hash = p->>'key_block_hash',
      request_id = p->>'request_id'
    where id = v_id and tenant_id = v_tenant and status = 'awaiting_owner'
      and suggested_amount = v_n.suggested_amount and invoice_hash = v_n.invoice_hash
      and mandate_id = v_n.mandate_id
    returning true into v_changed;
  if not coalesce(v_changed, false) then
    return jsonb_build_object('ok', false, 'reason', 'row_changed', 'status', v_row.status);
  end if;
  return jsonb_build_object('ok', true, 'status', 'processing');
end $$;

-- { nonce }: burns a live nonce on its own (the server refused the signature over its message). { burned }.
create or replace function public.invoice_confirm_burn(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_burned boolean;
begin
  update public.invoice_confirm_nonces set used_at = now()
    where nonce = p->>'nonce' and purpose = 'confirm' and used_at is null
    returning true into v_burned;
  return jsonb_build_object('burned', coalesce(v_burned, false));
end $$;

-- { tenant_id, id }: a confirmed row whose cycle stopped before anything was sent goes back to awaiting_owner, with
-- its confirmation cleared. Only a row a confirmation moved to processing; { changed, status }.
create or replace function public.invoice_confirm_abort(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_id uuid := public.agent_key_uuid(p->>'id');
  v_changed boolean;
  v_now text;
begin
  update public.invoices set
      status = 'awaiting_owner', confirmed_by = null, confirmed_at = null, confirm_message = null,
      confirm_public_key = null, confirm_signature = null, confirm_nonce = null, confirm_key_block_height = null,
      confirm_key_block_hash = null
    where id = v_id and tenant_id = v_tenant and status = 'processing' and confirmed_by is not null
      and suggested_amount is not null and mandate_id is not null
    returning true into v_changed;
  if v_changed then
    return jsonb_build_object('changed', true, 'status', 'awaiting_owner');
  end if;
  select i.status into v_now from public.invoices i where i.id = v_id and i.tenant_id = v_tenant;
  if v_now is null then
    raise exception 'not_found';
  end if;
  return jsonb_build_object('changed', false, 'status', v_now);
end $$;

-- { tenant_id, id, rejected_by, suggested_amount, invoice_hash, mandate_id }: Reject, a compare-and-set on the
-- snapshot the owner saw (a null mandate_id matches a row recorded without one). Nothing is paid; the fingerprint and
-- the invoice-number key are cleared, so a corrected re-upload is a new invoice (a rejected row never blocks the guard
-- either). { changed, status }.
create or replace function public.invoice_reject(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_id uuid := public.agent_key_uuid(p->>'id');
  v_by text := p->>'rejected_by';
  v_amount text := p->>'suggested_amount';
  v_hash text := p->>'invoice_hash';
  v_mandate text := p->>'mandate_id';
  v_changed boolean;
  v_now text;
begin
  if coalesce(v_by, '') = '' or length(v_by) > 64
     or coalesce(v_amount, '') !~ '^[1-9][0-9]{0,38}$'
     or coalesce(v_hash, '') !~ '^[0-9a-f]{64}$'
     or (v_mandate is not null and v_mandate !~ '^[1-9][0-9]{0,17}$') then
    raise exception 'invalid_input';
  end if;
  update public.invoices set
      status = 'rejected', rejected_by = v_by, rejected_at = now(), decided_at = now(),
      fingerprint_sha256 = null, invoice_number_hmac = null
    where id = v_id and tenant_id = v_tenant and status = 'awaiting_owner'
      and suggested_amount = v_amount and invoice_hash = v_hash
      and mandate_id is not distinct from v_mandate::bigint
    returning true into v_changed;
  if v_changed then
    return jsonb_build_object('changed', true, 'status', 'rejected');
  end if;
  select i.status into v_now from public.invoices i where i.id = v_id and i.tenant_id = v_tenant;
  if v_now is null then
    raise exception 'not_found';
  end if;
  return jsonb_build_object('changed', false, 'status', v_now);
end $$;

-- { tenant_id, id }: a retained invoice's sealed file { media_type, content_ciphertext, content_nonce }, or null (no
-- such row, or a zero-retention one). Only the server opens it, to show the owner the text before Confirm.
create or replace function public.invoice_content(p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when i.retained then jsonb_build_object('media_type', i.media_type,
      'content_ciphertext', i.content_ciphertext, 'content_nonce', i.content_nonce) end
  from public.invoices i
  where i.tenant_id = public.agent_key_uuid(p->>'tenant_id') and i.id = public.agent_key_uuid(p->>'id')
$$;

-- { tenant_id, mandate_ids, limit?, after? }: the tenant's invoices of the last 90 days under one of these mandates (a
-- payee's mandates), or that have no mandate on the row and hold a ledger decision under one of them (a row's own
-- mandate decides its payee, so the ledger is read only for the rows without one), newest first. One page of at most
-- `limit` rows (1 to 1000, default 500); `after` { created_at, id } is the last row of the page before, so the caller
-- reads every row: nothing here caps the list. The console shows it, whatever the amounts, before the owner confirms.
create or replace function public.invoice_payee_recent(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_limit integer := case when (p->>'limit') ~ '^[0-9]{1,4}$'
                          then least(greatest((p->>'limit')::integer, 1), 1000) else 500 end;
  v_mandates text[];
  v_after_at timestamptz;
  v_after_id uuid;
  v_rows jsonb;
begin
  if jsonb_typeof(p->'mandate_ids') is distinct from 'array' then
    raise exception 'invalid_input';
  end if;
  select coalesce(array_agg(m), '{}') into v_mandates from jsonb_array_elements_text(p->'mandate_ids') as m;
  if exists (select 1 from unnest(v_mandates) as m where m !~ '^[1-9][0-9]{0,17}$') then
    raise exception 'invalid_input';
  end if;
  if jsonb_typeof(p->'after') = 'object' then
    v_after_at := (p->'after'->>'created_at')::timestamptz;
    v_after_id := public.agent_key_uuid(p->'after'->>'id');
  end if;
  select coalesce(jsonb_agg(public.invoice_json(x.inv) order by (x.inv).created_at desc, (x.inv).id desc), '[]'::jsonb)
    into v_rows
  from (
    select i as inv from public.invoices i
    where i.tenant_id = v_tenant
      and i.created_at >= now() - interval '90 days'
      and (v_after_at is null or (i.created_at, i.id) < (v_after_at, v_after_id))
      and (i.mandate_id::text = any(v_mandates)
           or (i.mandate_id is null
               and exists (select 1 from public.ledger_entries e
                           where e.tenant_id = v_tenant and e.kind = 'decision'
                             and e.body->>'invoice_hash' = i.invoice_hash
                             and e.body->>'mandate_id' = any(v_mandates))))
    order by i.created_at desc, i.id desc
    limit v_limit
  ) x;
  return v_rows;
end $$;

revoke execute on function
  public.invoice_snapshot_frozen(), public.invoice_confirm_iso(timestamptz), public.invoice_confirm_issue(jsonb),
  public.invoice_confirm_nonce(jsonb), public.invoice_confirm_begin(jsonb), public.invoice_confirm_burn(jsonb),
  public.invoice_confirm_abort(jsonb), public.invoice_reject(jsonb), public.invoice_content(jsonb),
  public.invoice_payee_recent(jsonb), public.invoice_set_outcome(jsonb), public.invoice_json(public.invoices)
  from public, anon, authenticated;
grant execute on function
  public.invoice_confirm_iso(timestamptz), public.invoice_confirm_issue(jsonb), public.invoice_confirm_nonce(jsonb),
  public.invoice_confirm_begin(jsonb), public.invoice_confirm_burn(jsonb), public.invoice_confirm_abort(jsonb),
  public.invoice_reject(jsonb), public.invoice_content(jsonb), public.invoice_payee_recent(jsonb),
  public.invoice_set_outcome(jsonb), public.invoice_json(public.invoices)
  to service_role;
