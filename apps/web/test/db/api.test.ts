import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Db, DbError, toDbError } from "@/lib/db/port";
import {
  memberRole,
  memberTenants,
  registerTenant,
  setTenantSettings,
  withLease,
} from "@/lib/db/tenants";
import { rateLimitOr429 } from "@/lib/http";
import { log } from "@/lib/log";
import { takeToken } from "@/lib/ratelimit";
import { freshDb } from "./harness";
import { pgliteDb } from "./pglite-db";

/** What `tenant_lease` returns. `until` is the fencing token `tenant_release` must be given back. */
interface LeaseResult {
  acquired: boolean;
  until: string | null;
}
const NOOP = () => {};

interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Why PUBLIC could execute `public.<signature>`, or null if it cannot. A NULL proacl is the catalog's way of saying
 * "default privileges", and a function's built-in default IS execute for PUBLIC, so it counts as a problem; the ACL must
 * be explicit. With the default expanded, no entry may belong to grantee 0 (PUBLIC).
 */
async function publicExecuteProblem(q: Queryable, signature: string): Promise<string | null> {
  const r = await q.query<{ acl: string | null; public_exec: number }>(
    `select p.proacl::text as acl,
            (select count(*)::int from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
       from pg_proc p where p.oid = ('public.' || $1)::regprocedure`,
    [signature],
  );
  const row = r.rows[0];
  if (!row) return "function not found";
  if (row.acl === null) return "proacl is NULL (the default: PUBLIC can execute)";
  if (row.public_exec > 0) return "PUBLIC holds EXECUTE";
  return null;
}

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
      expect(await publicExecuteProblem(pg, `${fn}(jsonb)`), fn).toBeNull();
    }
  });

  it("the PUBLIC-execute check fails a NULL proacl and an explicit PUBLIC grant, and accepts an explicit revoke", async () => {
    await pg.transaction(async (tx) => {
      // Put the built-in default back (PUBLIC may execute) and drop the schema-level service_role default, so that a
      // new function gets no ACL of its own: proacl is NULL, which the catalog reads as "default privileges".
      await tx.exec(`
        alter default privileges grant execute on functions to public;
        alter default privileges in schema public revoke execute on functions from service_role;
        create function public.acl_null(p jsonb) returns jsonb language sql as $$ select p $$;
        create function public.acl_public(p jsonb) returns jsonb language sql as $$ select p $$;
        grant execute on function public.acl_public(jsonb) to public;
        create function public.acl_revoked(p jsonb) returns jsonb language sql as $$ select p $$;
        revoke execute on function public.acl_revoked(jsonb) from public;`);
      const nulls = await tx.query<{ n: number }>(
        "select count(*)::int as n from pg_proc where proname = 'acl_null' and proacl is null",
      );
      expect(nulls.rows[0]?.n, "the probe really has a NULL proacl").toBe(1);
      expect(await publicExecuteProblem(tx, "acl_null(jsonb)")).toMatch(/NULL/);
      expect(await publicExecuteProblem(tx, "acl_public(jsonb)")).toMatch(/PUBLIC holds EXECUTE/);
      expect(await publicExecuteProblem(tx, "acl_revoked(jsonb)")).toBeNull();
      await tx.rollback();
    });
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
    const first = await db.rpc<LeaseResult>("tenant_lease", {
      tenant_id: tenant,
      kind: "process",
      seconds: 60,
    });
    expect(first.acquired).toBe(true);
    expect(await withLease(db, tenant, "process", 60, async () => "x")).toEqual({
      acquired: false,
    });
    const later = await db.rpc<LeaseResult>("tenant_lease", {
      tenant_id: tenant,
      kind: "process",
      seconds: 60,
      now: new Date(Date.now() + 61_000).toISOString(),
    });
    expect(later.acquired).toBe(true);
    await db.rpc("tenant_release", { tenant_id: tenant, kind: "process", until: later.until });
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
  afterEach(() => vi.restoreAllMocks());

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
    // An unknown tenant simply does not get a lease, and so has no `until` to release.
    expect(await db.rpc("tenant_lease", { tenant_id: id, kind: "watch", seconds: 60 })).toEqual({
      acquired: false,
      until: null,
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
    const heldProcess = await db.rpc<LeaseResult>("tenant_lease", {
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
    await db.rpc("tenant_release", { tenant_id, kind: "process", until: heldProcess.until });
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
    // A database whose release call is down; it remembers each lease's `until` so the test can clean up.
    let lastUntil: string | null = null;
    const failingRelease: Db = {
      rpc: async <T>(fn: string, p?: Record<string, unknown>) => {
        if (fn === "tenant_release") throw new DbError("db_error", "release down");
        const out = await real.rpc<T>(fn, p);
        if (fn === "tenant_lease") lastUntil = (out as LeaseResult).until;
        return out;
      },
    };
    const cleanUp = () =>
      real.rpc("tenant_release", { tenant_id, kind: "process", until: lastUntil });
    const warn = vi.spyOn(log, "warn").mockImplementation(NOOP);
    // The work finished (a payment may have gone out), so its value must still reach the caller.
    expect(await withLease(failingRelease, tenant_id, "process", 60, async () => "paid")).toEqual({
      acquired: true,
      value: "paid",
    });
    // The log line carries the error text, not just "db_error", and no secret-bearing field.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("lease.release_failed", {
      tenant_id,
      kind: "process",
      code: "db_error",
      error: "release down",
    });
    await cleanUp();
    // The work's own error wins over the release error.
    await expect(
      withLease(failingRelease, tenant_id, "process", 60, async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    expect(warn).toHaveBeenCalledTimes(2);
    await cleanUp();
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

  // Fix round 1 (W-T3-R1). A lease is a fence: tenant_release only clears the lease whose `until` it is given back.
  describe("lease fencing", () => {
    const T0 = "2026-11-08T00:00:00Z";
    const register = (name: string) =>
      registerTenant(pgliteDb(pg), {
        vaultId: `${name}.vaults.probarion.near`,
        network: "testnet",
        kind: "external",
        displayName: name,
        owner: `${name}.near`,
        approvers: [],
      });

    for (const kind of ["process", "watch"] as const) {
      it(`a late ${kind} release cannot free the lease of the worker that took over`, async () => {
        const db = pgliteDb(pg);
        const { tenant_id } = await register(`fence-${kind}`);
        const lease = (now: string, seconds: number) =>
          db.rpc<LeaseResult>("tenant_lease", { tenant_id, kind, seconds, now });
        const release = (until: string | null) =>
          db.rpc<{ released: boolean }>("tenant_release", { tenant_id, kind, until });

        // A takes the lease for 1 s at t0, then is slow.
        const a = await lease(T0, 1);
        expect(a.acquired).toBe(true);
        expect(new Date(a.until ?? "").toISOString()).toBe("2026-11-08T00:00:01.000Z");
        // B takes over at t0+2 s, after A's lease expired.
        const b = await lease("2026-11-08T00:00:02Z", 60);
        expect(b.acquired).toBe(true);
        expect(b.until).not.toBe(a.until);
        // A finally reaches its release: it must leave B's lease alone...
        expect(await release(a.until)).toEqual({ released: false });
        // ...so the next worker (the cron, at t0+3 s) is still refused while B runs.
        expect(await lease("2026-11-08T00:00:03Z", 60)).toEqual({ acquired: false, until: null });
        // B's own release frees it, and then the cron can take it.
        expect(await release(b.until)).toEqual({ released: true });
        expect((await lease("2026-11-08T00:00:03Z", 60)).acquired).toBe(true);
      });
    }

    it("the holder's own release frees the lease, once", async () => {
      const db = pgliteDb(pg);
      const { tenant_id } = await register("fence-own");
      const a = await db.rpc<LeaseResult>("tenant_lease", {
        tenant_id,
        kind: "process",
        seconds: 60,
        now: T0,
      });
      expect(a.acquired).toBe(true);
      const release = () =>
        db.rpc<{ released: boolean }>("tenant_release", {
          tenant_id,
          kind: "process",
          until: a.until,
        });
      expect(await release()).toEqual({ released: true });
      expect(await release()).toEqual({ released: false });
      const again = await db.rpc<LeaseResult>("tenant_lease", {
        tenant_id,
        kind: "process",
        seconds: 60,
        now: "2026-11-08T00:00:01Z",
      });
      expect(again.acquired).toBe(true);
    });

    it("tenant_release is never unfenced: it needs a tenant, a kind and a readable until", async () => {
      const db = pgliteDb(pg);
      const id = crypto.randomUUID();
      const until = "2026-11-08T00:00:00Z";
      const bad: Record<string, unknown>[] = [
        { kind: "process", until },
        { tenant_id: id, until },
        { tenant_id: id, kind: "nope", until },
        { tenant_id: id, kind: "process" },
        { tenant_id: id, kind: "process", until: null },
        { tenant_id: id, kind: "process", until: "not a time" },
        { tenant_id: "nope", kind: "process", until },
      ];
      for (const p of bad) {
        await expect(db.rpc("tenant_release", p), JSON.stringify(p)).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
      // A release for a tenant that does not exist is simply not a release.
      expect(await db.rpc("tenant_release", { tenant_id: id, kind: "process", until })).toEqual({
        released: false,
      });
    });

    it("withLease whose work outlives its lease leaves the successor's lease alone, and logs it", async () => {
      const db = pgliteDb(pg);
      const { tenant_id } = await register("fence-withlease");
      const warn = vi.spyOn(log, "warn").mockImplementation(NOOP);
      let successor: LeaseResult | undefined;
      const out = await withLease(db, tenant_id, "watch", 1, async () => {
        // The work is slow: its 1 s lease expires and another worker takes the tenant over.
        successor = await db.rpc<LeaseResult>("tenant_lease", {
          tenant_id,
          kind: "watch",
          seconds: 60,
          now: new Date(Date.now() + 5_000).toISOString(),
        });
        return "slow work done";
      });
      expect(out).toEqual({ acquired: true, value: "slow work done" });
      expect(successor?.acquired).toBe(true);
      // The successor still holds the lease after the late release...
      const cron = await db.rpc<LeaseResult>("tenant_lease", {
        tenant_id,
        kind: "watch",
        seconds: 60,
        now: new Date(Date.now() + 6_000).toISOString(),
      });
      expect(cron.acquired).toBe(false);
      // ...and the overrun is visible in the logs.
      expect(warn).toHaveBeenCalledWith("lease.expired_before_release", {
        tenant_id,
        kind: "watch",
      });
    });

    it("a normal withLease run does not report an overrun", async () => {
      const db = pgliteDb(pg);
      const { tenant_id } = await register("fence-quiet");
      const warn = vi.spyOn(log, "warn").mockImplementation(NOOP);
      expect(await withLease(db, tenant_id, "process", 60, async () => 7)).toEqual({
        acquired: true,
        value: 7,
      });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("registering the same vault again returns the same tenant: a double click, or a lost race", async () => {
    const db = pgliteDb(pg);
    const input = {
      vaultId: "twice.vaults.probarion.near",
      network: "mainnet",
      kind: "external",
      displayName: "Twice",
      owner: "twice.near",
      approvers: ["ap1.near", "ap2.near"],
    } as const;
    const first = await registerTenant(db, { ...input, approvers: [...input.approvers] });
    const second = await registerTenant(db, { ...input, approvers: [...input.approvers] });
    expect(second.tenant_id).toBe(first.tenant_id);
    const rows = await pg.query<{ n: number }>(
      "select count(*)::int as n from public.tenants where vault_id = $1",
      [input.vaultId],
    );
    expect(rows.rows[0]?.n).toBe(1);
    const members = await pg.query<{ account_id: string; role: string }>(
      "select account_id, role from public.tenant_members where tenant_id = $1 order by account_id",
      [first.tenant_id],
    );
    expect(members.rows).toEqual([
      { account_id: "ap1.near", role: "approver" },
      { account_id: "ap2.near", role: "approver" },
      { account_id: "twice.near", role: "owner" },
    ]);
    // The conflict path still enforces ownership.
    await expect(
      registerTenant(db, { ...input, owner: "eve.near", approvers: [] }),
    ).rejects.toMatchObject({ code: "owner_mismatch" });
  });

  // The insert-first path has one more outcome: the insert is skipped because the vault already exists, and that row
  // is gone by the time the re-select runs (a concurrent transaction deleted it). PGlite has one connection, so that
  // interleaving cannot be produced. A BEFORE INSERT trigger that skips the row reaches the same state: nothing was
  // inserted and there is nothing to find. It must end in an explicit not_found, not carry a NULL tenant id on into
  // tenant_members and fail there with a not-null violation.
  it("tenant_register says not_found when the insert is skipped and no row exists to re-select", async () => {
    const vault = "ghost.vaults.probarion.near";
    const code = await pg.transaction(async (tx) => {
      await tx.exec(`
        create function public.test_skip_insert() returns trigger language plpgsql as $$ begin return null; end $$;
        create trigger test_skip_insert before insert on public.tenants
          for each row execute function public.test_skip_insert();`);
      let failure: string | null = null;
      try {
        await tx.query("select public.tenant_register($1::jsonb) as r", [
          JSON.stringify({
            vault_id: vault,
            network: "mainnet",
            kind: "external",
            display_name: "Ghost",
            owner_account: "ghost.near",
            approvers: [],
          }),
        ]);
      } catch (e) {
        failure = toDbError(e).code;
      }
      await tx.rollback();
      return failure;
    });
    expect(code).toBe("not_found");
    // Nothing survived the rollback: no tenant, no member, no trigger function.
    expect(await pgliteDb(pg).rpc("tenant_by_vault", { vault_id: vault })).toBeNull();
    const left = await pg.query<{ members: number; fns: number }>(
      `select (select count(*)::int from public.tenant_members where account_id = 'ghost.near') as members,
              (select count(*)::int from pg_proc where proname = 'test_skip_insert') as fns`,
    );
    expect(left.rows[0]).toEqual({ members: 0, fns: 0 });
  });

  it("an owner of one tenant gets nothing back for another tenant's vault", async () => {
    const db = pgliteDb(pg);
    const mk = (name: string) =>
      registerTenant(db, {
        vaultId: `${name}.vaults.probarion.near`,
        network: "mainnet",
        kind: "external",
        displayName: name,
        owner: `${name}.near`,
        approvers: [],
      });
    await mk("cross-a");
    await mk("cross-b");
    expect(await memberRole(db, "cross-b.vaults.probarion.near", "cross-a.near")).toBeNull();
    expect(await memberRole(db, "cross-a.vaults.probarion.near", "cross-b.near")).toBeNull();
    expect((await memberRole(db, "cross-a.vaults.probarion.near", "cross-a.near"))?.role).toBe(
      "owner",
    );
    expect((await memberTenants(db, "cross-a.near")).map((t) => t.vault_id)).toEqual([
      "cross-a.vaults.probarion.near",
    ]);
  });

  it("a malformed tenant id or vault id is invalid_input, not db_error", async () => {
    const db = pgliteDb(pg);
    const badTenantIds: unknown[] = [
      "nope",
      "",
      "123",
      123,
      "00000000-0000-0000-0000-00000000000g",
      "{00000000-0000-0000-0000-000000000000}",
    ];
    for (const tenant_id of badTenantIds) {
      const label = JSON.stringify(tenant_id);
      await expect(
        db.rpc("tenant_lease", { tenant_id, kind: "process", seconds: 60 }),
        `lease ${label}`,
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        db.rpc("tenant_release", { tenant_id, kind: "process", until: "2026-11-08T00:00:00Z" }),
        `release ${label}`,
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        db.rpc("tenant_settings_set", { tenant_id, zero_retention: true }),
        `settings ${label}`,
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(setTenantSettings(db, "nope", {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    const base = {
      network: "mainnet",
      kind: "external",
      display_name: "V",
      owner_account: "v.near",
    };
    const badVaultIds = ["A.near", "x", "", "a b", "a/b", "a".repeat(65), "café.near"];
    for (const vault_id of badVaultIds) {
      await expect(
        db.rpc("tenant_register", { ...base, vault_id }),
        JSON.stringify(vault_id),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    // Nothing was written, and the limits of the pattern (2 and 64 characters) are accepted.
    for (const vault_id of ["ab", "a".repeat(64)]) {
      const out = await db.rpc<{ tenant_id: string }>("tenant_register", { ...base, vault_id });
      expect(out.tenant_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    const written = await pg.query<{ n: number }>(
      "select count(*)::int as n from public.tenants where vault_id = any($1)",
      [["A.near", "x", "", "a b", "a/b", "a".repeat(65)]],
    );
    expect(written.rows[0]?.n).toBe(0);
  });
});
