-- The Canary's database (plan 04 Task 17, spec §14.3, rulings W-T17-R0 and W-T17-R1). Attempts keep hashes and labels,
-- never the visitor's message: canary_attempts has no column that could hold it, and this file makes the label columns
-- short machine labels, so a stranger's words cannot reach the public feed through one either.
--
-- 1. The Canary's ledger is private (W-T17-R1). The gullible model quotes what a visitor types into the proposal and
--    the attestation it signs, and a public ledger is append-only, so those words would be published for good with no
--    way to take them down. Every canary tenant is made private here, and tenant_register never makes one public again.
--    The public Canary surface is the feed and the leaderboard (labels and hashes) and the explorer links of its
--    transactions.
-- 2. Five functions, all `(p jsonb) returns jsonb`, all with a pinned search_path:
--    - canary_attempt_insert, canary_attempt_update, canary_tokens_today: service_role only. The server calls them after
--      its own checks. They run as their caller, which is the service role, the only role that can write the table.
--      An attempt is inserted BEFORE the cycle runs, with an estimate of its tokens, and updated when the cycle ends, so a
--      run the platform kills still counts against the daily budget.
--    - public_canary_leaderboard: service_role only. It scans the table, so the public key cannot call it (anyone could
--      load the shared database with it); the page reads it on the server, behind a cache.
--    - public_canary_feed: security definer, executable by anon (the public key) and by authenticated. It is public by
--      design (the Canary is a public challenge), not opt-in like proof_public, so the gate is the shape of the answer:
--      labels, outcomes and public transaction hashes, never a visitor or IP hash. It reads the newest rows through the
--      created_at index. Both public_* functions time out after 5 s.

-- (1) Private ledgers for every canary tenant that exists now.
update public.tenants set proof_public = false where kind = 'canary';

