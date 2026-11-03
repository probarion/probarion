-- Payables invoices (plan 04 Task 13). The `invoices` table and its RLS come from 0001; this file adds what the
-- pipeline writes, and the four service-role functions it writes and reads through (plus their row helper,
-- invoice_json).
--
-- What is stored per invoice:
--   - invoice_hash: sha256 of the extracted invoice TEXT, exactly as the model is shown it (ICR-3b, `hashInvoice`).
--     `ref` (the spend's idempotency key) is derived from it, so the same invoice text is one invoice.
--   - document_sha256: sha256 of the uploaded file's bytes (a PDF's file hash is never the invoice hash).
--   - retained: the file sealed with the tenant's invoice key, plus the extracted facts; or, in zero-retention mode
--     (tenants.zero_retention), neither, and no file name either (R18): only hashes, the ref and the outcome.
--   - outcome: the SDK's SpendOutcome, and anchor_tx_hash: the hash of the cycle's anchor transaction. The SDK only
--     returns that hash; it is never written into a ledger entry (an entry cannot hold the hash of the transaction
--     that anchors it), so this row is where it lives (R20).
--
-- Status: received -> processing (invoice_insert) -> decided | unconfirmed | error (invoice_set_outcome).
--   - unconfirmed (F6/R6): the spend was sent and its outcome is not known yet (SDK status "unconfirmed", tx hash in
--     `outcome`). It is shown as "payment sent, confirmation pending" and is never sent again.
--   - error: the cycle threw before any spend was sent (the SDK sends a spend only from a decision, and never throws
--     after it). Such a row is the only one a new upload may run again (R24): invoice_insert takes it over. The SDK
--     still refuses a ref the chain has seen (rule invoice.duplicate) and the contract refuses a second spend of the
--     ref or the invoice, so a retry can never pay twice.
--   - A row left in processing (the function was cut off) is not run again here; the watcher reconciles it by ref.
--
-- Every function here is `(p jsonb) returns jsonb` (Decision D2), runs as its caller and is executable by the
-- service role only. The server calls them after its own membership check, so `tenant_id` is the session's tenant.

-- R18 (the TODO in 0001): zero-retention keeps no file name, which can carry details. No row could have been written
-- with one before this file (no function inserted invoices), but clear any hand-made one so the constraint applies.
update public.invoices set filename = null where not retained and filename is not null;
alter table public.invoices drop constraint invoices_retention;
alter table public.invoices add constraint invoices_retention check (
  (retained and content_ciphertext is not null and content_nonce is not null)
  or (not retained and content_ciphertext is null and content_nonce is null and facts is null and filename is null)
);

alter table public.invoices
  add column document_sha256 text check (document_sha256 is null or document_sha256 ~ '^[0-9a-f]{64}$'),
  add column anchor_tx_hash text check (anchor_tx_hash is null or anchor_tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$');
comment on column public.invoices.invoice_hash is
  'sha256 of the extracted invoice text, exactly as the model is shown it (ICR-3b). Not the file hash.';
comment on column public.invoices.document_sha256 is 'sha256 of the uploaded file''s bytes (for a PDF, the file hash).';
comment on column public.invoices.anchor_tx_hash is
  'The cycle''s anchor transaction (SpendOutcome.anchorTxHash, R20). Never stored in a ledger entry.';

-- Members read these like the other non-secret columns (0001: the sealed content and its nonce are never granted).
grant select (document_sha256, anchor_tx_hash) on public.invoices to authenticated;

-- A new invoice, status processing: { tenant_id, invoice_hash, ref, filename, media_type, document_sha256, retained,
-- content_ciphertext, content_nonce, facts, request_id, created_by }. Answers { id, duplicate: false, retry } for a row
-- this call will process (retry: an earlier attempt of the same invoice ended in `error` and is taken over), or
-- { id, duplicate: true, status } for an invoice that already has a row in any other state.
create or replace function public.invoice_insert(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_ref text := p->>'ref';
  v_hash text := p->>'invoice_hash';
  v_doc text := p->>'document_sha256';
  v_filename text := p->>'filename';
  v_retained boolean;
  v_facts jsonb;
  v_id uuid;
  v_status text;
begin
  if jsonb_typeof(p->'retained') is distinct from 'boolean'
     or coalesce(v_hash, '') !~ '^[0-9a-f]{64}$'
     or (v_doc is not null and v_doc !~ '^[0-9a-f]{64}$')
     or coalesce(octet_length(v_ref), 0) not between 1 and 64
     or coalesce(p->>'media_type', '') not in ('application/pdf', 'text/plain')
     or (v_filename is not null and length(v_filename) > 200)
     or coalesce(jsonb_typeof(p->'facts'), 'null') not in ('object', 'null')
     or coalesce(p->>'request_id', '') = '' or coalesce(p->>'created_by', '') = '' then
    raise exception 'invalid_input';
  end if;
  v_retained := (p->>'retained')::boolean;
  v_facts := case when jsonb_typeof(p->'facts') = 'object' then p->'facts' end;
  -- A zero-retention row must hold no content, facts or file name (invoices_retention): say so instead of a raw
  -- check violation.
  if not v_retained and (p->>'content_ciphertext' is not null or p->>'content_nonce' is not null
                         or v_facts is not null or v_filename is not null) then
    raise exception 'invalid_input: a zero-retention invoice keeps no content, facts or file name';
  end if;
  if v_retained and (coalesce(p->>'content_ciphertext', '') = '' or coalesce(p->>'content_nonce', '') = '') then
    raise exception 'invalid_input: a retained invoice needs its sealed content';
  end if;

  insert into public.invoices (tenant_id, invoice_hash, ref, filename, media_type, document_sha256, retained,
                               content_ciphertext, content_nonce, facts, status, request_id, created_by)
  values (v_tenant, v_hash, v_ref, v_filename, p->>'media_type', v_doc, v_retained,
          p->>'content_ciphertext', p->>'content_nonce', v_facts, 'processing', p->>'request_id', p->>'created_by')
  on conflict (tenant_id, ref) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'duplicate', false, 'retry', false);
  end if;

  -- R24: an attempt that ended in `error` sent nothing, so the same invoice may run again on the same row and ref.
  update public.invoices set
      filename = v_filename, media_type = p->>'media_type', document_sha256 = v_doc, retained = v_retained,
      content_ciphertext = p->>'content_ciphertext', content_nonce = p->>'content_nonce', facts = v_facts,
      status = 'processing', outcome = null, error = null, request_id = p->>'request_id', created_by = p->>'created_by',
      model_prompt_tokens = null, model_completion_tokens = null, anchor_tx_hash = null, decided_at = null
    where tenant_id = v_tenant and ref = v_ref and invoice_hash = v_hash and status = 'error'
    returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'duplicate', false, 'retry', true);
  end if;

  select i.id, i.status into v_id, v_status from public.invoices i where i.tenant_id = v_tenant and i.ref = v_ref;
  if v_id is null then
    raise exception 'not_found';
  end if;
  return jsonb_build_object('id', v_id, 'duplicate', true, 'status', v_status);
