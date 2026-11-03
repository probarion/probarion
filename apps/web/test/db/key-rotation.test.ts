import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { KeyPair } from "near-api-js";
import { afterEach, describe, expect, it } from "vitest";
import {
  openAgentSecret,
  openInvoice,
  reencryptAgentSecret,
  reencryptInvoice,
  sealAgentSecret,
  sealInvoice,
} from "@/lib/crypto/secrets";
import { parseMasterKey, sha256Hex } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { RotationRefusedError, rotateAll } from "@/lib/keys/rotate";
import { generateKey, loadActiveSecret } from "@/lib/keys/service";
import { freshDb, seedTenant } from "./harness";
import { at, expectNoSecret, LOST_MASTER, MASTER, NEW_MASTER, silenceLogs } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

// Master-key rotation (Task 10, W-T10-R1): a verified dry run, then an atomic, compare-and-set apply.
// Each test builds its own database, since a rotation touches every sealed row.

silenceLogs();

interface RotationFixture {
  pg: PGlite;
  db: Db;
  tenant: string;
  /** The plaintext of every sealed row, by row id. */
  secrets: Map<string, string>;
  invoiceId: string;
  invoiceContent: Uint8Array;
}

async function rotationFixture(): Promise<RotationFixture> {
  const pg = await freshDb();
  const tenant = await seedTenant(pg, { vault: "rot.vaults.probarion.near", owner: "acme.near" });
  const db = pgliteDb(pg);
  const secrets = new Map<string, string>();
  for (const purpose of ["agent", "agent", "ledger"] as const) {
    const kp = KeyPair.fromRandom("ed25519");
    const { id } = await generateKey(
      db,
      MASTER,
      { tenantId: tenant, purpose, label: purpose, createdBy: "acme.near" },
      () => kp,
    );
    secrets.set(id, kp.toString());
  }
  const [agentId, , ledgerId] = [...secrets.keys()];
  for (const id of [agentId, ledgerId]) {
    await db.rpc("agent_key_set_status", {
      tenant_id: tenant,
      id,
      from: "pending",
      status: "active",
    });
  }
  const invoiceContent = new TextEncoder().encode(`Invoice ${randomUUID()}: 120.00 USDC`);
  const sealed = await sealInvoice(MASTER, tenant, invoiceContent);
  const inv = await pg.query<{ id: string }>(
    `insert into invoices (tenant_id, invoice_hash, ref, media_type, retained, content_ciphertext, content_nonce, request_id, created_by)
     values ($1, $2, 'inv-1', 'text/plain', true, $3, $4, 'r', 'acme.near') returning id`,
    [tenant, sha256Hex(invoiceContent), sealed.ciphertext, sealed.nonce],
  );
  // A zero-retention invoice has nothing sealed: rotation leaves it alone.
  await pg.query(
    `insert into invoices (tenant_id, invoice_hash, ref, media_type, retained, request_id, created_by)
     values ($1, $2, 'inv-2', 'text/plain', false, 'r', 'acme.near')`,
    [tenant, "a".repeat(64)],
  );
  return { pg, db, tenant, secrets, invoiceId: inv.rows[0]?.id, invoiceContent };
}

async function sealedState(pg: PGlite): Promise<unknown> {
  const keys = await pg.query(
    "select id, secret_ciphertext, secret_nonce, key_version from agent_keys order by id",
  );
  const invoices = await pg.query(
    "select id, content_ciphertext, content_nonce from invoices order by id",
  );
  return { keys: keys.rows, invoices: invoices.rows };
}

/** Every agent key row opens under `master` to its own secret; the retained invoice opens to its content. */
async function expectAllOpenUnder(f: RotationFixture, master: Uint8Array): Promise<void> {
  const rows = await f.pg.query<{ id: string; secret_ciphertext: string; secret_nonce: string }>(
    "select id, secret_ciphertext, secret_nonce from agent_keys",
  );
  for (const r of rows.rows) expect(await openAgentSecret(master, r)).toBe(f.secrets.get(r.id));
  const inv = await f.pg.query<{ content_ciphertext: string; content_nonce: string }>(
    "select content_ciphertext, content_nonce from invoices where id = $1",
    [f.invoiceId],
  );
  const opened = await openInvoice(master, f.tenant, {
    ciphertext: inv.rows[0]?.content_ciphertext,
    nonce: inv.rows[0]?.content_nonce,
  });
  expect(Buffer.from(opened).equals(Buffer.from(f.invoiceContent))).toBe(true);
}

