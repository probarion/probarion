-- Ledger persistence for the SDK's LedgerStore (interfaces §6, §9). Append-only, contiguous and fork-free per tenant.
--
-- Hashing, signing and linking are the SDK's and core's: SQL cannot canonicalise JSON (RFC 8785) or verify Ed25519, so
-- it does not pretend to. What SQL guarantees is the shape of the chain: one entry per (tenant, seq), each following the
-- head it was built on, none rewritten, none removed. The verifier (core `runChecks`) is still the judge of signatures.
--
-- Every function here is `(p jsonb) returns jsonb` (Decision D2). The ledger_* functions are executable by the service
-- role only; the server calls them after its own membership check, so `tenant_id` is always the session's tenant (plan 04
-- "RULE FOR EVERY LATER ROUTE"). Only public_vault and public_ledger are open to anon, and both return data only for a
-- vault whose owner set `tenants.proof_public`.

-- Core hashes `canonicalJson(body)` (RFC 8785: keys sorted), which does not depend on key order, so the hash and the
-- signature would survive jsonb either way. `body_text` exists for byte parity with the SDK's FileLedgerStore, whose
-- JSONL line is `JSON.stringify(entry)`: jsonb sorts object keys (shorter first, then bytewise), so a body read back
-- from the `body` column is the same value but not the same bytes. `body_text` is `JSON.stringify(entry.body)` verbatim;
-- `body` stays for SQL (RLS reads, kind, request_id). NULL only for a row inserted by hand: ledger_append always sets it.
alter table public.ledger_entries add column body_text text;
alter table public.ledger_entries add constraint ledger_entries_body_text_is_body
  check (body_text is null or body_text::jsonb = body);

-- F29: the row trigger from 0001 stops UPDATE and DELETE for every role, the table owner included, but a row trigger
-- never fires on TRUNCATE. 0001 revokes the TRUNCATE privilege from every Supabase role; this statement trigger also
-- stops the table owner, and a TRUNCATE ... CASCADE started from `tenants`.
create trigger ledger_entries_no_truncate before truncate on public.ledger_entries
  for each statement execute function public.ledger_entries_append_only();

-- Every write goes through ledger_append (security definer, below): service_role has no INSERT, UPDATE or DELETE on the table.
revoke insert, update, delete on public.ledger_entries from service_role;

-- A second line of defence against a fork, independent of ledger_append: no two entries of one tenant follow the same
-- predecessor. Together with the primary key (tenant_id, seq) a chain cannot branch even if a row is inserted by hand.
-- (Rows with no prev_link in their body, such as the hand-made rows of the RLS tests, are NULL here and never collide.)
create unique index ledger_entries_one_successor on public.ledger_entries (tenant_id, (body->>'prev_link'));

-- p->>'tenant_id' as a uuid, or invalid_input: a malformed id must fail loudly, not read as an empty ledger.
create or replace function public.ledger_tenant(p jsonb) returns uuid
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_text text := p->>'tenant_id';
begin
  if v_text is null or v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_input';
  end if;
  return v_text::uuid;
end $$;

-- stable, not immutable: created_at is a timestamptz, and its JSON text follows the session TimeZone.
create or replace function public.ledger_entry_json(e public.ledger_entries) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('seq', e.seq, 'body', e.body, 'body_text', e.body_text, 'body_hash', e.body_hash,
                            'sig', e.sig, 'signer', e.signer, 'link', e.link, 'kind', e.kind,
                            'created_at', e.created_at)
$$;

create or replace function public.ledger_head(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select public.ledger_entry_json(e) from public.ledger_entries e
  where e.tenant_id = public.ledger_tenant(p) order by e.seq desc limit 1
$$;

create or replace function public.ledger_all(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(public.ledger_entry_json(e) order by e.seq), '[]'::jsonb)
  from public.ledger_entries e where e.tenant_id = public.ledger_tenant(p)
$$;

create or replace function public.ledger_get(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select public.ledger_entry_json(e) from public.ledger_entries e
  where e.tenant_id = public.ledger_tenant(p) and e.body_hash = p->>'body_hash'
$$;

-- At most 500 entries from `from_seq` (inclusive), oldest first. The watcher pages with it.
create or replace function public.ledger_since(p jsonb) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x.j order by x.seq), '[]'::jsonb) from (
    select e.seq, public.ledger_entry_json(e) as j from public.ledger_entries e
    where e.tenant_id = public.ledger_tenant(p) and e.seq >= greatest(coalesce((p->>'from_seq')::integer, 0), 0)
    order by e.seq limit 500) x
