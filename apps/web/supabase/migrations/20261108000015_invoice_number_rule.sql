-- A second invoice with the same number for the same payee is refused in the signed ledger, not only at intake.
--
-- Until now invoice_insert (0006) answered `duplicate` for a row of the tenant with the same fingerprint OR the same
-- invoice-number key that may have paid or may still pay, and the route answered 409 before decide() ran: the refusal
-- was real but left no ledger entry. A vendor who re-sends INV-2001 with another total (or a PDF that renders other
-- text) is the case worth proving, so that case now reaches decide().
--
-- 1. invoice_insert: 0006's, plus p.number_rule. The same text (ref) and the same rendered text (fingerprint) are
--    duplicates as before, rule or not. When the only match is on the invoice-number key and the caller says it
--    refuses such a match itself (`number_rule: true`), the row is inserted (or an `error` row taken over) as usual,
--    and the answer names the earlier invoice: number_match { id, invoice_hash, status, outcome_status }. The
--    pipeline then adds rule custom.invoice_number_duplicate, which refuses the cycle by code: nothing is sent, and
--    the decision entry, signed by the ledger key, says why. number_match is null when nothing that may pay has the
--    number. The blocking states are 0006's: processing, unconfirmed, awaiting_owner, or decided as paid, burned,
--    settled, or held on chain with a spend id.
--    A row the number rule refused sent nothing, as an `error` row did not: the same text takes it over and runs again
--    on its row and ref once no invoice that may pay has the number (the owner rejected the earlier one, or it paid
--    nothing after all), so a vendor's corrected invoice is not stuck behind its own first upload. While one still
--    may pay, the same text is a duplicate at intake, as any same text is. Another rule's refusal stays final.
-- 2. Without p.number_rule, a number match is a duplicate at intake, as in 0006, and no refused row is run again. So the app and this file can be
--    deployed in either order: an app that does not send the flag never processes a number match, and the 0006
--    function ignores a flag it is given (the app then gets its 409, as today).
-- 3. invoice_confirm_begin (0007) is unchanged: at the owner's Confirm, a same-number row that is processing, sent or
--    paid still refuses as `duplicate`, before anything runs. The grants are unchanged too (create or replace keeps
--    them: service role only).

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

  -- The duplicate guard, 1: another text that renders the same invoice, which may have paid or may still pay.
  select i.id, i.status into v_id, v_status from public.invoices i
    where i.tenant_id = v_tenant and i.ref <> v_ref
      and v_fp is not null and i.fingerprint_sha256 = v_fp
      and (i.status in ('processing', 'unconfirmed', 'awaiting_owner')
           or (i.status = 'decided'
               and (i.outcome->>'status' in ('paid', 'burned', 'settled')
                    -- held on chain (a spend was sent for its approver); a hold by code sent nothing
                    or (i.outcome->>'status' = 'held' and i.outcome->>'spendId' is not null))))
    order by i.created_at, i.id
    limit 1;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'duplicate', true, 'status', v_status);
  end if;

  -- The duplicate guard, 2: the same invoice number for the same payee, in the same states. A duplicate here, unless
  -- the caller refuses it in decide() (number_rule): then it is named in the answer.
  select i.id, i.status, jsonb_build_object('id', i.id, 'invoice_hash', i.invoice_hash, 'status', i.status,
                                            'outcome_status', i.outcome->>'status')
    into v_id, v_status, v_match
    from public.invoices i
    where i.tenant_id = v_tenant and i.ref <> v_ref
      and v_num is not null and i.invoice_number_hmac = v_num
      and (i.status in ('processing', 'unconfirmed', 'awaiting_owner')
           or (i.status = 'decided'
               and (i.outcome->>'status' in ('paid', 'burned', 'settled')
                    or (i.outcome->>'status' = 'held' and i.outcome->>'spendId' is not null))))
    order by i.created_at, i.id
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