describe("rotateAll: verified dry run, then an atomic apply", () => {
  const fixtures: RotationFixture[] = [];
  const fixture = async () => {
    const f = await rotationFixture();
    fixtures.push(f);
    return f;
  };
  afterEach(async () => {
    for (const f of fixtures.splice(0)) await f.pg.close();
  });

  it("dry run (the default) re-encrypts and verifies every row in memory, and writes nothing", async () => {
    const f = await fixture();
    const before = await sealedState(f.pg);
    const report = await rotateAll(f.db, MASTER, NEW_MASTER);
    expect(report).toEqual({
      mode: "dry-run",
      ok: true,
      agent_keys: { total: 3, rotate: 3, already_new: 0, unreadable: 0, mismatched: 0 },
      invoices: { total: 1, rotate: 1, already_new: 0, unreadable: 0, mismatched: 0 },
      written: null,
      after: null,
    });
    expect(await sealedState(f.pg)).toEqual(before);
    await expectAllOpenUnder(f, MASTER);
  });

  it("apply rotates every sealed row to the new master and bumps key_version", async () => {
    const f = await fixture();
    const before = await loadActiveSecret(f.db, MASTER, f.tenant, "ledger");
    const versions = await f.pg.query<{ id: string; key_version: number }>(
      "select id, key_version from agent_keys",
    );
    const report = await rotateAll(f.db, MASTER, NEW_MASTER, { apply: true });
    expect(report).toMatchObject({
      mode: "apply",
      ok: true,
      written: { agent_keys: 3, invoices: 1 },
      after: {
        agent_keys: { total: 3, new: 3, old: 0, unreadable: 0 },
        invoices: { total: 1, new: 1, old: 0, unreadable: 0 },
      },
    });
    await expectAllOpenUnder(f, NEW_MASTER);
    expect(await loadActiveSecret(f.db, NEW_MASTER, f.tenant, "ledger")).toEqual(before);
    await expect(loadActiveSecret(f.db, MASTER, f.tenant, "ledger")).rejects.toThrow(
      /decrypt_failed/,
    );
    const after = await f.pg.query<{ id: string; key_version: number }>(
      "select id, key_version from agent_keys",
    );
    for (const v of versions.rows) {
      expect(after.rows.find((x) => x.id === v.id)?.key_version).toBe(v.key_version + 1);
    }
  });

  it("finds a row sealed under the new master mid-rotation by trial decryption and leaves it as it is", async () => {
    const f = await fixture();
    // The live app, already on the new master, adds a key during the rotation window.
    const kp = KeyPair.fromRandom("ed25519");
    const { id } = await generateKey(
      f.db,
      NEW_MASTER,
      { tenantId: f.tenant, purpose: "agent", label: "late", createdBy: "acme.near" },
      () => kp,
    );
    f.secrets.set(id, kp.toString());
    const lateRow = async () =>
      (
        await f.pg.query(
          "select secret_ciphertext, secret_nonce, key_version from agent_keys where id = $1",
          [id],
        )
      ).rows[0];
    const late = await lateRow();

    const dry = await rotateAll(f.db, MASTER, NEW_MASTER);
    expect(dry.ok).toBe(true);
    expect(dry.agent_keys).toEqual({
      total: 4,
      rotate: 3,
      already_new: 1,
      unreadable: 0,
      mismatched: 0,
    });

    const report = await rotateAll(f.db, MASTER, NEW_MASTER, { apply: true });
    expect(report.written).toEqual({ agent_keys: 3, invoices: 1 });
    expect(report.after?.agent_keys).toEqual({ total: 4, new: 4, old: 0, unreadable: 0 });
    expect(await lateRow()).toEqual(late);
    await expectAllOpenUnder(f, NEW_MASTER);

    // Re-running after the switch finds nothing left to do: OLD can be retired.
    expect((await rotateAll(f.db, MASTER, NEW_MASTER)).agent_keys).toEqual({
      total: 4,
      rotate: 0,
      already_new: 4,
      unreadable: 0,
      mismatched: 0,
    });
  });

  it("reports a row that opens under neither master, and refuses --apply without writing anything", async () => {
    const f = await fixture();
    await generateKey(f.db, LOST_MASTER, {
      tenantId: f.tenant,
      purpose: "agent",
      label: "orphan",
      createdBy: "acme.near",
    });
    const before = await sealedState(f.pg);
    const dry = await rotateAll(f.db, MASTER, NEW_MASTER);
    expect(dry.ok).toBe(false);
    expect(dry.agent_keys).toEqual({
      total: 4,
      rotate: 3,
      already_new: 0,
      unreadable: 1,
      mismatched: 0,
    });

    const refused = await rotateAll(f.db, MASTER, NEW_MASTER, { apply: true }).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(RotationRefusedError);
    expect((refused as RotationRefusedError).report.agent_keys.unreadable).toBe(1);
    expect((refused as Error).message).toMatch(/^rotation_refused/);
    expect(await sealedState(f.pg)).toEqual(before);
  });

  it("refuses --apply when a re-encrypted row does not open under the new master to the same plaintext", async () => {
    const wrongKey = {
      agentSecret: async (
        o: Uint8Array,
        _n: Uint8Array,
        row: Parameters<typeof reencryptAgentSecret>[2],
      ) => reencryptAgentSecret(o, LOST_MASTER, row),
    };
    const wrongText = {
      agentSecret: async (
        o: Uint8Array,
        n: Uint8Array,
        row: Parameters<typeof reencryptAgentSecret>[2],
      ) => {
        const s = await sealAgentSecret(n, KeyPair.fromRandom("ed25519").toString());
        void o;
        return { ...s, key_version: row.key_version + 1 };
      },
    };
    const wrongInvoice = {
      invoice: async (
        o: Uint8Array,
        n: Uint8Array,
        _tenant: string,
        s: Parameters<typeof reencryptInvoice>[3],
      ) => reencryptInvoice(o, n, randomUUID(), s),
    };
    // These two return a sealed value (no throw), so only the read-back check can catch them.
    const invoiceUnderOtherTenant = {
      invoice: async (
        o: Uint8Array,
        n: Uint8Array,
        tenant: string,
        s: Parameters<typeof reencryptInvoice>[3],
      ) => sealInvoice(n, randomUUID(), await openInvoice(o, tenant, s)),
    };
    const invoiceOtherBytes = {
      invoice: async (o: Uint8Array, n: Uint8Array, tenant: string) => {
        void o;
        return sealInvoice(n, tenant, new TextEncoder().encode("a different invoice"));
      },
    };
    // A re-seal that does not move key_version on: the counter must go up on every re-seal.
    const sameVersion = {
      agentSecret: async (
        o: Uint8Array,
        n: Uint8Array,
        row: Parameters<typeof reencryptAgentSecret>[2],
      ) => ({ ...(await reencryptAgentSecret(o, n, row)), key_version: row.key_version }),
    };
    for (const [name, reencrypt, counts] of [
      ["wrong key", wrongKey, { agent: 3, invoice: 0 }],
      ["wrong plaintext", wrongText, { agent: 3, invoice: 0 }],
      ["same key_version", sameVersion, { agent: 3, invoice: 0 }],
      ["wrong invoice key", wrongInvoice, { agent: 0, invoice: 1 }],
      ["invoice sealed under another tenant", invoiceUnderOtherTenant, { agent: 0, invoice: 1 }],
      ["invoice with other bytes", invoiceOtherBytes, { agent: 0, invoice: 1 }],
    ] as const) {
      const f = await fixture();
      const before = await sealedState(f.pg);
      const dry = await rotateAll(f.db, MASTER, NEW_MASTER, { reencrypt });
      expect(dry.ok, name).toBe(false);
      expect(dry.agent_keys.mismatched, name).toBe(counts.agent);
      expect(dry.invoices.mismatched, name).toBe(counts.invoice);
      await expect(
        rotateAll(f.db, MASTER, NEW_MASTER, { apply: true, reencrypt }),
        name,
      ).rejects.toBeInstanceOf(RotationRefusedError);
      expect(await sealedState(f.pg), name).toEqual(before);
    }
    // Six fresh databases, one per re-seal shape: well over the 20 s default on a loaded CI runner.
  }, 120_000);

  it("refuses equal masters before reading anything", async () => {
    let calls = 0;
    const db: Db = {
      rpc: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    };
    const same = parseMasterKey(Buffer.alloc(32, 5).toString("base64"));
    for (const apply of [false, true]) {
      await expect(rotateAll(db, MASTER, same, { apply })).rejects.toThrow(/identical/);
    }
    expect(calls).toBe(0);
  });

  it("key_rotation_apply is atomic: one stale row and nothing changes", async () => {
    const f = await fixture();
    const rows = (
      await f.pg.query<{ id: string; secret_ciphertext: string; key_version: number }>(
        "select id, secret_ciphertext, key_version from agent_keys order by id",
      )
    ).rows;
    const [r0, r1] = [at(rows, 0), at(rows, 1)];
    const before = await sealedState(f.pg);
    const item = (r: (typeof rows)[number], old = r.secret_ciphertext) => ({
      id: r.id,
      old_ciphertext: old,
      ciphertext: Buffer.alloc(48, 1).toString("base64"),
      nonce: Buffer.alloc(24, 2).toString("base64"),
      key_version: r.key_version + 1,
    });
    const bad = [
      // the second row's ciphertext changed since it was read
      { agent_keys: [item(r0), item(r1, "c3RhbGU=")], invoices: [] },
      // a row that does not exist
      { agent_keys: [item(r0), { ...item(r1), id: randomUUID() }], invoices: [] },
      // the same row twice
      { agent_keys: [item(r0), item(r0)], invoices: [] },
      // key_version must go up
      {
        agent_keys: [item(r0), { ...item(r1), key_version: r1.key_version }],
        invoices: [],
      },
      // the invoice's ciphertext changed since it was read
      {
        agent_keys: [item(r0)],
        invoices: [
          { id: f.invoiceId, old_ciphertext: "c3RhbGU=", ciphertext: "eQ==", nonce: "eg==" },
        ],
      },
      // an invoice that is not there
      {
        agent_keys: [item(r0)],
        invoices: [{ id: randomUUID(), old_ciphertext: "x", ciphertext: "y", nonce: "z" }],
      },
    ];
    for (const batch of bad) {
      await expect(f.db.rpc("key_rotation_apply", batch)).rejects.toMatchObject({
        code: "rotation_conflict",
      });
      expect(await sealedState(f.pg)).toEqual(before);
    }
    for (const malformed of [
      {},
      { agent_keys: "x", invoices: [] },
      { agent_keys: [{ id: r0.id }], invoices: [] },
    ]) {
      await expect(f.db.rpc("key_rotation_apply", malformed)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(await sealedState(f.pg)).toEqual(before);
  });

  it("a row changed between the dry run and the write makes the whole apply fail, with nothing written", async () => {
    const f = await fixture();
    const other = sealAgentSecret(NEW_MASTER, KeyPair.fromRandom("ed25519").toString());
    const racing: Db = {
      async rpc<T>(fn: string, p?: Record<string, unknown>): Promise<T> {
        if (fn === "key_rotation_apply") {
          // Another process re-sealed one row after this one read it.
          const s = await other;
          await f.pg.query(
            "update agent_keys set secret_ciphertext = $1, secret_nonce = $2 where id = (select min(id::text)::uuid from agent_keys)",
            [s.ciphertext, s.nonce],
          );
        }
        return f.db.rpc<T>(fn, p);
      },
    };
    const before = await f.pg.query<{ id: string; secret_ciphertext: string }>(
      "select id, secret_ciphertext from agent_keys order by id",
    );
    await expect(rotateAll(racing, MASTER, NEW_MASTER, { apply: true })).rejects.toMatchObject({
      code: "rotation_conflict",
    });
    const after = await f.pg.query<{ id: string; secret_ciphertext: string }>(
      "select id, secret_ciphertext from agent_keys order by id",
    );
    // Only the racing write landed; none of the rotation's own writes did.
    const changed = after.rows.filter(
      (r, i) => r.secret_ciphertext !== before.rows[i]?.secret_ciphertext,
    );
    expect(changed).toHaveLength(1);
    const inv = await f.pg.query<{ content_ciphertext: string; content_nonce: string }>(
      "select content_ciphertext, content_nonce from invoices where id = $1",
      [f.invoiceId],
    );
    await expect(
      openInvoice(MASTER, f.tenant, {
        ciphertext: inv.rows[0]?.content_ciphertext,
        nonce: inv.rows[0]?.content_nonce,
      }),
    ).resolves.toBeDefined();
  });

  it("never returns key material: the report is counts only", async () => {
    const f = await fixture();
    const report = await rotateAll(f.db, MASTER, NEW_MASTER, { apply: true });
    const text = JSON.stringify(report);
    for (const s of f.secrets.values()) expectNoSecret(text, s);
    const leaves: unknown[] = [];
    JSON.parse(text, (_k, v) => {
      if (typeof v !== "object" || v === null) leaves.push(v);
      return v;
    });
    for (const v of leaves)
      expect(["number", "boolean"].includes(typeof v) || v === "apply").toBe(true);
  });
});