$$;

-- Compare-and-append. p = {
--   tenant_id,
--   entry:     { body_hash, sig, signer, link },       -- built and signed by core
--   body_text: JSON.stringify(entry.body),             -- the one copy of the body; `body` is derived from it here
--   expect:    { seq, prev_link }                      -- the position the caller built on
-- }
-- The entry is written only if the tenant's head gives exactly `expect` (and the entry sits at that position). If the
-- head moved it raises ledger_conflict and writes nothing. Appends of one tenant are serialised by a transaction-scoped
-- advisory lock, so two concurrent appends cannot both see the same head. The primary key (tenant_id, seq) and the
-- unique index on (tenant_id, prev_link) are the backstop if this function were ever bypassed: should the insert still
-- lose a race (another isolation level, a lock that did not serialise), the unique violation is reported as
-- ledger_conflict too, so the caller always sees the same contract.
-- (READ COMMITTED, which PostgREST uses: the head is read after the lock is held, so it is the latest committed one.)
-- SECURITY DEFINER: service_role cannot write the table itself (revoked above), so this function is the only way in.
-- Its search_path is pinned, and only service_role may execute it.
create or replace function public.ledger_append(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid := public.ledger_tenant(p);
  e jsonb := p->'entry';
  x jsonb := p->'expect';
  v_text text := p->>'body_text';
  v_body jsonb;
  v_ok boolean;
  v_vault text;
  v_seq integer;
  v_prev text;
  v_xseq integer;
  v_xprev text;
  v_head_seq integer;
  v_head_link text;
  v_next_seq integer;
  v_next_prev text;
begin
  if jsonb_typeof(e) is distinct from 'object' or jsonb_typeof(x) is distinct from 'object' or v_text is null then
    raise exception 'invalid_input';
  end if;
  begin
    v_body := v_text::jsonb;
  exception when others then
    raise exception 'invalid_input'; -- not JSON, or text jsonb cannot hold (U+0000)
  end;

  -- Shape only (NULL, a missing field, counts as bad: coalesce below). The hashes themselves are core's business.
  v_ok := jsonb_typeof(v_body) = 'object'
    and jsonb_typeof(v_body->'seq') = 'number' and (v_body->>'seq') ~ '^(0|[1-9][0-9]{0,8})$'
    and (v_body->>'prev_link') ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(v_body->'vault') = 'string'
    and (v_body->>'kind') in ('decision', 'payment', 'approval', 'anchor', 'note')
    and (e->>'body_hash') ~ '^[0-9a-f]{64}$' and (e->>'link') ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(e->'sig') = 'string' and length(e->>'sig') > 0
    and jsonb_typeof(e->'signer') = 'string' and length(e->>'signer') > 0
    and jsonb_typeof(x->'seq') = 'number' and (x->>'seq') ~ '^(0|[1-9][0-9]{0,8})$'
    and (x->>'prev_link') ~ '^[0-9a-f]{64}$';
  if not coalesce(v_ok, false) then
    raise exception 'invalid_input';
  end if;
  v_seq := (v_body->>'seq')::integer;
  v_prev := v_body->>'prev_link';
  v_xseq := (x->>'seq')::integer;
  v_xprev := x->>'prev_link';

  select t.vault_id into v_vault from public.tenants t where t.id = v_tenant;
  if not found then
    raise exception 'not_found';
  end if;
  if v_body->>'vault' <> v_vault then
    raise exception 'invalid_input: the entry is for vault %, not the tenant''s vault %', v_body->>'vault', v_vault;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('probarion/ledger/' || v_tenant::text, 0));
  select l.seq, l.link into v_head_seq, v_head_link from public.ledger_entries l
    where l.tenant_id = v_tenant order by l.seq desc limit 1;
  v_next_seq := coalesce(v_head_seq + 1, 0);
  v_next_prev := coalesce(v_head_link, repeat('0', 64));

  -- The head is not where the caller built its entry: someone else appended first (or the caller read a stale head).
  if v_xseq <> v_next_seq or v_xprev <> v_next_prev then
    raise exception 'ledger_conflict: the head gives seq % on prev_link %', v_next_seq, v_next_prev;
  end if;
  -- The head is where the caller said, but the entry it sent was built for another position.
  if v_seq <> v_xseq or v_prev <> v_xprev then
    raise exception 'invalid_input: the entry is not at the position it expects';
  end if;

  begin
    insert into public.ledger_entries (tenant_id, seq, kind, body, body_text, body_hash, sig, signer, link, request_id)
    values (v_tenant, v_seq, v_body->>'kind', v_body, v_text, e->>'body_hash', e->>'sig', e->>'signer', e->>'link',
            coalesce(v_body->>'request_id', ''));
  exception when unique_violation then
    -- Someone else took this seq, this predecessor or this hash first. Report where the head is now (the winner is
    -- committed, so a fresh statement sees it), exactly as the check above does.
    select l.seq, l.link into v_head_seq, v_head_link from public.ledger_entries l
      where l.tenant_id = v_tenant order by l.seq desc limit 1;
    raise exception 'ledger_conflict: the head gives seq % on prev_link %',
      coalesce(v_head_seq + 1, 0), coalesce(v_head_link, repeat('0', 64));
  end;
  return jsonb_build_object('seq', v_seq, 'link', e->>'link');
