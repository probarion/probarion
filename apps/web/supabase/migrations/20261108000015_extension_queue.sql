-- Invoices the browser extension queues (plan 06 Task E1b; spec 2026-11-06-probarion-chrome-extension-design.md §4.4).
--
-- The extension never runs a payment cycle. It sends an invoice and the mandate the member chose. The server reads the
-- text and its facts as the console upload does, and runs the code's own checks: the invoice's payee against the
-- mandate's, and the contract's free check_spend view. Then it stores the row straight in awaiting_owner. The owner pays
-- it, or not, with the wallet-signed Confirm of migration 0007: the only way such a row is ever paid. No cycle runs
-- before that Confirm, so until then the row has no outcome. It keeps the checks it was queued with in queue_checks,
-- and says source = 'extension'.

alter table public.invoices
  add column source text not null default 'console' check (source in ('console', 'extension')),
  add column queue_checks jsonb check (queue_checks is null or jsonb_typeof(queue_checks) = 'array');
-- An extension row always keeps its checks, and a console row has none.
alter table public.invoices add constraint invoices_queue_checks_source
  check ((source = 'extension') = (queue_checks is not null));
comment on column public.invoices.source is
  'Where the invoice came from: the console upload, or the browser extension (queued for the owner''s Confirm; no cycle runs before it).';
comment on column public.invoices.queue_checks is
  'The checks an extension invoice passed when it was queued, {id, outcome: pass | hold, detail} each; null otherwise.';

-- Members read these like the other non-secret columns.
grant select (source, queue_checks) on public.invoices to authenticated;

-- 0007's invoice_json, plus source and queue_checks.
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
      'confirm_key_block_hash', i.confirm_key_block_hash, 'rejected_by', i.rejected_by, 'rejected_at', i.rejected_at,
      'source', i.source, 'queue_checks', i.queue_checks)
$$;

-- { invoice_insert's fields, suggested_amount, mandate_id, queue_checks }. In one transaction it makes invoice_insert's
-- row (the same duplicate guard and zero-retention check), then moves it straight to awaiting_owner with the code's
-- amount and the mandate the member chose. Answers { id, duplicate: false, status: 'awaiting_owner' }, or
-- invoice_insert's own { id, duplicate: true, status } unchanged. A check is only pass or hold: a refusal is never stored.
-- Exactly one check is the hold extension.mandate_chosen (D3), and each check keeps only its id, outcome and detail.
create or replace function public.invoice_queue(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_checks jsonb := p->'queue_checks';
  v_ins jsonb;
  v_changed boolean;
begin
  if coalesce(p->>'suggested_amount', '') !~ '^[1-9][0-9]{0,38}$'
     or coalesce(p->>'mandate_id', '') !~ '^[1-9][0-9]{0,17}$'
     or jsonb_typeof(v_checks) is distinct from 'array' then
    raise exception 'invalid_input';
  end if;
  if jsonb_array_length(v_checks) not between 1 and 10
     or exists (select 1 from jsonb_array_elements(v_checks) c
                where jsonb_typeof(c) <> 'object'
                   or coalesce(c->>'outcome', '') not in ('pass', 'hold')
                   or coalesce(length(c->>'id'), 0) not between 1 and 64
                   or coalesce(length(c->>'detail'), 0) not between 1 and 500) then
    raise exception 'invalid_input';
  end if;
  if (select count(*) from jsonb_array_elements(v_checks) c
        where c->>'id' = 'extension.mandate_chosen') <> 1
     or not exists (select 1 from jsonb_array_elements(v_checks) c
                    where c->>'id' = 'extension.mandate_chosen' and c->>'outcome' = 'hold') then
    raise exception 'invalid_input';
  end if;
  select jsonb_agg(jsonb_build_object('id', e.c->>'id', 'outcome', e.c->>'outcome', 'detail', e.c->>'detail')
                   order by e.n)
    into v_checks
    from jsonb_array_elements(v_checks) with ordinality as e(c, n);
  v_ins := public.invoice_insert(p - 'suggested_amount' - 'mandate_id' - 'queue_checks');
  if (v_ins->>'duplicate')::boolean then
    return v_ins;
  end if;
  update public.invoices set
      status = 'awaiting_owner', suggested_amount = p->>'suggested_amount',
      mandate_id = (p->>'mandate_id')::bigint, outcome = null, error = null,
      source = 'extension', queue_checks = v_checks, decided_at = now()
    where id = (v_ins->>'id')::uuid and tenant_id = public.agent_key_uuid(p->>'tenant_id')
      and status = 'processing'
    returning true into v_changed;
  if not coalesce(v_changed, false) then
    raise exception 'not_found';
  end if;
  return jsonb_build_object('id', v_ins->>'id', 'duplicate', false, 'status', 'awaiting_owner');
end $$;

revoke all on function public.invoice_queue(jsonb) from public, anon, authenticated;
grant execute on function public.invoice_queue(jsonb) to service_role;