end $$;

-- The end of one attempt: { tenant_id, id, status: decided | unconfirmed | error, outcome, error, anchor_tx_hash,
-- model_prompt_tokens, model_completion_tokens }. Compare-and-set: only a row still in `processing` changes, so a
-- late writer never overwrites an outcome; it gets { changed: false } and the row's status. An SDK outcome of
-- "unconfirmed" must be recorded as `unconfirmed` (a payment that may have gone out never reads as plain decided).
create or replace function public.invoice_set_outcome(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_id uuid := public.agent_key_uuid(p->>'id');
  v_status text := p->>'status';
  v_outcome jsonb := case when jsonb_typeof(p->'outcome') = 'object' then p->'outcome' end;
  v_anchor text := nullif(p->>'anchor_tx_hash', '');
  v_changed boolean;
  v_now text;
begin
  if coalesce(v_status, '') not in ('decided', 'unconfirmed', 'error')
     or (v_status in ('decided', 'unconfirmed') and v_outcome is null)
     or (v_status = 'error' and (v_outcome is not null or coalesce(p->>'error', '') = '' or v_anchor is not null))
     or (v_outcome->>'status' = 'unconfirmed' and v_status <> 'unconfirmed')
     or (v_anchor is not null and v_anchor !~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$')
     or coalesce(p->>'model_prompt_tokens', '0') !~ '^[0-9]{1,9}$'
     or coalesce(p->>'model_completion_tokens', '0') !~ '^[0-9]{1,9}$' then
    raise exception 'invalid_input';
  end if;
  update public.invoices set
      status = v_status,
      outcome = v_outcome,
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

-- One invoice as the console reads it: never the sealed content or its nonce.
create or replace function public.invoice_json(i public.invoices) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('id', i.id, 'invoice_hash', i.invoice_hash, 'ref', i.ref, 'filename', i.filename,
      'media_type', i.media_type, 'document_sha256', i.document_sha256, 'retained', i.retained, 'facts', i.facts,
      'status', i.status, 'outcome', i.outcome, 'error', i.error, 'anchor_tx_hash', i.anchor_tx_hash,
      'request_id', i.request_id, 'model_prompt_tokens', i.model_prompt_tokens,
      'model_completion_tokens', i.model_completion_tokens, 'created_by', i.created_by, 'created_at', i.created_at,
      'decided_at', i.decided_at)
$$;

-- { tenant_id, limit? }: the tenant's newest invoices first, at most `limit` (1 to 200, default 50).
create or replace function public.invoice_list(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(public.invoice_json(x.inv) order by (x.inv).created_at desc, (x.inv).id), '[]'::jsonb)
  from (
    select i as inv from public.invoices i
    where i.tenant_id = public.agent_key_uuid(p->>'tenant_id')
    order by i.created_at desc, i.id
    limit case when (p->>'limit') ~ '^[0-9]{1,9}$' then least(greatest((p->>'limit')::integer, 1), 200) else 50 end
  ) x
$$;

-- { tenant_id, id }: one invoice of this tenant, or null (another tenant's id is null too). A malformed id is
-- invalid_input, as everywhere else.
create or replace function public.invoice_get(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select public.invoice_json(i) from public.invoices i
  where i.tenant_id = public.agent_key_uuid(p->>'tenant_id') and i.id = public.agent_key_uuid(p->>'id')
$$;

revoke execute on function
  public.invoice_insert(jsonb), public.invoice_set_outcome(jsonb), public.invoice_json(public.invoices),
  public.invoice_list(jsonb), public.invoice_get(jsonb)
  from public, anon, authenticated;
grant execute on function
  public.invoice_insert(jsonb), public.invoice_set_outcome(jsonb), public.invoice_json(public.invoices),
  public.invoice_list(jsonb), public.invoice_get(jsonb)
  to service_role;
