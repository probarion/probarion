import type { PGlite } from "@electric-sql/pglite";
import { KeyPair } from "near-api-js";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentSecret } from "@/lib/crypto/secrets";
import { parseMasterKey } from "@/lib/crypto/sodium";
import { type Db, DbError } from "@/lib/db/port";
import { freshDb, seedTenant } from "../../../test/db/harness";
import { silenceLogs } from "../../../test/db/keys-helpers";
import { pgliteDb } from "../../../test/db/pglite-db";
import { runRotateCli } from "./rotate-cli";
import { generateKey } from "./service";

// The OWNER's rotation command (scripts/rotate-keys.ts is a thin wrapper over runRotateCli). It never
// generates a master, refuses two equal ones, dry-runs by default, applies only after a clean dry run
// in the same process, and prints counts only.

silenceLogs();

const b64 = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const OLD = b64(5);
const NEW = b64(6);
const LOST = b64(7);

interface Run {
  code: number;
  out: string[];
  err: string[];
  dbMade: number;
}

const dbs: PGlite[] = [];
afterEach(async () => {
  for (const pg of dbs.splice(0)) await pg.close();
});

async function seeded(extraUnder?: string): Promise<{ pg: PGlite; secrets: string[] }> {
  const pg = await freshDb();
  dbs.push(pg);
  const tenant = await seedTenant(pg, { vault: "cli.vaults.probarion.near", owner: "acme.near" });
  const secrets: string[] = [];
  const masters = [OLD, OLD, ...(extraUnder ? [extraUnder] : [])];
  for (const m of masters) {
    const kp = KeyPair.fromRandom("ed25519");
    await generateKey(
      pgliteDb(pg),
      parseMasterKey(m),
      { tenantId: tenant, purpose: "agent", label: "x", createdBy: "acme.near" },
      () => kp,
    );
    secrets.push(kp.toString());
  }
  return { pg, secrets };
}

async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  pg?: PGlite,
  wrap: (db: Db) => Db = (db) => db,
): Promise<Run> {
  const r: Run = { code: -1, out: [], err: [], dbMade: 0 };
  r.code = await runRotateCli(argv, env, {
    makeDb: (): Db => {
      r.dbMade += 1;
      if (!pg) throw new Error("no database in this test");
      return wrap(pgliteDb(pg));
    },
    out: (line) => r.out.push(line),
    err: (line) => r.err.push(line),
  });
  return r;
}

const ENV = {
  OLD_KEY_ENCRYPTION_SECRET: OLD,
  NEW_KEY_ENCRYPTION_SECRET: NEW,
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-value",
};

/**
 * Every leaf of the printed JSON is a number, a boolean, null (a dry run has no `written` / `after`)
 * or the mode: no key, no ciphertext, no text.
 */
function expectCountsOnly(lines: string[]): void {
  expect(lines).toHaveLength(1);
  const leaves: unknown[] = [];
  JSON.parse(lines[0] ?? "null", (_k, v) => {
    if (typeof v !== "object" || v === null) leaves.push(v);
    return v;
  });
  for (const v of leaves) {
    const ok =
      typeof v === "number" ||
      typeof v === "boolean" ||
      v === null ||
      v === "dry-run" ||
      v === "apply";
    expect(ok, String(v)).toBe(true);
  }
}

function expectNoMaterial(r: Run, secrets: string[]): void {
  const text = [...r.out, ...r.err].join("\n");
  for (const m of [OLD, NEW, LOST]) expect(text).not.toContain(m);
  for (const s of secrets) expect(text).not.toContain(s.slice("ed25519:".length, 40));
  expect(text).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY);
}