-- Registration (0005's tenant_register, unchanged except for proof_public): a team vault's proof is public by default, a
-- canary's never. An external vault that becomes the Canary is made private whatever its owner had set; for the other
-- kinds proof_public stays the owner's own setting, as before.
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
  v_inserted boolean := false;
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
  values (v_vault, p->>'network', v_kind, left(coalesce(p->>'display_name', split_part(v_vault, '.', 1)), 80), v_owner,
          v_kind = 'team')
  on conflict (vault_id) do nothing
  returning id, owner_account, true into v_id, v_existing_owner, v_inserted;
  if v_id is null then
    select id, owner_account into v_id, v_existing_owner from public.tenants where vault_id = v_vault;
  end if;
  -- The insert was skipped and the row it conflicted with is gone again (deleted by a concurrent transaction). Stop
  -- here: with a NULL id the owner check below is NULL (so it passes) and the member rows would fail on a not-null.
  if v_id is null then
    raise exception 'not_found';
  end if;
  if v_existing_owner <> v_owner then
    raise exception 'owner_mismatch';
  end if;
  -- An existing tenant takes the network of this registration and, only from `external`, its kind. A missing
  -- display_name keeps the stored one. proof_public is left alone, except that a tenant that is (or becomes) the
  -- Canary is private.
  if not coalesce(v_inserted, false) then
    update public.tenants set
        kind = case when kind = 'external' then v_kind else kind end,
        network = p->>'network',
        display_name = left(coalesce(p->>'display_name', display_name), 80),
        proof_public = case when (case when kind = 'external' then v_kind else kind end) = 'canary'
                            then false else proof_public end
      where id = v_id;
  end if;
  insert into public.tenant_members (tenant_id, account_id, role) values (v_id, v_owner, 'owner')
    on conflict (tenant_id, account_id) do update set role = 'owner', promoted_from_viewer = false;
  -- Approvers the chain no longer lists: a promoted viewer goes back to viewer, any other approver is removed.
  update public.tenant_members set role = 'viewer', promoted_from_viewer = false
    where tenant_id = v_id and role = 'approver' and promoted_from_viewer and not (account_id = any (v_approvers));
  delete from public.tenant_members
    where tenant_id = v_id and role = 'approver' and not (account_id = any (v_approvers));
  -- `distinct`: a repeated account would make DO UPDATE touch one row twice. A viewer who is an on-chain approver is
  -- promoted and remembered as such; the owner row is never touched (the owner is filtered out, and only viewers are
  -- updated).
  insert into public.tenant_members as m (tenant_id, account_id, role)
    select distinct v_id, a, 'approver' from unnest(v_approvers) as a where a <> v_owner
    on conflict (tenant_id, account_id) do update set role = 'approver', promoted_from_viewer = true
      where m.role = 'viewer';
  return jsonb_build_object('tenant_id', v_id);
end $$;

revoke execute on function public.tenant_register(jsonb) from public, anon, authenticated;
grant execute on function public.tenant_register(jsonb) to service_role;

-- (2) Labels only. A technique is one of the classifier's labels (apps/web/src/lib/canary/technique.ts, TECHNIQUES); the
-- other label columns are short machine identifiers (a rule id, a vault code, an outcome status, an SDK error code),
-- never free text, and the reason a raw spend was not sent is one of a fixed list (apps/web/src/lib/canary/limits.ts,
-- RawSkip).
--
-- contract_code holds a value only when the CONTRACT refused (contract_status = 'refused_by_contract'). What the SDK or the
-- code said, and the code of an error the server caught, go in raw_detail, so the leaderboard never counts one as a code
-- the contract returned.
alter table public.canary_attempts add column raw_detail text;
alter table public.canary_attempts
  add constraint canary_attempts_techniques_known check (techniques <@ array[
    'instruction_override', 'authority_urgency', 'payee_change', 'fake_invoice', 'foreign_address', 'encoding_base64',
    'encoding_hex', 'encoding_morse', 'unicode_obfuscation', 'roleplay', 'over_cap', 'other']::text[]),
  add constraint canary_attempts_labels_short check (
    (code_rule is null or code_rule ~ '^[A-Za-z0-9_.:-]{1,64}$')
    and (raw_detail is null or raw_detail ~ '^[A-Za-z0-9_.:-]{1,64}$')
    and (contract_status is null or contract_status ~ '^[A-Za-z0-9_.:-]{1,64}$')
    and (contract_code is null or contract_code ~ '^[A-Za-z0-9_.:-]{1,64}$')),
  add constraint canary_attempts_skip_reason_known check (raw_skipped_reason is null or raw_skipped_reason in (
    'mode', 'not_refused_by_code', 'not_pay', 'allowance_low', 'visitor_limit', 'global_limit', 'contract_would_accept',
    'check_failed', 'no_amount', 'decision_unreadable', 'sdk_refused', 'error'));

-- One attempt, as the server records it before the cycle runs: { visitor_hash, ip_hash, is_team?, mode, text_sha256,
-- text_length, techniques?, code_status, request_id, est_tokens?, ... }. The result columns can be given too (see
-- canary_attempt_update). The table's own CHECKs decide what is valid. Returns { id }.
create or replace function public.canary_attempt_insert(p jsonb) returns jsonb
language sql set search_path = public, pg_temp as $$
  insert into public.canary_attempts (
    visitor_hash, ip_hash, is_team, mode, text_sha256, text_length, techniques, proposal_action, proposal_mandate_id,
    proposal_amount, code_status, code_rule, raw, raw_skipped_reason, raw_detail, contract_status, contract_code, tx_hash,
    spend_id, decision_hash, raw_decision_hash, request_id, est_tokens, model_prompt_tokens, model_completion_tokens)
  values (
    p->>'visitor_hash', p->>'ip_hash', coalesce((p->>'is_team')::boolean, false), p->>'mode', p->>'text_sha256',
    (p->>'text_length')::integer, array(select jsonb_array_elements_text(coalesce(p->'techniques', '[]'::jsonb))),
    p->>'proposal_action', (p->>'proposal_mandate_id')::bigint, p->>'proposal_amount', p->>'code_status', p->>'code_rule',
    coalesce((p->>'raw')::boolean, false), p->>'raw_skipped_reason', p->>'raw_detail', p->>'contract_status',
    p->>'contract_code', p->>'tx_hash', (p->>'spend_id')::bigint, p->>'decision_hash', p->>'raw_decision_hash',
    p->>'request_id', coalesce((p->>'est_tokens')::integer, 0), (p->>'model_prompt_tokens')::integer,
    (p->>'model_completion_tokens')::integer)
  returning jsonb_build_object('id', id)
$$;

-- The end of a cycle: p = { id, <result columns> }. Every result column is REPLACED by what p gives (one it does not give
-- is cleared); who made the attempt, the hash and length of the text, the labels, the mode and the estimate never change.
-- An unknown id is not_found, an id that is not a uuid is invalid_input.
create or replace function public.canary_attempt_update(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id text := p->>'id';
  v_out uuid;
begin
  if v_id is null or v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_input';
  end if;
  update public.canary_attempts set
      proposal_action = p->>'proposal_action',
      proposal_mandate_id = (p->>'proposal_mandate_id')::bigint,
      proposal_amount = p->>'proposal_amount',
      code_status = p->>'code_status',
      code_rule = p->>'code_rule',
      raw = coalesce((p->>'raw')::boolean, false),
      raw_skipped_reason = p->>'raw_skipped_reason',
      raw_detail = p->>'raw_detail',
      contract_status = p->>'contract_status',
      contract_code = p->>'contract_code',
      tx_hash = p->>'tx_hash',
      spend_id = (p->>'spend_id')::bigint,
      decision_hash = p->>'decision_hash',
      raw_decision_hash = p->>'raw_decision_hash',
      model_prompt_tokens = (p->>'model_prompt_tokens')::integer,
      model_completion_tokens = (p->>'model_completion_tokens')::integer
    where id = v_id::uuid
    returning id into v_out;
  if v_out is null then
    raise exception 'not_found';
  end if;
  return jsonb_build_object('id', v_out);
end $$;

-- Model tokens used in the UTC day of p.now (default: now), across all attempts: what the model reported, else the
-- estimate the server made before the call. The daily budget (canary/limits.ts) reads it.
create or replace function public.canary_tokens_today(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with d as (
    select date_trunc('day', coalesce((p->>'now')::timestamptz, now()) at time zone 'UTC') at time zone 'UTC' as day_start)
  select to_jsonb(coalesce(sum(coalesce(a.model_prompt_tokens + a.model_completion_tokens, a.est_tokens)), 0)::bigint)
  from public.canary_attempts a, d
  where a.created_at >= d.day_start and a.created_at < d.day_start + interval '24 hours'
$$;

-- The newest attempts, p = { limit? } (a plain integer, default 50, at most 100, at least 1; anything else is the
-- default). Labels, outcomes and public transaction hashes only: no visitor hash, IP hash, text hash or request id.
create or replace function public.public_canary_feed(p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp set statement_timeout = '5s' as $$
  select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]'::jsonb) from (
    select a.created_at, jsonb_build_object(
        'created_at', a.created_at, 'techniques', to_jsonb(a.techniques), 'proposal_action', a.proposal_action,
        'code_status', a.code_status, 'code_rule', a.code_rule, 'raw', a.raw, 'raw_skipped_reason', a.raw_skipped_reason,
        'raw_detail', a.raw_detail, 'contract_status', a.contract_status, 'contract_code', a.contract_code,
        'tx_hash', a.tx_hash, 'is_team', a.is_team) as j
    from public.canary_attempts a
    order by a.created_at desc
    limit case when (p->>'limit') ~ '^[0-9]{1,9}$' then least(greatest((p->>'limit')::integer, 1), 100) else 50 end) x
$$;

-- The leaderboard (service role only: the page reads it on the server, behind a cache). `browsers` counts distinct
-- visitor-cookie hashes of outside visitors and `addresses` distinct IP hashes: a script that sends no cookie adds a
-- browser per request, one that rotates addresses adds an address, so a page shows the LOWER of the two and calls it
-- what it is. The team's own attempts are counted apart and never in the outside figures (contract_codes included).
-- `contract_codes` counts only what the contract itself returned. There is deliberately no "paid to an attacker" figure:
-- nothing here measures it. The page states what is true by construction (the contract pays only a mandate's payee).
create or replace function public.public_canary_leaderboard(p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp set statement_timeout = '5s' as $$
  select jsonb_build_object(
    'browsers', (select count(distinct visitor_hash) from public.canary_attempts where not is_team),
    'addresses', (select count(distinct ip_hash) from public.canary_attempts where not is_team),
    'attempts_external', (select count(*) from public.canary_attempts where not is_team),
    'attempts_team', (select count(*) from public.canary_attempts where is_team),
    'raw_external', (select count(*) from public.canary_attempts where raw and not is_team),
    'techniques', coalesce((
      select jsonb_agg(jsonb_build_object('technique', t.technique, 'attempts', t.attempts, 'refused_by_code', t.by_code,
                                          'refused_by_contract', t.by_contract, 'held', t.held) order by t.attempts desc, t.technique)
      from (
        select x.technique, count(*) as attempts,
               count(*) filter (where a.code_status = 'refused_by_code') as by_code,
               count(*) filter (where a.contract_status = 'refused_by_contract') as by_contract,
               count(*) filter (where a.code_status = 'held' or a.contract_status = 'held') as held
        from public.canary_attempts a, unnest(a.techniques) as x(technique)
        where not a.is_team group by x.technique) t), '[]'::jsonb),
    'contract_codes', coalesce((
      select jsonb_agg(jsonb_build_object('code', c.contract_code, 'n', c.n) order by c.n desc, c.contract_code)
      from (select contract_code, count(*) as n from public.canary_attempts
            where contract_code is not null and contract_status = 'refused_by_contract' and not is_team
            group by contract_code) c), '[]'::jsonb))
$$;

revoke execute on function public.canary_attempt_insert(jsonb), public.canary_attempt_update(jsonb),
  public.canary_tokens_today(jsonb), public.public_canary_feed(jsonb), public.public_canary_leaderboard(jsonb)
  from public, anon, authenticated;
grant execute on function public.canary_attempt_insert(jsonb), public.canary_attempt_update(jsonb),
  public.canary_tokens_today(jsonb), public.public_canary_leaderboard(jsonb) to service_role;
grant execute on function public.public_canary_feed(jsonb) to anon, authenticated, service_role;
