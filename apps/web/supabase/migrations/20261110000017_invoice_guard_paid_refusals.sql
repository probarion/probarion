-- The duplicate guard counts a refusal whose text was already paid, or may still pay, as an invoice that may pay.
--
-- Until now the guard (invoice_insert, 0016; invoice_confirm_begin, 0007) blocked the fingerprint and the
-- invoice-number key of a decided row only when it was paid, burned, settled or held on chain. A row refused because
-- its own text was already paid elsewhere did not block, so a second text of the same bill could pay. An SDK agent
-- pays text A outside the console; the owner's Confirm of A in the console is refused as `invoice.duplicate`, and A's
-- row frees the number; text B, with the same number and another hash, then passes the guard, `invoice.duplicate` and
-- the contract's DuplicateInvoice, so the bill is paid twice.
--
-- 1. invoice_decided_may_pay(i): true for a decided row whose outcome may have paid or may still pay:
--    - paid, burned or settled, or held on chain with a spend id (0006's states);
--    - refused_by_contract with DuplicateInvoice (a spend that may pay holds the invoice) or DuplicateRef (a spend
--      used the ref), the bare vault codes the SDK records (spend-outcome.ts lookUpByRef);
--    - refused_by_code when its decision entry refused `invoice.duplicate` ("was already paid or is pending", or the
--      ref was used) or `ledger.unresolved` (an unconfirmed payment of the text may still land). The outcome's code is
--      the first refusing rule only, and decide() runs the vault, mandate and limit rules before `invoice.duplicate`,
--      so a row refused as mandate.uses_exhausted can hold that refusal too: the ledger entry of the row's decision
--      (outcome.decisionHash, the entry's body_hash) lists every rule. The code is read as well, for a row whose entry
--      is not in this tenant's ledger.
--    A held-by-code outcome, a failed one and any other refusal sent nothing for this text, as before.
-- 2. invoice_insert: 0016's, with both guards on that function. Guard 2 also names an invoice that may have paid
--    before one that waits for the owner: the browser extension queues without the tenant lease (0015), so both can
--    have the number, and a notice that offered a re-upload after the waiting one's Reject would answer 409. Guard 1
--    orders the same way, for the 409's status. The takeover of a row the number rule refused reads the same match,
--    so it waits while such a refusal holds the number.
-- 3. invoice_confirm_begin: 0007's, with the function in its guard (another waiting row still does not block).
--
-- invoice_reject (0007) is unchanged: a Reject clears the row's fingerprint and number, so a rejected row blocks
-- nothing. invoice_queue (0015) calls invoice_insert as before. The grants of the replaced functions are kept (create
-- or replace keeps them: service role only); the new function is the service role's only.

create or replace function public.invoice_decided_may_pay(i public.invoices) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select i.status = 'decided' and coalesce(
    i.outcome->>'status' in ('paid', 'burned', 'settled')
    -- held on chain (a spend was sent for its approver); a hold by code sent nothing
    or (i.outcome->>'status' = 'held' and i.outcome->>'spendId' is not null)
    or (i.outcome->>'status' = 'refused_by_contract' and i.outcome->>'code' in ('DuplicateInvoice', 'DuplicateRef'))
    or (i.outcome->>'status' = 'refused_by_code'
        and (i.outcome->>'code' in ('invoice.duplicate', 'ledger.unresolved')
             or exists (select 1 from public.ledger_entries e
                        where e.tenant_id = i.tenant_id and e.body_hash = i.outcome->>'decisionHash'
                          and e.kind = 'decision'
                          and (e.body->'rules' @> '[{"id": "invoice.duplicate", "outcome": "refuse"}]'::jsonb
                               or e.body->'rules' @> '[{"id": "ledger.unresolved", "outcome": "refuse"}]'::jsonb)))),
    false)
$$;

create or replace function public.invoice_insert(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.agent_key_uuid(p->>'tenant_id');
  v_ref text := p->>'ref';
  v_hash text := p->>'invoice_hash';
  v_doc text := p->>'document_sha256';
  v_fp text := p->>'fingerprint_sha256';
  v_num text := p->>'invoice_number_hmac';
  v_filename text := p->>'filename';
  v_issue text := p->>'amount_issue';
  v_number_rule boolean := coalesce(p->'number_rule' = 'true'::jsonb, false);
  v_retained boolean;
  v_zero boolean;
  v_facts jsonb;
  v_id uuid;
  v_status text;
  v_match jsonb;
  v_named jsonb;
begin
  if jsonb_typeof(p->'retained') is distinct from 'boolean'
     or (v_issue is not null and v_issue not in ('not_found', 'ambiguous', 'unreadable', 'currency', 'truncated',
                                                 'zero', 'not_payable'))
     or coalesce(v_hash, '') !~ '^[0-9a-f]{64}$'
     or (v_doc is not null and v_doc !~ '^[0-9a-f]{64}$')
     or (v_fp is not null and v_fp !~ '^[0-9a-f]{64}$')
     or (v_num is not null and v_num !~ '^[0-9a-f]{64}$')
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
  -- The tenant's setting as stored now (row-locked, so a concurrent switch waits for this insert or wins first).
  select t.zero_retention into v_zero from public.tenants t where t.id = v_tenant for share;
  if v_zero is null then
    raise exception 'not_found';
  end if;
  if v_zero and v_retained then
    raise exception 'invalid_input: this vault is in zero-retention mode; the invoice cannot be retained';
  end if;

  -- The duplicate guard, 1: another text that renders the same invoice, which may have paid or may still pay. One
  -- that may have paid is named before one that waits for the owner.
  select i.id, i.status into v_id, v_status from public.invoices i
    where i.tenant_id = v_tenant and i.ref <> v_ref
      and v_fp is not null and i.fingerprint_sha256 = v_fp
      and (i.status in ('processing', 'unconfirmed', 'awaiting_owner') or public.invoice_decided_may_pay(i))
    order by (i.status = 'awaiting_owner'), i.created_at, i.id
    limit 1;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'duplicate', true, 'status', v_status);
  end if;

  -- The duplicate guard, 2: the same invoice number for the same payee, in the same states and the same order. A
  -- duplicate here, unless the caller refuses it in decide() (number_rule): then it is named in the answer.
  select i.id, i.status, jsonb_build_object('id', i.id, 'invoice_hash', i.invoice_hash, 'status', i.status,
                                            'outcome_status', i.outcome->>'status')
    into v_id, v_status, v_match
    from public.invoices i
    where i.tenant_id = v_tenant and i.ref <> v_ref
      and v_num is not null and i.invoice_number_hmac = v_num
      and (i.status in ('processing', 'unconfirmed', 'awaiting_owner') or public.invoice_decided_may_pay(i))
    order by (i.status = 'awaiting_owner'), i.created_at, i.id
    limit 1;
  if v_id is not null and not v_number_rule then
    return jsonb_build_object('id', v_id, 'duplicate', true, 'status', v_status);
  end if;
  -- Only a caller that asked for it gets the key: without the rule, the answer keeps 0006's shape.
  v_named := case when v_number_rule then jsonb_build_object('number_match', v_match) else '{}'::jsonb end;

  insert into public.invoices (tenant_id, invoice_hash, ref, filename, media_type, document_sha256,
                               fingerprint_sha256, invoice_number_hmac, retained, content_ciphertext,
                               content_nonce, facts, amount_issue, status, request_id, created_by)
  values (v_tenant, v_hash, v_ref, v_filename, p->>'media_type', v_doc, v_fp, v_num, v_retained,
          p->>'content_ciphertext', p->>'content_nonce', v_facts, v_issue, 'processing', p->>'request_id',
          p->>'created_by')
  on conflict (tenant_id, ref) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'duplicate', false, 'retry', false) || v_named;
  end if;

  -- An attempt that ended in `error` sent nothing, so the same invoice may run again on the same row and ref. So did
  -- one that the number rule refused: once no invoice that may pay has its number (the earlier one was rejected, or
  -- paid nothing after all), the same text runs again. While one still may, the same text is a duplicate.
  update public.invoices set
      filename = v_filename, media_type = p->>'media_type', document_sha256 = v_doc, fingerprint_sha256 = v_fp,
      invoice_number_hmac = v_num, retained = v_retained,
      content_ciphertext = p->>'content_ciphertext', content_nonce = p->>'content_nonce', facts = v_facts,
      amount_issue = v_issue, status = 'processing', outcome = null, suggested_amount = null, error = null,
      request_id = p->>'request_id', created_by = p->>'created_by',
      model_prompt_tokens = null, model_completion_tokens = null, anchor_tx_hash = null, decided_at = null
    where tenant_id = v_tenant and ref = v_ref and invoice_hash = v_hash
      and (status = 'error'
           or (v_number_rule and v_match is null and status = 'decided'
               and outcome->>'status' = 'refused_by_code'
               and outcome->>'code' = 'custom.invoice_number_duplicate'))
    returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'duplicate', false, 'retry', true) || v_named;
  end if;

  select i.id, i.status into v_id, v_status from public.invoices i where i.tenant_id = v_tenant and i.ref = v_ref;
  if v_id is null then
    raise exception 'not_found';
  end if;
  return jsonb_build_object('id', v_id, 'duplicate', true, 'status', v_status);
end $$;

-- 0007's, with invoice_decided_may_pay in step 4: a row with the same fingerprint or invoice number that is
-- processing, unconfirmed, or decided with an outcome that may have paid or may still pay -> duplicate (another
-- waiting row does not block: it sent nothing).
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
      and (i.status in ('processing', 'unconfirmed') or public.invoice_decided_may_pay(i))
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

revoke execute on function public.invoice_decided_may_pay(public.invoices) from public, anon, authenticated;
grant execute on function public.invoice_decided_may_pay(public.invoices) to service_role;
