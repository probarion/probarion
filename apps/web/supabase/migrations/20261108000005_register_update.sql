-- Re-registration (plan 04 Task 8, R11; parked from Task 3's review). Two changes to tenant_register:
--
-- 1. Registering a vault that is already registered updates its network, upgrades its kind and may rename it.
--    - kind only moves up, from `external` to `team` or `canary` (TEAM_VAULT_IDS / CANARY_VAULT_ID at the time of
--      the call), never back down: a vault that leaves the list, or a call with another kind, changes nothing.
--    - display_name changes only when the call gives one. Without one, a new tenant takes the vault name before its
--      first dot and a registered one keeps its name (a re-sync or the register form never overwrites it).
--    - proof_public is the owner's own setting and is never changed here.
-- 2. A viewer whom an earlier registration promoted to approver (because the chain lists them) goes back to viewer
--    when the chain stops listing them, instead of losing access. tenant_members.promoted_from_viewer remembers the
--    promotion; an approver who was never a viewer is still removed.
--
-- The owner check is unchanged and comes before any update: a vault is never re-registered under another owner, and a
-- refused call changes nothing. Like 0002, the function runs as its caller (security invoker) and is service_role only.

alter table public.tenant_members add column promoted_from_viewer boolean not null default false;
-- Only approver rows can carry the flag: a viewer, an owner or a plain approver has it false.
alter table public.tenant_members add constraint tenant_members_promotion_is_approver
  check (not promoted_from_viewer or role = 'approver');

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
          v_kind in ('team', 'canary'))
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
  -- (1) An existing tenant takes the network of this registration and, only from `external`, its kind. A missing
  -- display_name keeps the stored one. proof_public is left alone.
  if not coalesce(v_inserted, false) then
    update public.tenants set
        kind = case when kind = 'external' then v_kind else kind end,
        network = p->>'network',
        display_name = left(coalesce(p->>'display_name', display_name), 80)
      where id = v_id;
  end if;
  insert into public.tenant_members (tenant_id, account_id, role) values (v_id, v_owner, 'owner')
    on conflict (tenant_id, account_id) do update set role = 'owner', promoted_from_viewer = false;
  -- (2) Approvers the chain no longer lists: a promoted viewer goes back to viewer, any other approver is removed.
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

-- `create or replace` keeps the grants of 0002; they are stated again so this file reads on its own.
revoke execute on function public.tenant_register(jsonb) from public, anon, authenticated;
grant execute on function public.tenant_register(jsonb) to service_role;
