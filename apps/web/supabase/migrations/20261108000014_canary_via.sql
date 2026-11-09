-- Where a Canary visitor came from (site audit P1-17, GRW-08), so the team can tell which of its links bring people.
--
-- A link of ours names its source in the address, `/canary?via=x`, from a closed set the app keeps
-- (apps/web/src/lib/canary/via.ts). The form sends that word with the attempt, the attempt route checks it against
-- the set again, and anything else is stored as no source. There is no cookie for it and nothing else about the
-- request: one fixed word per kind of link.
--
-- 1. canary_attempts.via: null, or a short lowercase word. The column holds the word's shape, not the set, so a new
--    source is a change in the app only, and no visitor's text can land in it. It is not in the public feed or the
--    leaderboard (0012 lists their columns), and canary_attempt_update leaves it alone, as it leaves who made the
--    attempt. docs/ops/metrics.md has the query that counts attempts by source.
-- 2. canary_attempt_insert: 0009's, plus p.via. Everything else is as it was, and so are the grants (create or replace
--    keeps them: service role only). The 0009 function ignores a `via` it is given, so the app can be deployed before
--    or after this file: until it runs, attempts are stored with no source.

alter table public.canary_attempts
  add column via text check (via ~ '^[a-z]{1,16}$');

create or replace function public.canary_attempt_insert(p jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if coalesce(p->>'network', '') not in ('mainnet', 'testnet') then
    raise exception 'invalid_input';
  end if;
  insert into public.canary_attempts (
    visitor_hash, ip_hash, is_team, mode, text_sha256, text_length, techniques, proposal_action, proposal_mandate_id,
    proposal_amount, code_status, code_rule, raw, raw_skipped_reason, raw_detail, contract_status, contract_code, tx_hash,
    spend_id, decision_hash, raw_decision_hash, request_id, est_tokens, model_prompt_tokens, model_completion_tokens,
    network, via)
  values (
    p->>'visitor_hash', p->>'ip_hash', coalesce((p->>'is_team')::boolean, false), p->>'mode', p->>'text_sha256',
    (p->>'text_length')::integer, array(select jsonb_array_elements_text(coalesce(p->'techniques', '[]'::jsonb))),
    p->>'proposal_action', (p->>'proposal_mandate_id')::bigint, p->>'proposal_amount', p->>'code_status', p->>'code_rule',
    coalesce((p->>'raw')::boolean, false), p->>'raw_skipped_reason', p->>'raw_detail', p->>'contract_status',
    p->>'contract_code', p->>'tx_hash', (p->>'spend_id')::bigint, p->>'decision_hash', p->>'raw_decision_hash',
    p->>'request_id', coalesce((p->>'est_tokens')::integer, 0), (p->>'model_prompt_tokens')::integer,
    (p->>'model_completion_tokens')::integer, p->>'network', p->>'via')
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;
