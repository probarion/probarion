-- The Canary's functions (plan 04 Task 17, spec §14.3, ruling W-T17-R0). Attempts keep hashes and labels, never the
-- visitor's message: canary_attempts has no column that could hold it, and this file makes the label columns short
-- machine labels, so a stranger's words cannot reach the public feed through one either.
--
-- Four functions, all `(p jsonb) returns jsonb`, all with a pinned search_path:
--   - canary_attempt_insert, canary_tokens_today: service_role only. The server calls them after its own checks. They
--     run as their caller, which is the service role, the only role that can write the table.
--   - public_canary_feed, public_canary_leaderboard: security definer, executable by anon (the public key) and by
--     authenticated. They are public by design (the Canary is a public challenge), not opt-in like proof_public, so the
--     gate is the shape of the answer: labels, counts and public transaction hashes, never a visitor or IP hash.

-- Labels only. A technique is one of the classifier's labels (apps/web/src/lib/canary/technique.ts, TECHNIQUES); the
-- other label columns are short machine identifiers (a rule id, a vault code, an outcome status), never free text.
alter table public.canary_attempts
  add constraint canary_attempts_techniques_known check (techniques <@ array[
    'instruction_override', 'authority_urgency', 'payee_change', 'fake_invoice', 'foreign_address', 'encoding_base64',
    'encoding_hex', 'encoding_morse', 'unicode_obfuscation', 'roleplay', 'over_cap', 'other']::text[]),
  add constraint canary_attempts_labels_short check (
    (code_rule is null or code_rule ~ '^[A-Za-z0-9_.:-]{1,64}$')
    and (raw_skipped_reason is null or raw_skipped_reason ~ '^[A-Za-z0-9_.:-]{1,64}$')
    and (contract_status is null or contract_status ~ '^[A-Za-z0-9_.:-]{1,64}$')
    and (contract_code is null or contract_code ~ '^[A-Za-z0-9_.:-]{1,64}$'));

-- One attempt, as the server records it: { visitor_hash, ip_hash, is_team?, mode, text_sha256, text_length, techniques?,
-- proposal_action?, proposal_mandate_id?, proposal_amount?, code_status, code_rule?, raw?, raw_skipped_reason?,
-- contract_status?, contract_code?, tx_hash?, spend_id?, decision_hash?, raw_decision_hash?, request_id, est_tokens?,
-- model_prompt_tokens?, model_completion_tokens? }. The table's own CHECKs decide what is valid. Returns { id }.
create or replace function public.canary_attempt_insert(p jsonb) returns jsonb
language sql set search_path = public, pg_temp as $$
  insert into public.canary_attempts (
    visitor_hash, ip_hash, is_team, mode, text_sha256, text_length, techniques, proposal_action, proposal_mandate_id,
    proposal_amount, code_status, code_rule, raw, raw_skipped_reason, contract_status, contract_code, tx_hash, spend_id,
    decision_hash, raw_decision_hash, request_id, est_tokens, model_prompt_tokens, model_completion_tokens)
  values (
    p->>'visitor_hash', p->>'ip_hash', coalesce((p->>'is_team')::boolean, false), p->>'mode', p->>'text_sha256',
    (p->>'text_length')::integer, array(select jsonb_array_elements_text(coalesce(p->'techniques', '[]'::jsonb))),
    p->>'proposal_action', (p->>'proposal_mandate_id')::bigint, p->>'proposal_amount', p->>'code_status', p->>'code_rule',
    coalesce((p->>'raw')::boolean, false), p->>'raw_skipped_reason', p->>'contract_status', p->>'contract_code',
    p->>'tx_hash', (p->>'spend_id')::bigint, p->>'decision_hash', p->>'raw_decision_hash', p->>'request_id',
    coalesce((p->>'est_tokens')::integer, 0), (p->>'model_prompt_tokens')::integer,
    (p->>'model_completion_tokens')::integer)
  returning jsonb_build_object('id', id)
$$;

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
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]'::jsonb) from (
    select a.created_at, jsonb_build_object(
        'created_at', a.created_at, 'techniques', to_jsonb(a.techniques), 'proposal_action', a.proposal_action,
        'code_status', a.code_status, 'code_rule', a.code_rule, 'raw', a.raw, 'raw_skipped_reason', a.raw_skipped_reason,
        'contract_status', a.contract_status, 'contract_code', a.contract_code, 'tx_hash', a.tx_hash,
        'is_team', a.is_team) as j
    from public.canary_attempts a
    order by a.created_at desc
    limit case when (p->>'limit') ~ '^[0-9]{1,9}$' then least(greatest((p->>'limit')::integer, 1), 100) else 50 end) x
$$;

-- The leaderboard. `participants` counts distinct browsers (distinct visitor-cookie hashes of outside visitors), not
-- people: a visitor who clears cookies is counted again. The team's own attempts are counted apart and never in the
-- outside figures. There is deliberately no "paid to an attacker" figure: nothing here measures it. The page states what
-- is true by construction (the contract pays only a mandate's payee) and links /proof, where it can be checked.
create or replace function public.public_canary_leaderboard(p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'participants', (select count(distinct visitor_hash) from public.canary_attempts where not is_team),
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
      from (select contract_code, count(*) as n from public.canary_attempts where contract_code is not null
            group by contract_code) c), '[]'::jsonb))
$$;

revoke execute on function public.canary_attempt_insert(jsonb), public.canary_tokens_today(jsonb),
  public.public_canary_feed(jsonb), public.public_canary_leaderboard(jsonb) from public, anon, authenticated;
grant execute on function public.canary_attempt_insert(jsonb), public.canary_tokens_today(jsonb) to service_role;
grant execute on function public.public_canary_feed(jsonb), public.public_canary_leaderboard(jsonb)
  to anon, authenticated, service_role;
