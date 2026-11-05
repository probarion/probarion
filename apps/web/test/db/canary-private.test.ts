import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerTenant, setTenantSettings } from "@/lib/db/tenants";
import { freshDb, SUPABASE_STUB } from "./harness";
import { pgliteDb } from "./pglite-db";

// The Canary's ledger is private (ruling W-T17-R1): the model quotes what visitors type, and a public ledger is
// append-only, so nothing a visitor types may reach anon. Migration 0008 makes every canary tenant private, and
// tenant_register never makes one public again.

const MIGRATIONS = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const CANARY_MIGRATION = "20261108000008_canary.sql";

describe("the migration that makes existing Canary tenants private", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(SUPABASE_STUB);
    for (const f of files) {
      if (f >= CANARY_MIGRATION) break;
      await pg.exec(readFileSync(`${MIGRATIONS}/${f}`, "utf8"));
    }
    // What 0002 and 0005 did: a canary tenant is registered with a public proof, so is a team's.
    for (const [vault, kind, proofPublic] of [
      ["old-canary.vaults.probarion.near", "canary", true],
      ["old-canary2.vaults.probarion.near", "canary", false],
      ["old-team.vaults.probarion.near", "team", true],
      ["old-ext.vaults.probarion.near", "external", true],
    ] as const) {
      await pg.query(
        "insert into public.tenants (vault_id, network, kind, owner_account, proof_public) values ($1, 'mainnet', $2, 'o.near', $3)",
        [vault, kind, proofPublic],
      );
    }
    await pg.exec(readFileSync(`${MIGRATIONS}/${CANARY_MIGRATION}`, "utf8"));
  });
  afterAll(async () => {
    await pg.close();
  });

  it("sets proof_public false for every canary tenant and leaves every other kind alone", async () => {
    const r = await pg.query<{ vault_id: string; proof_public: boolean }>(
      "select vault_id, proof_public from public.tenants order by vault_id",
    );
    expect(Object.fromEntries(r.rows.map((x) => [x.vault_id, x.proof_public]))).toEqual({
      "old-canary.vaults.probarion.near": false,
      "old-canary2.vaults.probarion.near": false,
      "old-ext.vaults.probarion.near": true,
      "old-team.vaults.probarion.near": true,
    });
  });
});

describe("tenant_register and the Canary's proof", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });
  const base = {
    network: "mainnet" as const,
    displayName: "x",
    owner: "owner.near",
    approvers: [] as string[],
  };
  const proofOf = async (vault: string) =>
    (
      await pg.query<{ proof_public: boolean; kind: string }>(
        "select proof_public, kind from public.tenants where vault_id = $1",
        [vault],
      )
    ).rows[0];

  it("registers a canary tenant with a private proof, and a team tenant with a public one", async () => {
    const db = pgliteDb(pg);
    await registerTenant(db, { ...base, vaultId: "c1.vaults.probarion.near", kind: "canary" });
    await registerTenant(db, { ...base, vaultId: "t1.vaults.probarion.near", kind: "team" });
    await registerTenant(db, { ...base, vaultId: "e1.vaults.probarion.near", kind: "external" });
    expect(await proofOf("c1.vaults.probarion.near")).toEqual({
      proof_public: false,
      kind: "canary",
    });
    expect(await proofOf("t1.vaults.probarion.near")).toEqual({ proof_public: true, kind: "team" });
    expect(await proofOf("e1.vaults.probarion.near")).toEqual({
      proof_public: false,
      kind: "external",
    });
  });

  it("re-registering a canary tenant never makes it public", async () => {
    const db = pgliteDb(pg);
    await registerTenant(db, { ...base, vaultId: "c2.vaults.probarion.near", kind: "canary" });
    await registerTenant(db, {
      ...base,
      vaultId: "c2.vaults.probarion.near",
      kind: "canary",
      displayName: "again",
    });
    expect((await proofOf("c2.vaults.probarion.near"))?.proof_public).toBe(false);
  });

  it("an external vault that becomes the Canary is made private, even if its owner had made it public", async () => {
    const db = pgliteDb(pg);
    const { tenant_id } = await registerTenant(db, {
      ...base,
      vaultId: "c3.vaults.probarion.near",
      kind: "external",
    });
    await setTenantSettings(db, tenant_id, { proofPublic: true });
    expect(await proofOf("c3.vaults.probarion.near")).toEqual({
      proof_public: true,
      kind: "external",
    });
    await registerTenant(db, { ...base, vaultId: "c3.vaults.probarion.near", kind: "canary" });
    expect(await proofOf("c3.vaults.probarion.near")).toEqual({
      proof_public: false,
      kind: "canary",
    });
  });

  it("an external vault that becomes a team vault keeps the owner's own setting", async () => {
    const db = pgliteDb(pg);
    const { tenant_id } = await registerTenant(db, {
      ...base,
      vaultId: "t2.vaults.probarion.near",
      kind: "external",
    });
    await setTenantSettings(db, tenant_id, { proofPublic: true });
    await registerTenant(db, { ...base, vaultId: "t2.vaults.probarion.near", kind: "team" });
    expect(await proofOf("t2.vaults.probarion.near")).toEqual({ proof_public: true, kind: "team" });
  });

  it("answers nothing to anon for a canary vault: no vault, no ledger", async () => {
    const db = pgliteDb(pg);
    await registerTenant(db, { ...base, vaultId: "c4.vaults.probarion.near", kind: "canary" });
    const t = await pg.query<{ id: string }>(
      "select id from public.tenants where vault_id = 'c4.vaults.probarion.near'",
    );
    const id = t.rows[0]?.id;
    await pg.query(
      `insert into public.ledger_entries (tenant_id, seq, kind, body, body_text, body_hash, sig, signer, link, request_id)
       values ($1, 0, 'decision', '{"proposal":{"reasoning":"quoted visitor words"}}'::jsonb,
               '{"proposal":{"reasoning":"quoted visitor words"}}', repeat('a', 64), 'ed25519:sig', 'ed25519:signer', repeat('b', 64), 'r')`,
      [id],
    );
    const anon = pgliteDb(pg, "anon");
    expect(await anon.rpc("public_vault", { vault_id: "c4.vaults.probarion.near" })).toBeNull();
    expect(await anon.rpc("public_ledger", { vault_id: "c4.vaults.probarion.near" })).toEqual([]);
  });
});