end $$;

-- Public, read-only views of proof_public vaults (used by /proof and snapshot.json with the anon key).
-- Both answer "nothing" (null, []) for a vault that is private AND for one that does not exist, so they say nothing
-- about who is a customer.
create or replace function public.public_vault(p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('vault_id', t.vault_id, 'network', t.network, 'kind', t.kind, 'display_name', t.display_name)
  from public.tenants t where t.vault_id = p->>'vault_id' and t.proof_public
$$;

-- Paged like ledger_since: p = { vault_id, from_seq?, limit? } returns at most `limit` rows (default and maximum 500, at
-- least 1) with seq >= from_seq (default 0), oldest first. A from_seq or limit that is not a plain non-negative integer
-- is ignored (the default applies), so odd input never errors. Each row carries the body once, as body_text
-- (a row made by hand, without body_text, falls back to its jsonb text): { seq, body_text, body_hash, sig, signer, link,
-- kind, created_at }. Anyone with the anon key can call this, so the page size is bounded.
create or replace function public.public_ledger(p jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x.j order by x.seq), '[]'::jsonb) from (
    select e.seq,
           jsonb_build_object('seq', e.seq, 'body_text', coalesce(e.body_text, e.body::text), 'body_hash', e.body_hash,
                              'sig', e.sig, 'signer', e.signer, 'link', e.link, 'kind', e.kind,
                              'created_at', e.created_at) as j
    from public.ledger_entries e join public.tenants t on t.id = e.tenant_id
    where t.vault_id = p->>'vault_id' and t.proof_public
      and e.seq >= case when (p->>'from_seq') ~ '^[0-9]{1,9}$' then (p->>'from_seq')::integer else 0 end
    order by e.seq
    limit case when (p->>'limit') ~ '^[0-9]{1,9}$' then least(greatest((p->>'limit')::integer, 1), 500) else 500 end) x
$$;

revoke execute on function
  public.ledger_tenant(jsonb), public.ledger_entry_json(public.ledger_entries), public.ledger_head(jsonb),
  public.ledger_all(jsonb), public.ledger_get(jsonb), public.ledger_since(jsonb), public.ledger_append(jsonb),
  public.public_vault(jsonb), public.public_ledger(jsonb)
  from public, anon, authenticated;
grant execute on function
  public.ledger_tenant(jsonb), public.ledger_entry_json(public.ledger_entries), public.ledger_head(jsonb),
  public.ledger_all(jsonb), public.ledger_get(jsonb), public.ledger_since(jsonb), public.ledger_append(jsonb)
  to service_role;
grant execute on function public.public_vault(jsonb), public.public_ledger(jsonb) to anon, authenticated, service_role;