describe("rotate-keys CLI", () => {
  it("never generates a master: an unset or empty NEW_KEY_ENCRYPTION_SECRET is refused", async () => {
    for (const value of [undefined, "", "   "]) {
      const r = await run([], { ...ENV, NEW_KEY_ENCRYPTION_SECRET: value });
      expect(r.code).toBe(2);
      expect(r.dbMade).toBe(0);
      expect(r.out).toEqual([]);
      expect(r.err.join("\n")).toMatch(/NEW_KEY_ENCRYPTION_SECRET is required/);
      expect(r.err.join("\n")).toMatch(/never generates/);
    }
  });

  it("needs every other variable too, and names it without echoing any value", async () => {
    for (const name of [
      "OLD_KEY_ENCRYPTION_SECRET",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
    ] as const) {
      const r = await run([], { ...ENV, [name]: "" });
      expect(r.code, name).toBe(2);
      expect(r.dbMade, name).toBe(0);
      expect(r.err.join("\n"), name).toContain(`${name} is required`);
      expectNoMaterial(r, []);
    }
  });

  it("refuses a master that is not 32 bytes of canonical base64, naming the variable only", async () => {
    const r = await run([], {
      ...ENV,
      NEW_KEY_ENCRYPTION_SECRET: Buffer.alloc(16, 6).toString("base64"),
    });
    expect(r.code).toBe(2);
    expect(r.dbMade).toBe(0);
    expect(r.err.join("\n")).toMatch(/NEW_KEY_ENCRYPTION_SECRET must be 32 bytes/);
    expect(r.err.join("\n")).not.toContain(Buffer.alloc(16, 6).toString("base64"));
  });

  it("refuses equal masters before it opens the database", async () => {
    for (const argv of [[], ["--apply"]]) {
      const r = await run(argv, { ...ENV, NEW_KEY_ENCRYPTION_SECRET: OLD });
      expect(r.code).toBe(2);
      expect(r.dbMade).toBe(0);
      expect(r.err.join("\n")).toMatch(/same key/);
      expectNoMaterial(r, []);
    }
  });

  it("refuses an argument it does not know, without echoing it (it may be a pasted key)", async () => {
    const r = await run(["--aply", NEW], ENV);
    expect(r.code).toBe(2);
    expect(r.dbMade).toBe(0);
    expect(r.err.join("\n")).toMatch(/only --apply/);
    expect(r.err.join("\n")).not.toContain("--aply");
    expectNoMaterial(r, []);
  });

  it("dry-runs by default: prints counts only and writes nothing", async () => {
    const { pg, secrets } = await seeded();
    const before = (await pg.query("select secret_ciphertext from agent_keys order by id")).rows;
    const r = await run([], ENV, pg);
    expect(r.code).toBe(0);
    expectCountsOnly(r.out);
    expect(JSON.parse(r.out[0] ?? "null")).toMatchObject({
      mode: "dry-run",
      ok: true,
      agent_keys: { total: 2, rotate: 2, unreadable: 0, mismatched: 0 },
    });
    expect((await pg.query("select secret_ciphertext from agent_keys order by id")).rows).toEqual(
      before,
    );
    expectNoMaterial(r, secrets);
  });

  it("--apply rotates after a clean dry run and prints counts only", async () => {
    const { pg, secrets } = await seeded();
    const r = await run(["--apply"], ENV, pg);
    expect(r.code).toBe(0);
    expectCountsOnly(r.out);
    expect(JSON.parse(r.out[0] ?? "null")).toMatchObject({
      mode: "apply",
      ok: true,
      written: { agent_keys: 2, invoices: 0 },
      after: { agent_keys: { total: 2, new: 2, old: 0, unreadable: 0 } },
    });
    const rows = await pg.query<{ secret_ciphertext: string; secret_nonce: string }>(
      "select secret_ciphertext, secret_nonce from agent_keys",
    );
    const opened = await Promise.all(
      rows.rows.map((row) => openAgentSecret(parseMasterKey(NEW), row)),
    );
    expect(opened.sort()).toEqual([...secrets].sort());
    expectNoMaterial(r, secrets);
  });

  it("--apply is refused, with exit 1 and nothing written, when a row opens under neither master", async () => {
    const { pg, secrets } = await seeded(LOST);
    const before = (await pg.query("select secret_ciphertext from agent_keys order by id")).rows;
    const r = await run(["--apply"], ENV, pg);
    expect(r.code).toBe(1);
    expectCountsOnly(r.out);
    expect(JSON.parse(r.out[0] ?? "null")).toMatchObject({
      ok: false,
      agent_keys: { unreadable: 1 },
    });
    expect(r.err.join("\n")).toMatch(/refused/);
    expect((await pg.query("select secret_ciphertext from agent_keys order by id")).rows).toEqual(
      before,
    );
    expectNoMaterial(r, secrets);
  });

  it("--apply exits 3 with a warning when the read-back still finds rows under the old master", async () => {
    const { pg, secrets } = await seeded();
    const tenant = (await pg.query<{ id: string }>("select id from tenants")).rows[0]?.id as string;
    // The live app (still on the old master) seals a key right after the write.
    const lateWrite = (db: Db): Db => ({
      async rpc<T>(fn: string, p?: Record<string, unknown>): Promise<T> {
        const out = await db.rpc<T>(fn, p);
        if (fn === "key_rotation_apply") {
          await generateKey(pgliteDb(pg), parseMasterKey(OLD), {
            tenantId: tenant,
            purpose: "agent",
            label: "late",
            createdBy: "acme.near",
          });
        }
        return out;
      },
    });
    const r = await run(["--apply"], ENV, pg, lateWrite);
    expect(r.code).toBe(3);
    expectCountsOnly(r.out);
    expect(JSON.parse(r.out[0] ?? "null")).toMatchObject({
      mode: "apply",
      written: { agent_keys: 2 },
      after: { agent_keys: { total: 3, new: 2, old: 1 } },
    });
    expect(r.err.join("\n")).toMatch(
      /WARNING: the apply wrote, but 1 row\(s\) are still under the old master/,
    );
    expect(r.err.join("\n")).toMatch(/keep OLD_KEY_ENCRYPTION_SECRET/);
    expectNoMaterial(r, secrets);
  });

  it("--apply exits 3 with a warning when the read-back fails", async () => {
    const { pg, secrets } = await seeded();
    let reads = 0;
    const failingReadBack = (db: Db): Db => ({
      async rpc<T>(fn: string, p?: Record<string, unknown>): Promise<T> {
        if (fn === "key_rotation_rows") {
          reads += 1;
          if (reads === 2) throw new DbError("db_error", "connection reset");
        }
        return db.rpc<T>(fn, p);
      },
    });
    const r = await run(["--apply"], ENV, pg, failingReadBack);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out[0] ?? "null")).toMatchObject({
      mode: "apply",
      written: { agent_keys: 2 },
      after: null,
    });
    expect(r.err.join("\n")).toMatch(/WARNING: the apply wrote, but the read-back failed/);
    expectNoMaterial(r, secrets);
  });

  it("a dry run that finds an unreadable row exits 1, so a script cannot mistake it for clean", async () => {
    const { pg } = await seeded(LOST);
    const r = await run([], ENV, pg);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out[0] ?? "null")).toMatchObject({ mode: "dry-run", ok: false });
  });

  it("reports a failure by class or code, never by message", async () => {
    for (const thrown of [
      new Error(`connect failed: ${ENV.SUPABASE_SERVICE_ROLE_KEY} ${NEW}`),
      new DbError("rotation_conflict", `rotation_conflict: ${NEW}`),
    ]) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runRotateCli([], ENV, {
        makeDb: () => ({
          rpc: async () => {
            throw thrown;
          },
        }),
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      });
      expect(code).toBe(1);
      expect(out).toEqual([]);
      expect(err.join("\n")).toMatch(
        thrown instanceof DbError ? /database error rotation_conflict/ : /\(Error\)/,
      );
      expect(err.join("\n")).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY);
      expect(err.join("\n")).not.toContain(NEW);
    }
  });
});
