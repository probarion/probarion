import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memberRole, type RegisterTenantInput, registerTenant } from "@/lib/db/tenants";
import { freshDb } from "./harness";
import { pgliteDb } from "./pglite-db";

// Migration 0005 (R11, parked from Task 3): re-registering a vault updates its kind and display name, and a viewer who
// was promoted to approver goes back to viewer (not out) when the chain no longer lists them. Migration 0012 (W-NET-R4):
// a tenant's network is fixed once it is registered, so a registration that names another network is refused.

describe("tenant_register re-registration (0005)", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  const base: RegisterTenantInput = {
    vaultId: "re.vaults.probarion.near",
    network: "testnet",
    kind: "external",
    displayName: "re",
    owner: "re.near",
    approvers: ["cfo.near"],
  };
  const tenant = async (vault: string) =>
    (
      await pg.query<{
        kind: string;
        network: string;
        display_name: string;
        proof_public: boolean;
      }>(
        "select kind, network, display_name, proof_public from public.tenants where vault_id = $1",
        [vault],
      )
    ).rows[0];
  const members = async (tenantId: string) =>
    (
      await pg.query<{ account_id: string; role: string; promoted_from_viewer: boolean }>(
        `select account_id, role, promoted_from_viewer from public.tenant_members
          where tenant_id = $1 order by account_id`,
        [tenantId],
      )
    ).rows;

  it("updates kind and display name on the same network: external becomes team", async () => {
    const db = pgliteDb(pg);
    const first = await registerTenant(db, base);
    expect(await tenant(base.vaultId)).toEqual({
      kind: "external",
      network: "testnet",
      display_name: "re",
      proof_public: false,
    });
    const again = await registerTenant(db, { ...base, kind: "team", displayName: "Re team" });
    expect(again.tenant_id).toBe(first.tenant_id);
    // proof_public is the owner's setting: re-registration never flips it.
    expect(await tenant(base.vaultId)).toEqual({
      kind: "team",
      network: "testnet",
      display_name: "Re team",
      proof_public: false,
    });
    // Never back down: a vault that leaves TEAM_VAULT_IDS stays team, and team never becomes canary.
    await registerTenant(db, { ...base, kind: "external" });
    expect((await tenant(base.vaultId))?.kind).toBe("team");
    await registerTenant(db, { ...base, kind: "canary" });
    expect((await tenant(base.vaultId))?.kind).toBe("team");
  });

  it("external can also become canary, once", async () => {
    const db = pgliteDb(pg);
    const vaultId = "can.vaults.probarion.near";
    await registerTenant(db, { ...base, vaultId });
    await registerTenant(db, { ...base, vaultId, kind: "canary" });
    expect((await tenant(vaultId))?.kind).toBe("canary");
    await registerTenant(db, { ...base, vaultId, kind: "team" });
    expect((await tenant(vaultId))?.kind).toBe("canary");
  });

  it("a first registration without a display name takes the vault name before the first dot", async () => {
    const db = pgliteDb(pg);
    await db.rpc("tenant_register", {
      vault_id: "first.vaults.probarion.near",
      network: "testnet",
      kind: "external",
      owner_account: base.owner,
      approvers: [],
    });
    expect((await tenant("first.vaults.probarion.near"))?.display_name).toBe("first");
    await registerTenant(db, {
      ...base,
      vaultId: "second.vaults.probarion.near",
      displayName: null,
    });
    expect((await tenant("second.vaults.probarion.near"))?.display_name).toBe("second");
  });

  it("keeps the stored display name when none is given, and trims a long one to 80", async () => {
    const db = pgliteDb(pg);
    const vaultId = "named.vaults.probarion.near";
    await registerTenant(db, { ...base, vaultId, displayName: "Named" });
    await db.rpc("tenant_register", {
      vault_id: vaultId,
      network: "testnet",
      kind: "external",
      owner_account: base.owner,
      approvers: [],
    });
    expect((await tenant(vaultId))?.display_name).toBe("Named");
    await registerTenant(db, { ...base, vaultId, displayName: "x".repeat(100) });
    expect((await tenant(vaultId))?.display_name).toBe("x".repeat(80));
  });

  it("a promoted viewer who leaves the approver list goes back to viewer; a plain approver is removed", async () => {
    const db = pgliteDb(pg);
    const vaultId = "promo.vaults.probarion.near";
    const { tenant_id } = await registerTenant(db, { ...base, vaultId, approvers: ["plain.near"] });
    await pg.query(
      `insert into public.tenant_members (tenant_id, account_id, role) values ($1, 'viewer.near', 'viewer')`,
      [tenant_id],
    );
    await registerTenant(db, { ...base, vaultId, approvers: ["plain.near", "viewer.near"] });
    expect(await members(tenant_id)).toEqual([
      { account_id: "plain.near", role: "approver", promoted_from_viewer: false },
      { account_id: "re.near", role: "owner", promoted_from_viewer: false },
      { account_id: "viewer.near", role: "approver", promoted_from_viewer: true },
    ]);
    // A repeat with the same list changes nothing (the promotion is not lost on the second pass).
    await registerTenant(db, { ...base, vaultId, approvers: ["plain.near", "viewer.near"] });
    expect((await members(tenant_id)).find((m) => m.account_id === "viewer.near")).toEqual({
      account_id: "viewer.near",
      role: "approver",
      promoted_from_viewer: true,
    });
    await registerTenant(db, { ...base, vaultId, approvers: [] });
    expect(await members(tenant_id)).toEqual([
      { account_id: "re.near", role: "owner", promoted_from_viewer: false },
      { account_id: "viewer.near", role: "viewer", promoted_from_viewer: false },
    ]);
    expect((await memberRole(db, vaultId, "viewer.near"))?.role).toBe("viewer");
    expect(await memberRole(db, vaultId, "plain.near")).toBeNull();
  });

  it("still refuses another owner, and changes nothing when it does", async () => {
    const db = pgliteDb(pg);
    const vaultId = "owned.vaults.probarion.near";
    await registerTenant(db, { ...base, vaultId });
    await expect(
      registerTenant(db, { ...base, vaultId, owner: "eve.near", kind: "team", displayName: "Eve" }),
    ).rejects.toMatchObject({ code: "owner_mismatch" });
    expect(await tenant(vaultId)).toMatchObject({ kind: "external", display_name: "re" });
  });

  it("refuses a registration on another network, whoever the owner is, and changes nothing", async () => {
    const db = pgliteDb(pg);
    for (const [from, to] of [
      ["testnet", "mainnet"],
      ["mainnet", "testnet"],
    ] as const) {
      const vaultId = `fixed-${from}.vaults.probarion.near`;
      const { tenant_id } = await registerTenant(db, {
        ...base,
        vaultId,
        network: from,
        approvers: ["cfo.near"],
      });
      const row = await tenant(vaultId);
      const people = await members(tenant_id);
      // The owner, with another kind, another name and another list of approvers: the network is the only difference
      // that matters, and it alone is enough to refuse.
      await expect(
        registerTenant(db, {
          ...base,
          vaultId,
          network: to,
          kind: "team",
          displayName: "Moved",
          approvers: ["mallory.near"],
        }),
      ).rejects.toMatchObject({ code: "network_mismatch" });
      expect(await tenant(vaultId)).toEqual(row);
      expect(await members(tenant_id)).toEqual(people);
      // The same network still re-registers, right after the refused call.
      await registerTenant(db, { ...base, vaultId, network: from, approvers: ["cfo.near"] });
      expect((await tenant(vaultId))?.network).toBe(from);
    }
  });

  it("checks the owner before the network: another owner on another network is owner_mismatch", async () => {
    const db = pgliteDb(pg);
    const vaultId = "both-wrong.vaults.probarion.near";
    await registerTenant(db, { ...base, vaultId });
    await expect(
      registerTenant(db, { ...base, vaultId, owner: "eve.near", network: "mainnet" }),
    ).rejects.toMatchObject({ code: "owner_mismatch" });
  });

  it("is still service_role only", async () => {
    const r = await pg.query<{ grantee: string }>(
      `select distinct a.grantee::regrole::text as grantee
         from pg_proc p, aclexplode(p.proacl) a
        where p.oid = 'public.tenant_register(jsonb)'::regprocedure and a.privilege_type = 'EXECUTE'
          and a.grantee <> p.proowner`,
    );
    expect(r.rows.map((x) => x.grantee)).toEqual(["service_role"]);
  });
});
