import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, DbError } from "@/lib/db/port";
import {
  memberRole,
  memberTenants,
  registerTenant,
  setTenantSettings,
  withLease,
} from "@/lib/db/tenants";
import { rateLimitOr429 } from "@/lib/http";
import { takeToken } from "@/lib/ratelimit";
import { freshDb } from "./harness";
import { pgliteDb } from "./pglite-db";

const INTERNAL_FUNCTIONS = [
  "rate_limit_take",
  "tenant_lease",
  "tenant_release",
  "tenant_register",
  "member_tenants",
  "member_role",
  "tenant_settings_set",
  "tenant_by_vault",
] as const;

describe("api functions", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
  });

  it("rate_limit_take allows max hits per window, then blocks, then resets", async () => {
    const db = pgliteDb(pg);
    const t0 = "2026-11-08T00:00:00Z";
    const take = (now: string) =>
      db.rpc<{ allowed: boolean; remaining: number }>("rate_limit_take", {
        bucket: "t:1",
        max: 2,
        window_seconds: 60,
        now,
      });
    expect((await take(t0)).allowed).toBe(true);
    expect((await take("2026-11-08T00:00:10Z")).allowed).toBe(true);
    expect((await take("2026-11-08T00:00:20Z")).allowed).toBe(false);
    expect((await take("2026-11-08T00:01:01Z")).allowed).toBe(true);
  });

  it("internal functions are not executable by anon or authenticated", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        pgliteDb(pg, role, "alice.near").rpc("rate_limit_take", {
          bucket: "x",
          max: 1,
          window_seconds: 1,
        }),
      ).rejects.toThrow(/permission denied/);
      await expect(
        pgliteDb(pg, role).rpc("member_role", { vault_id: "x", account: "y" }),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("grants every internal function to service_role and to nobody else", async () => {
    for (const fn of INTERNAL_FUNCTIONS) {
      const r = await pg.query<{ role: string; ok: boolean }>(
        `select r.role, has_function_privilege(r.role, ('public.' || $1 || '(jsonb)')::regprocedure, 'execute') as ok
           from (values ('anon'), ('authenticated'), ('service_role')) as r(role)`,
        [fn],
      );
      expect(Object.fromEntries(r.rows.map((x) => [x.role, x.ok])), fn).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
      });
      // PUBLIC is not left with EXECUTE either (any other role could otherwise call it).
      const acl = await pg.query<{ acl: string | null }>(
        `select p.proacl::text as acl from pg_proc p where p.oid = ('public.' || $1 || '(jsonb)')::regprocedure`,
        [fn],
      );
      expect(acl.rows[0]?.acl ?? "", fn).not.toMatch(/(^|[{,])=X/);
    }
  });

  it("registers a tenant with owner and approvers and keeps approvers in sync", async () => {
    const db = pgliteDb(pg);
    const { tenant_id } = await registerTenant(db, {
      vaultId: "acme.vaults.probarion.near",
      network: "mainnet",
      kind: "external",
      displayName: "Acme",
      owner: "acme.near",
      approvers: ["cfo.near", "acme.near"],
    });
    expect((await memberRole(db, "acme.vaults.probarion.near", "cfo.near"))?.role).toBe("approver");
    expect((await memberRole(db, "acme.vaults.probarion.near", "acme.near"))?.role).toBe("owner");
    await registerTenant(db, {
      vaultId: "acme.vaults.probarion.near",
      network: "mainnet",
      kind: "external",
      displayName: "Acme",
      owner: "acme.near",
      approvers: ["coo.near"],
    });
    expect(await memberRole(db, "acme.vaults.probarion.near", "cfo.near")).toBeNull();
    expect((await memberRole(db, "acme.vaults.probarion.near", "coo.near"))?.tenant_id).toBe(
      tenant_id,
    );
    const list = await memberTenants(db, "coo.near");
    expect(list.map((t) => t.vault_id)).toEqual(["acme.vaults.probarion.near"]);
  });

  it("refuses to re-register a vault under a different owner", async () => {
    const db = pgliteDb(pg);
    await expect(
      registerTenant(db, {
        vaultId: "acme.vaults.probarion.near",
        network: "mainnet",
        kind: "external",
        displayName: "x",
        owner: "eve.near",
        approvers: [],
      }),
    ).rejects.toMatchObject({ code: "owner_mismatch" });
  });

  it("makes team and canary proofs public by default and stores settings", async () => {
    const db = pgliteDb(pg);
    const { tenant_id } = await registerTenant(db, {
      vaultId: "canary.vaults.probarion.near",
      network: "mainnet",
      kind: "canary",
      displayName: "Canary",
      owner: "probarion.near",
      approvers: [],
    });
    expect(
      (await memberRole(db, "canary.vaults.probarion.near", "probarion.near"))?.proof_public,
    ).toBe(true);
    const s = await setTenantSettings(db, tenant_id, { zeroRetention: true });
    expect(s).toEqual({ zero_retention: true, proof_public: true });
  });

  it("leases are exclusive, expire, and are released even when the work throws", async () => {
    const db = pgliteDb(pg);
    const acme = await memberRole(db, "acme.vaults.probarion.near", "acme.near");
    if (!acme) throw new Error("acme was registered by an earlier test");
    const tenant = acme.tenant_id;
    const first = await db.rpc<{ acquired: boolean }>("tenant_lease", {
      tenant_id: tenant,
      kind: "process",
      seconds: 60,
    });
    expect(first.acquired).toBe(true);
    expect(await withLease(db, tenant, "process", 60, async () => "x")).toEqual({
      acquired: false,
    });
    const later = await db.rpc<{ acquired: boolean }>("tenant_lease", {
      tenant_id: tenant,
      kind: "process",
      seconds: 60,
      now: new Date(Date.now() + 61_000).toISOString(),
    });
    expect(later.acquired).toBe(true);
    await db.rpc("tenant_release", { tenant_id: tenant, kind: "process" });
    await expect(
      withLease(db, tenant, "process", 60, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withLease(db, tenant, "process", 60, async () => 42)).toEqual({
      acquired: true,
      value: 42,
    });
  });

  it("rateLimitOr429 answers 429 with Retry-After once the bucket is empty", async () => {
    const db = pgliteDb(pg);
    expect(await rateLimitOr429(db, "ip:1.2.3.4:auth", [1, 60])).toBeNull();
    const res = await rateLimitOr429(db, "ip:1.2.3.4:auth", [1, 60]);
    expect(res?.status).toBe(429);
    expect(Number(res?.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await res?.json()).toMatchObject({ error: "rate_limited" });
  });

  it("takeToken reports remaining tokens", async () => {
    const r = await takeToken(pgliteDb(pg), "t:remaining", 3, 60);
    expect(r).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("maps SQL exceptions to DbError codes", async () => {
    await expect(
      pgliteDb(pg).rpc("tenant_lease", { tenant_id: crypto.randomUUID(), kind: "nope" }),
    ).rejects.toBeInstanceOf(DbError);
  });
});

// Beyond the brief's nine: what the later tasks lean on.
describe("api functions: edges", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
  });

  // R8 (Task 5): an auth nonce is burned with the shared limiter, so one hit per 600 s must mean exactly once.
  it("takeToken burns a nonce: the first use passes, every replay is refused", async () => {
    const db = pgliteDb(pg);
    const bucket = `auth:nonce:${"ab".repeat(32)}`;
    expect(await takeToken(db, bucket, 1, 600)).toMatchObject({ allowed: true, remaining: 0 });
    for (let i = 0; i < 3; i++) {
      expect(await takeToken(db, bucket, 1, 600)).toMatchObject({ allowed: false, remaining: 0 });
    }
    // A different nonce is untouched.
    expect((await takeToken(db, `auth:nonce:${"cd".repeat(32)}`, 1, 600)).allowed).toBe(true);
  });

  it("a blocked bucket keeps its window: blocking never pushes the reset back", async () => {
    const db = pgliteDb(pg);
    const take = (now: string) =>
      db.rpc<{ allowed: boolean; reset_at: string }>("rate_limit_take", {
        bucket: "t:window",
        max: 1,
        window_seconds: 60,
        now,
      });
    const first = await take("2026-11-08T00:00:00Z");
    const blocked = await take("2026-11-08T00:00:50Z");
    expect(first.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);
    expect(new Date(blocked.reset_at).getTime()).toBe(new Date(first.reset_at).getTime());
    expect(new Date(first.reset_at).toISOString()).toBe("2026-11-08T00:01:00.000Z");
  });

  it("rate_limit_take rejects malformed input with invalid_input", async () => {
    const db = pgliteDb(pg);
    const bad: Record<string, unknown>[] = [
      { max: 1, window_seconds: 60 },
      { bucket: "x", window_seconds: 60 },
      { bucket: "x", max: 1 },
      { bucket: "x", max: 0, window_seconds: 60 },
      { bucket: "x", max: 1, window_seconds: 0 },
      { bucket: "x".repeat(201), max: 1, window_seconds: 60 },
    ];
    for (const p of bad) {
      await expect(
        db.rpc("rate_limit_take", p),
        JSON.stringify(p).slice(0, 60),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    // 200 characters is the table's limit and is accepted.
    expect((await takeToken(db, "y".repeat(200), 1, 60)).allowed).toBe(true);
  });

  it("tenant_lease rejects a missing tenant id and a non-positive duration", async () => {
    const db = pgliteDb(pg);
    const id = crypto.randomUUID();
    await expect(db.rpc("tenant_lease", { kind: "process", seconds: 60 })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      db.rpc("tenant_lease", { tenant_id: id, kind: "process", seconds: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      db.rpc("tenant_lease", { tenant_id: id, kind: "process", seconds: -5 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // An unknown tenant simply does not get a lease.
    expect(await db.rpc("tenant_lease", { tenant_id: id, kind: "watch", seconds: 60 })).toEqual({
      acquired: false,
    });
  });

  it("process and watch leases are independent", async () => {
    const db = pgliteDb(pg);
    const { tenant_id } = await registerTenant(db, {
      vaultId: "leases.vaults.probarion.near",
      network: "testnet",
      kind: "external",
      displayName: "Leases",
      owner: "leases.near",
      approvers: [],
    });
    const heldProcess = await db.rpc<{ acquired: boolean }>("tenant_lease", {
      tenant_id,
      kind: "process",
      seconds: 60,
    });
    expect(heldProcess.acquired).toBe(true);
    // The watch lease is free while the process lease is held.
    expect(await withLease(db, tenant_id, "watch", 60, async () => "w")).toEqual({
      acquired: true,
      value: "w",
    });
    // And the process lease is still held afterwards.
    expect(await withLease(db, tenant_id, "process", 60, async () => "p")).toEqual({
      acquired: false,
    });
    await db.rpc("tenant_release", { tenant_id, kind: "process" });
  });

  it("withLease releases after success, and a failed release changes neither the result nor the error", async () => {
    const real = pgliteDb(pg);
    const { tenant_id } = await registerTenant(real, {
      vaultId: "release.vaults.probarion.near",
      network: "testnet",
      kind: "external",
      displayName: "Release",
      owner: "release.near",
      approvers: [],
    });
    // Success releases: the next call acquires at once.
    expect(await withLease(real, tenant_id, "process", 60, async () => 1)).toEqual({
      acquired: true,
      value: 1,
    });
    expect(await withLease(real, tenant_id, "process", 60, async () => 2)).toEqual({
      acquired: true,
      value: 2,
    });
    const failingRelease: Db = {
      rpc: <T>(fn: string, p?: Record<string, unknown>) =>
        fn === "tenant_release"
          ? Promise.reject(new DbError("db_error", "release down"))
          : real.rpc<T>(fn, p),
    };
    // The work finished (a payment may have gone out), so its value must still reach the caller.
    expect(await withLease(failingRelease, tenant_id, "process", 60, async () => "paid")).toEqual({
      acquired: true,
      value: "paid",
    });
    await real.rpc("tenant_release", { tenant_id, kind: "process" });
    // The work's own error wins over the release error.
    await expect(
      withLease(failingRelease, tenant_id, "process", 60, async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    await real.rpc("tenant_release", { tenant_id, kind: "process" });
  });

  it("tenant_register validates its input", async () => {
    const db = pgliteDb(pg);
    const base = {
      vault_id: "v.vaults.probarion.near",
      network: "mainnet",
      kind: "external",
      display_name: "V",
      owner_account: "v.near",
    };
    const bad: Record<string, unknown>[] = [
      { ...base, vault_id: undefined },
      { ...base, owner_account: undefined },
      { ...base, network: "devnet" },
      { ...base, network: undefined },
      { ...base, kind: "admin" },
      { ...base, approvers: "cfo.near" },
      { ...base, approvers: { a: 1 } },
    ];
    for (const p of bad) {
      await expect(db.rpc("tenant_register", p), JSON.stringify(p)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    // Nothing was written by the refused calls.
    expect(await db.rpc("tenant_by_vault", { vault_id: base.vault_id })).toBeNull();
  });

  it("tenant_register ignores null and duplicate approver entries and trims the display name to 80", async () => {
    const db = pgliteDb(pg);
    const out = await db.rpc<{ tenant_id: string }>("tenant_register", {
      vault_id: "dupes.vaults.probarion.near",
      network: "mainnet",
      kind: "external",
      display_name: "n".repeat(120),
      owner_account: "dupes.near",
      approvers: ["a.near", null, "a.near", "b.near"],
    });
    const roles = await pg.query<{ account_id: string; role: string }>(
      "select account_id, role from public.tenant_members where tenant_id = $1 order by account_id",
      [out.tenant_id],
    );
    expect(roles.rows).toEqual([
      { account_id: "a.near", role: "approver" },
      { account_id: "b.near", role: "approver" },
      { account_id: "dupes.near", role: "owner" },
    ]);
    const t = await db.rpc<{ display_name: string }>("tenant_by_vault", {
      vault_id: "dupes.vaults.probarion.near",
    });
    expect(t.display_name).toHaveLength(80);
  });

  it("a viewer who is an on-chain approver becomes an approver; a viewer who is not stays a viewer", async () => {
    const db = pgliteDb(pg);
    const { tenant_id } = await registerTenant(db, {
      vaultId: "view.vaults.probarion.near",
      network: "mainnet",
      kind: "external",
      displayName: "View",
      owner: "view.near",
      approvers: [],
    });
    await pg.query(
      `insert into public.tenant_members (tenant_id, account_id, role)
       values ($1, 'promoted.near', 'viewer'), ($1, 'plain.near', 'viewer')`,
      [tenant_id],
    );
    await registerTenant(db, {
      vaultId: "view.vaults.probarion.near",
      network: "mainnet",
      kind: "external",
      displayName: "View",
      owner: "view.near",
      approvers: ["promoted.near"],
    });
    expect((await memberRole(db, "view.vaults.probarion.near", "promoted.near"))?.role).toBe(
      "approver",
    );
    expect((await memberRole(db, "view.vaults.probarion.near", "plain.near"))?.role).toBe("viewer");
    // The owner is never demoted by being listed as an approver.
    await registerTenant(db, {
      vaultId: "view.vaults.probarion.near",
      network: "mainnet",
      kind: "external",
      displayName: "View",
      owner: "view.near",
      approvers: ["view.near"],
    });
    expect((await memberRole(db, "view.vaults.probarion.near", "view.near"))?.role).toBe("owner");
  });

  it("membership lookups return empty results for strangers", async () => {
    const db = pgliteDb(pg);
    expect(await memberRole(db, "nobody.vaults.probarion.near", "x.near")).toBeNull();
    expect(await memberTenants(db, "stranger.near")).toEqual([]);
  });

  it("tenant_settings_set leaves unspecified settings alone and refuses an unknown tenant", async () => {
    const db = pgliteDb(pg);
    const { tenant_id } = await registerTenant(db, {
      vaultId: "settings.vaults.probarion.near",
      network: "mainnet",
      kind: "external",
      displayName: "S",
      owner: "settings.near",
      approvers: [],
    });
    expect(await setTenantSettings(db, tenant_id, {})).toEqual({
      zero_retention: false,
      proof_public: false,
    });
    expect(await setTenantSettings(db, tenant_id, { proofPublic: true })).toEqual({
      zero_retention: false,
      proof_public: true,
    });
    expect(await setTenantSettings(db, tenant_id, { zeroRetention: true })).toEqual({
      zero_retention: true,
      proof_public: true,
    });
    expect(await setTenantSettings(db, tenant_id, { proofPublic: false })).toEqual({
      zero_retention: true,
      proof_public: false,
    });
    await expect(setTenantSettings(db, crypto.randomUUID(), {})).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("tenant_by_vault returns the tenant, or null", async () => {
    const db = pgliteDb(pg);
    await registerTenant(db, {
      vaultId: "byvault.vaults.probarion.near",
      network: "testnet",
      kind: "team",
      displayName: "By vault",
      owner: "byvault.near",
      approvers: [],
    });
    expect(
      await db.rpc("tenant_by_vault", { vault_id: "byvault.vaults.probarion.near" }),
    ).toMatchObject({
      vault_id: "byvault.vaults.probarion.near",
      network: "testnet",
      kind: "team",
      owner_account: "byvault.near",
      proof_public: true,
      zero_retention: false,
    });
    expect(await db.rpc("tenant_by_vault", { vault_id: "missing.near" })).toBeNull();
  });
});
