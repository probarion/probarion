import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { KeyPair, type KeyPairString } from "near-api-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import {
  generateKey,
  type KeyRow,
  listKeys,
  loadActiveSecret,
  syncKeyStatuses,
} from "@/lib/keys/service";
import type { AccessKeyState, VaultReader } from "@/lib/near/reader";
import { fakeReader, vaultConfig } from "../fixtures/reader";
import { nodeError, transportError } from "../fixtures/rpc";
import { asRole, freshDb, seedTenant } from "./harness";
import { pgliteDb } from "./pglite-db";

// Masters are built at run time (no high-entropy literal in the repo: gitleaks scans history).
const MASTER = parseMasterKey(Buffer.alloc(32, 5).toString("base64"));
const NEW_MASTER = parseMasterKey(Buffer.alloc(32, 6).toString("base64"));
const LOST_MASTER = parseMasterKey(Buffer.alloc(32, 7).toString("base64"));

/** Exactly what `add_agent` / `set_ledger_key` adds: a plain FunctionCall key on `vault`. */
const fc = (
  vault: string,
  methods: string[],
  over: Partial<AccessKeyState> = {},
): AccessKeyState => ({
  exists: true,
  kind: "FunctionCall",
  fullAccess: false,
  allowance: "1000000000000000000000000",
  receiverId: vault,
  methodNames: methods,
  ...over,
});
const NO_KEY: AccessKeyState = {
  exists: false,
  kind: null,
  fullAccess: false,
  allowance: null,
  receiverId: null,
  methodNames: [],
};

/** Exactly the fields of KeyRow (sorted): agent_key_list returns nothing else, no sealed column. */
const KEY_ROW_FIELDS: (keyof KeyRow)[] = [
  "activated_at",
  "created_at",
  "created_by",
  "id",
  "key_version",
  "label",
  "public_key",
  "purpose",
  "revoked_at",
  "status",
  "tenant_id",
];

interface Chain {
  /** list_agents; an Error makes the view throw. */
  agents?: string[] | Error;
  /** get_config().ledger_key; an Error makes the view throw. */
  ledgerKey?: string | null | Error;
  /** view_access_key per public key (default NO_KEY); an Error makes it throw. */
  keys?: Record<string, AccessKeyState | Error>;
  /** Public keys whose access key was read, in order. */
  reads?: string[];
}

function chainReader(vault: string, c: Chain): VaultReader {
  return fakeReader({
    listAgents: async (v) => {
      if (v !== vault) throw new Error(`listAgents for ${v}`);
      if (c.agents instanceof Error) throw c.agents;
      return (c.agents ?? []).map((pk) => ({ public_key: pk, label: "x", added_at_ns: "1" }));
    },
    getConfig: async (v) => {
      if (v !== vault) throw new Error(`getConfig for ${v}`);
      if (c.ledgerKey instanceof Error) throw c.ledgerKey;
      return vaultConfig({ ledger_key: c.ledgerKey ?? null });
    },
    accessKey: async (account, pk) => {
      if (account !== vault) throw new Error(`accessKey on ${account}`);
      c.reads?.push(pk);
      const k = c.keys?.[pk] ?? NO_KEY;
      if (k instanceof Error) throw k;
      return k;
    },
  });
}

/** Captures what the code logs (console.*), so a test can check that no secret reaches a log line. */
function captureLogs(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }),
  );
  return {
    lines,
    restore: () => {
      for (const s of spies) s.mockRestore();
    },
  };
}

/** Element `i`, or a failed test (never an `undefined` that a later check would wave through). */
function at<T>(rows: readonly T[], i = 0): T {
  const row = rows[i];
  if (row === undefined) throw new Error(`expected a row at ${i}, got ${rows.length} row(s)`);
  return row;
}

function expectNoSecret(text: string, secret: string): void {
  const body = secret.slice("ed25519:".length);
  expect(body.length).toBeGreaterThan(60);
  expect(text).not.toContain(body);
  expect(text).not.toContain(body.slice(10, 40));
}

describe("agent and ledger keys (service + SQL)", () => {
  let pg: PGlite;
  let n = 0;
  const db = () => pgliteDb(pg);

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  /** Every test gets its own tenant, so none depends on what another one did. */
  async function tenant(): Promise<{ id: string; vault: string }> {
    n += 1;
    const vault = `k${n}.vaults.probarion.near`;
    return { id: await seedTenant(pg, { vault, owner: "acme.near" }), vault };
  }

  async function pending(purpose: "agent" | "ledger", t?: { id: string; vault: string }) {
    const tt = t ?? (await tenant());
    const kp = KeyPair.fromRandom("ed25519");
    const { id, publicKey } = await generateKey(
      db(),
      MASTER,
      {
        tenantId: tt.id,
        purpose,
        label: purpose === "agent" ? "payables" : "ledger",
        createdBy: "acme.near",
      },
      () => kp,
    );
    return { ...tt, tenant: tt.id, keyId: id, publicKey, secret: kp.toString() };
  }

  const statusOf = async (id: string) =>
    (await pg.query<{ status: string }>("select status from agent_keys where id = $1", [id]))
      .rows[0]?.status;

  describe("generateKey, listKeys, loadActiveSecret", () => {
    it("stores only ciphertext, starts pending, and lists no secret field", async () => {
      const k = await pending("agent");
      expect(k.publicKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      const raw = await pg.query<{
        secret_ciphertext: string;
        secret_nonce: string;
        status: string;
        key_version: number;
      }>(
        "select secret_ciphertext, secret_nonce, status, key_version from agent_keys where public_key = $1",
        [k.publicKey],
      );
      const r = at(raw.rows);
      expect(r.status).toBe("pending");
      expect(r.key_version).toBe(1);
      expectNoSecret(`${r.secret_ciphertext} ${r.secret_nonce}`, k.secret);
      // What is stored is the secret, sealed under the master.
      expect(await openAgentSecret(MASTER, r)).toBe(k.secret);

      const rows = await listKeys(db(), k.tenant);
      expect(rows).toHaveLength(1);
      expect(Object.keys(at(rows)).sort()).toEqual(KEY_ROW_FIELDS);
      expectNoSecret(JSON.stringify(rows), k.secret);
      expect(JSON.stringify(rows)).not.toContain(r.secret_ciphertext);
      expect(await loadActiveSecret(db(), MASTER, k.tenant, "agent")).toBeNull();
    });

    it("generates a fresh ed25519 key on the server by default", async () => {
      const t = await tenant();
      const a = await generateKey(db(), MASTER, {
        tenantId: t.id,
        purpose: "agent",
        label: "x",
        createdBy: "acme.near",
      });
      const b = await generateKey(db(), MASTER, {
        tenantId: t.id,
        purpose: "agent",
        label: "x",
        createdBy: "acme.near",
      });
      expect(a.publicKey).not.toBe(b.publicKey);
      const row = at(
        (
          await pg.query<{ secret_ciphertext: string; secret_nonce: string }>(
            "select secret_ciphertext, secret_nonce from agent_keys where id = $1",
            [a.id],
          )
        ).rows,
      );
      const secret = await openAgentSecret(MASTER, row);
      expect(
        KeyPair.fromString(secret as KeyPairString)
          .getPublicKey()
          .toString(),
      ).toBe(a.publicKey);
    });

    it("logs the public key only", async () => {
      const logs = captureLogs();
      try {
        const k = await pending("agent");
        expect(logs.lines.join("\n")).toContain(k.publicKey);
        expectNoSecret(logs.lines.join("\n"), k.secret);
      } finally {
        logs.restore();
      }
    });

    it("refuses malformed input with invalid_input, and a second copy of a key with duplicate", async () => {
      const t = await tenant();
      const sealed = await sealAgentSecret(MASTER, KeyPair.fromRandom("ed25519").toString());
      const good = {
        tenant_id: t.id,
        purpose: "agent",
        public_key: KeyPair.fromRandom("ed25519").getPublicKey().toString(),
        secret_ciphertext: sealed.ciphertext,
        secret_nonce: sealed.nonce,
        key_version: 1,
        label: "x",
        created_by: "acme.near",
      };
      for (const bad of [
        { tenant_id: "not-a-uuid" },
        { purpose: "full" },
        { public_key: "ed25519:short" },
        { public_key: "secp256k1:abc" },
        { secret_ciphertext: "" },
        { secret_nonce: null },
        { key_version: 0 },
        { key_version: "1" },
        { label: "a".repeat(65) },
        { created_by: "" },
      ]) {
        await expect(
          db().rpc("agent_key_insert", { ...good, ...bad }),
          JSON.stringify(bad),
        ).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
      await expect(
        db().rpc("agent_key_insert", { ...good, tenant_id: randomUUID() }),
      ).rejects.toMatchObject({
        code: "not_found",
      });
      await db().rpc("agent_key_insert", good);
      await expect(db().rpc("agent_key_insert", good)).rejects.toMatchObject({ code: "duplicate" });
    });

    it("refuses an active secret that does not belong to its public key (a swapped ciphertext)", async () => {
      const a = await pending("agent");
      const b = await pending("agent", { id: a.tenant, vault: a.vault });
      for (const k of [a, b]) {
        await db().rpc("agent_key_set_status", {
          tenant_id: k.tenant,
          id: k.keyId,
          from: "pending",
          status: "active",
        });
      }
      // b is the most recently activated; give it a's sealed secret.
      await pg.query(
        `update agent_keys set secret_ciphertext = s.secret_ciphertext, secret_nonce = s.secret_nonce
           from (select secret_ciphertext, secret_nonce from agent_keys where id = $1) s where id = $2`,
        [a.keyId, b.keyId],
      );
      const e = await loadActiveSecret(db(), MASTER, a.tenant, "agent").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toMatch(/^key_mismatch/);
      expectNoSecret((e as Error).message, a.secret);
    });
  });

  describe("syncKeyStatuses: activation rules", () => {
    it("activates an agent key on a plain FunctionCall key for [spend] on the vault, registered", async () => {
      const k = await pending("agent");
      const r = await syncKeyStatuses(
        db(),
        chainReader(k.vault, {
          agents: [k.publicKey],
          keys: { [k.publicKey]: fc(k.vault, ["spend"]) },
        }),
        { tenant_id: k.tenant, vault_id: k.vault },
      );
      expect(r.keys[0]?.status).toBe("active");
      expect(r.keys[0]?.activated_at).not.toBeNull();
      expect(r.checks).toEqual([
        expect.objectContaining({
          id: k.keyId,
          from: "pending",
          to: "active",
          reason: "activated",
        }),
      ]);
      const loaded = await loadActiveSecret(db(), MASTER, k.tenant, "agent");
      expect(loaded).toEqual({ publicKey: k.publicKey, secret: k.secret });
      expect(
        KeyPair.fromString(loaded?.secret as KeyPairString)
          .getPublicKey()
          .toString(),
      ).toBe(k.publicKey);
      expectNoSecret(JSON.stringify(r), k.secret);
    });

    it("refuses a gas key and logs the mismatch (without the secret)", async () => {
      const k = await pending("agent");
      const logs = captureLogs();
      try {
        const r = await syncKeyStatuses(
          db(),
          chainReader(k.vault, {
            agents: [k.publicKey],
            keys: { [k.publicKey]: fc(k.vault, ["spend"], { kind: "GasKeyFunctionCall" }) },
          }),
          { tenant_id: k.tenant, vault_id: k.vault },
        );
        expect(r.keys[0]?.status).toBe("pending");
        expect(r.checks[0]?.reason).toBe("scope_gas_key");
        const text = logs.lines.join("\n");
        expect(text).toContain("keys.scope_mismatch");
        expect(text).toContain("GasKeyFunctionCall");
        expectNoSecret(text, k.secret);
      } finally {
        logs.restore();
      }
    });

    it("refuses a full-access key, plain or gas", async () => {
      for (const kind of ["FullAccess", "GasKeyFullAccess"] as const) {
        const k = await pending("agent");
        const r = await syncKeyStatuses(
          db(),
          chainReader(k.vault, {
            agents: [k.publicKey],
            keys: {
              [k.publicKey]: {
                exists: true,
                kind,
                fullAccess: true,
                allowance: null,
                receiverId: null,
                methodNames: [],
              },
            },
          }),
          { tenant_id: k.tenant, vault_id: k.vault },
        );
        expect(r.keys[0]?.status, kind).toBe("pending");
        expect(r.checks[0]?.reason, kind).toBe("scope_full_access");
      }
    });

    it("refuses wrong methods: an extra method, no method (= any), the other purpose's method", async () => {
      for (const methods of [["spend", "approve"], [], ["anchor"]]) {
        const k = await pending("agent");
        const r = await syncKeyStatuses(
          db(),
          chainReader(k.vault, {
            agents: [k.publicKey],
            keys: { [k.publicKey]: fc(k.vault, methods) },
          }),
          { tenant_id: k.tenant, vault_id: k.vault },
        );
        expect(r.keys[0]?.status, JSON.stringify(methods)).toBe("pending");
        expect(r.checks[0]?.reason).toBe("scope_wrong_methods");
      }
      const l = await pending("ledger");
      const r = await syncKeyStatuses(
        db(),
        chainReader(l.vault, {
          ledgerKey: l.publicKey,
          keys: { [l.publicKey]: fc(l.vault, ["spend"]) },
        }),
        { tenant_id: l.tenant, vault_id: l.vault },
      );
      expect(r.keys[0]?.status).toBe("pending");
      expect(r.checks[0]?.reason).toBe("scope_wrong_methods");
    });

    it("refuses a key whose receiver is not the vault", async () => {
      const k = await pending("agent");
      const r = await syncKeyStatuses(
        db(),
        chainReader(k.vault, {
          agents: [k.publicKey],
          keys: { [k.publicKey]: fc("attacker.near", ["spend"]) },
        }),
        { tenant_id: k.tenant, vault_id: k.vault },
      );
      expect(r.keys[0]?.status).toBe("pending");
      expect(r.checks[0]?.reason).toBe("scope_wrong_receiver");
    });

    it("refuses an agent key the vault does not list in list_agents", async () => {
      const k = await pending("agent");
      const r = await syncKeyStatuses(
        db(),
        chainReader(k.vault, { agents: [], keys: { [k.publicKey]: fc(k.vault, ["spend"]) } }),
        { tenant_id: k.tenant, vault_id: k.vault },
      );
      expect(r.keys[0]?.status).toBe("pending");
      expect(r.checks[0]?.reason).toBe("not_registered");
    });

    it("refuses a ledger key that is not get_config().ledger_key, then activates it once it is", async () => {
      const l = await pending("ledger");
      const keys = { [l.publicKey]: fc(l.vault, ["anchor"]) };
      for (const ledgerKey of [null, KeyPair.fromRandom("ed25519").getPublicKey().toString()]) {
        const r = await syncKeyStatuses(db(), chainReader(l.vault, { ledgerKey, keys }), {
          tenant_id: l.tenant,
          vault_id: l.vault,
        });
        expect(r.keys[0]?.status).toBe("pending");
        expect(r.checks[0]?.reason).toBe("not_registered");
      }
      // A registered *agent* key with the same public key does not make it the ledger key either.
      const asAgent = await syncKeyStatuses(
        db(),
        chainReader(l.vault, { agents: [l.publicKey], ledgerKey: null, keys }),
        { tenant_id: l.tenant, vault_id: l.vault },
      );
      expect(asAgent.keys[0]?.status).toBe("pending");
      const r = await syncKeyStatuses(
        db(),
        chainReader(l.vault, { ledgerKey: l.publicKey, keys }),
        {
          tenant_id: l.tenant,
          vault_id: l.vault,
        },
      );
      expect(r.keys[0]?.status).toBe("active");
      expect((await loadActiveSecret(db(), MASTER, l.tenant, "ledger"))?.secret).toBe(l.secret);
    });

    it("keeps a pending key pending while its access key is not on chain yet (NO_KEY)", async () => {
      const k = await pending("agent");
      const r = await syncKeyStatuses(db(), chainReader(k.vault, { agents: [k.publicKey] }), {
        tenant_id: k.tenant,
        vault_id: k.vault,
      });
      expect(r.keys[0]?.status).toBe("pending");
      expect(r.checks[0]?.reason).toBe("not_on_chain");
    });

    it("leaves every status unchanged on a read error, and never reads it as removed", async () => {
      const t = await tenant();
      const p = await pending("agent", t);
      const a = await pending("agent", t);
      const l = await pending("ledger", t);
      const good = {
        agents: [p.publicKey, a.publicKey],
        ledgerKey: l.publicKey,
        keys: {
          [a.publicKey]: fc(t.vault, ["spend"]),
          [l.publicKey]: fc(t.vault, ["anchor"]),
        },
      };
      await syncKeyStatuses(db(), chainReader(t.vault, good), {
        tenant_id: t.id,
        vault_id: t.vault,
      });
      expect([await statusOf(p.keyId), await statusOf(a.keyId), await statusOf(l.keyId)]).toEqual([
        "pending",
        "active",
        "active",
      ]);

      const broken: Chain[] = [
        // the access key read fails, for every key
        {
          ...good,
          keys: {
            [p.publicKey]: transportError(),
            [a.publicKey]: transportError(),
            [l.publicKey]: nodeError(),
          },
        },
        // list_agents fails: the agent keys cannot be judged (the ledger key still is, and stays active)
        {
          ...good,
          agents: transportError(),
          keys: {
            [a.publicKey]: NO_KEY,
            [p.publicKey]: fc(t.vault, ["spend"]),
            [l.publicKey]: fc(t.vault, ["anchor"]),
          },
        },
        // get_config fails: the ledger key cannot be judged
        { ...good, ledgerKey: transportError(), keys: { ...good.keys, [l.publicKey]: NO_KEY } },
      ];
      for (const c of broken) {
        const r = await syncKeyStatuses(db(), chainReader(t.vault, c), {
          tenant_id: t.id,
          vault_id: t.vault,
        });
        expect(
          r.keys.map((k) => [k.public_key, k.status]),
          JSON.stringify(c, (_k, v) => (v instanceof Error ? "Error" : v)),
        ).toEqual([
          [p.publicKey, "pending"],
          [a.publicKey, "active"],
          [l.publicKey, "active"],
        ]);
        expect(r.checks.some((x) => x.reason === "unreadable")).toBe(true);
        expect(r.checks.every((x) => x.to === x.from)).toBe(true);
      }
    });

    it("marks an active key removed on a definite NO_KEY answer", async () => {
      const k = await pending("agent");
      const on = { agents: [k.publicKey], keys: { [k.publicKey]: fc(k.vault, ["spend"]) } };
      await syncKeyStatuses(db(), chainReader(k.vault, on), {
        tenant_id: k.tenant,
        vault_id: k.vault,
      });
      expect(await statusOf(k.keyId)).toBe("active");

      // remove_agent deletes the key; list_agents may or may not have caught up.
      const r = await syncKeyStatuses(
        db(),
        chainReader(k.vault, { agents: [k.publicKey], keys: { [k.publicKey]: NO_KEY } }),
        { tenant_id: k.tenant, vault_id: k.vault },
      );
      expect(r.keys[0]?.status).toBe("removed");
      expect(r.keys[0]?.revoked_at).not.toBeNull();
      expect(r.checks[0]).toMatchObject({
        from: "active",
        to: "removed",
        reason: "removed_on_chain",
      });
      expect(await loadActiveSecret(db(), MASTER, k.tenant, "agent")).toBeNull();
    });

    it("revokes an active key the vault no longer lists, and one whose permission changed", async () => {
      const t = await tenant();
      const a = await pending("agent", t);
      const b = await pending("agent", t);
      const on = {
        agents: [a.publicKey, b.publicKey],
        keys: { [a.publicKey]: fc(t.vault, ["spend"]), [b.publicKey]: fc(t.vault, ["spend"]) },
      };
      await syncKeyStatuses(db(), chainReader(t.vault, on), { tenant_id: t.id, vault_id: t.vault });
      const logs = captureLogs();
      try {
        const r = await syncKeyStatuses(
          db(),
          chainReader(t.vault, {
            agents: [b.publicKey],
            keys: {
              [a.publicKey]: fc(t.vault, ["spend"]),
              [b.publicKey]: fc(t.vault, ["spend"], { kind: "GasKeyFunctionCall" }),
            },
          }),
          { tenant_id: t.id, vault_id: t.vault },
        );
        expect(r.checks.map((c) => [c.public_key, c.to, c.reason])).toEqual([
          [a.publicKey, "revoked", "unregistered"],
          [b.publicKey, "revoked", "scope_gas_key"],
        ]);
        expect(logs.lines.join("\n")).toContain("keys.active_scope_changed");
      } finally {
        logs.restore();
      }
      expect(await loadActiveSecret(db(), MASTER, t.id, "agent")).toBeNull();
    });

    it("never reads or moves a revoked or removed key again", async () => {
      const k = await pending("agent");
      await syncKeyStatuses(
        db(),
        chainReader(k.vault, {
          agents: [k.publicKey],
          keys: { [k.publicKey]: fc(k.vault, ["spend"]) },
        }),
        { tenant_id: k.tenant, vault_id: k.vault },
      );
      await syncKeyStatuses(db(), chainReader(k.vault, { agents: [] }), {
        tenant_id: k.tenant,
        vault_id: k.vault,
      });
      expect(await statusOf(k.keyId)).toBe("removed");
      const reads: string[] = [];
      const r = await syncKeyStatuses(
        db(),
        chainReader(k.vault, {
          agents: [k.publicKey],
          keys: { [k.publicKey]: fc(k.vault, ["spend"]) },
          reads,
        }),
        { tenant_id: k.tenant, vault_id: k.vault },
      );
      expect(reads).toEqual([]);
      expect(r.keys[0]?.status).toBe("removed");
      expect(r.checks).toEqual([]);
    });

    it("keeps exactly one active ledger key: a new set_ledger_key retires the old one", async () => {
      const t = await tenant();
      const a = await pending("ledger", t);
      const keys = { [a.publicKey]: fc(t.vault, ["anchor"]) };
      await syncKeyStatuses(db(), chainReader(t.vault, { ledgerKey: a.publicKey, keys }), {
        tenant_id: t.id,
        vault_id: t.vault,
      });
      const b = await pending("ledger", t);
      // set_ledger_key(b) deletes a's key and adds b's (the old one may still be visible for a block).
      const r = await syncKeyStatuses(
        db(),
        chainReader(t.vault, {
          ledgerKey: b.publicKey,
          keys: { ...keys, [b.publicKey]: fc(t.vault, ["anchor"]) },
        }),
        { tenant_id: t.id, vault_id: t.vault },
      );
      expect(r.keys.find((x) => x.public_key === a.publicKey)?.status).toBe("revoked");
      expect(r.keys.find((x) => x.public_key === b.publicKey)?.status).toBe("active");
      expect((await loadActiveSecret(db(), MASTER, t.id, "ledger"))?.publicKey).toBe(b.publicKey);
      const active = await pg.query(
        "select 1 from agent_keys where tenant_id = $1 and purpose = 'ledger' and status = 'active'",
        [t.id],
      );
      expect(active.rows).toHaveLength(1);
    });

    it("retires the old ledger key when the new one activates, even if the old key could not be read", async () => {
      const t = await tenant();
      const a = await pending("ledger", t);
      await syncKeyStatuses(
        db(),
        chainReader(t.vault, {
          ledgerKey: a.publicKey,
          keys: { [a.publicKey]: fc(t.vault, ["anchor"]) },
        }),
        { tenant_id: t.id, vault_id: t.vault },
      );
      const b = await pending("ledger", t);
      // a's own read fails, so the sync cannot judge a; get_config already names b.
      const r = await syncKeyStatuses(
        db(),
        chainReader(t.vault, {
          ledgerKey: b.publicKey,
          keys: { [a.publicKey]: transportError(), [b.publicKey]: fc(t.vault, ["anchor"]) },
        }),
        { tenant_id: t.id, vault_id: t.vault },
      );
      expect(r.checks.find((c) => c.public_key === a.publicKey)?.reason).toBe("unreadable");
      expect(r.keys.find((x) => x.public_key === b.publicKey)?.status).toBe("active");
      // agent_key_set_status retired a in the same statement (one active ledger key per tenant).
      expect(r.keys.find((x) => x.public_key === a.publicKey)?.status).toBe("revoked");
      expect((await loadActiveSecret(db(), MASTER, t.id, "ledger"))?.publicKey).toBe(b.publicKey);
    });

    it("hands out the most recently activated agent key", async () => {
      const t = await tenant();
      const a = await pending("agent", t);
      const b = await pending("agent", t);
      await syncKeyStatuses(
        db(),
        chainReader(t.vault, {
          agents: [b.publicKey],
          keys: { [b.publicKey]: fc(t.vault, ["spend"]) },
        }),
        { tenant_id: t.id, vault_id: t.vault },
      );
      await new Promise((r) => setTimeout(r, 5));
      await syncKeyStatuses(
        db(),
        chainReader(t.vault, {
          agents: [a.publicKey, b.publicKey],
          keys: { [a.publicKey]: fc(t.vault, ["spend"]), [b.publicKey]: fc(t.vault, ["spend"]) },
        }),
        { tenant_id: t.id, vault_id: t.vault },
      );
      expect((await loadActiveSecret(db(), MASTER, t.id, "agent"))?.publicKey).toBe(a.publicKey);
    });
  });

  describe("agent_key_set_status", () => {
    it("allows only pending→active, active→revoked and active→removed, compare-and-set", async () => {
      const k = await pending("agent");
      const set = (from: unknown, status: unknown, over: Record<string, unknown> = {}) =>
        db().rpc<{ id: string; status: string; changed: boolean }>("agent_key_set_status", {
          tenant_id: k.tenant,
          id: k.keyId,
          from,
          status,
          ...over,
        });
      for (const [from, to] of [
        ["pending", "revoked"],
        ["pending", "removed"],
        ["pending", "pending"],
        ["active", "pending"],
        ["revoked", "active"],
        ["removed", "active"],
        [null, "active"],
        ["pending", null],
        ["pending", "deleted"],
      ]) {
        await expect(set(from, to), `${from}→${to}`).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
      // Another tenant's id is not found, and a malformed id is invalid.
      await expect(set("pending", "active", { tenant_id: randomUUID() })).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(set("pending", "active", { id: "x" })).rejects.toMatchObject({
        code: "invalid_input",
      });
      // A stale `from` changes nothing.
      expect(await set("active", "removed")).toMatchObject({ status: "pending", changed: false });
      expect(await statusOf(k.keyId)).toBe("pending");
      expect(await set("pending", "active")).toMatchObject({ status: "active", changed: true });
      expect(await set("pending", "active")).toMatchObject({ status: "active", changed: false });
      expect(await set("active", "removed")).toMatchObject({ status: "removed", changed: true });
      await expect(set("removed", "active")).rejects.toMatchObject({ code: "invalid_input" });
      expect(await statusOf(k.keyId)).toBe("removed");
    });

    it("agent_keys_active_all lists every active key with its vault and no secret", async () => {
      const k = await pending("agent");
      await db().rpc("agent_key_set_status", {
        tenant_id: k.tenant,
        id: k.keyId,
        from: "pending",
        status: "active",
      });
      const all = await db().rpc<
        { tenant_id: string; vault_id: string; public_key: string; purpose: string }[]
      >("agent_keys_active_all", {});
      expect(all).toContainEqual({
        tenant_id: k.tenant,
        vault_id: k.vault,
        public_key: k.publicKey,
        purpose: "agent",
      });
      for (const row of all)
        expect(Object.keys(row).sort()).toEqual(["public_key", "purpose", "tenant_id", "vault_id"]);
    });
  });

  describe("privileges: the secret never leaves through the database API", () => {
    const FUNCTIONS = [
      "agent_key_uuid(text)",
      "agent_key_insert(jsonb)",
      "agent_key_list(jsonb)",
      "agent_key_secret(jsonb)",
      "agent_key_set_status(jsonb)",
      "agent_keys_active_all(jsonb)",
      "key_rotation_rows(jsonb)",
      "key_rotation_apply(jsonb)",
    ];

    it("grants every key function to service_role only, and PUBLIC holds no EXECUTE", async () => {
      for (const fn of FUNCTIONS) {
        const r = await pg.query<{ role: string; ok: boolean }>(
          `select r.role, has_function_privilege(r.role, ('public.' || $1)::regprocedure, 'execute') as ok
             from (values ('anon'), ('authenticated'), ('service_role')) as r(role)`,
          [fn],
        );
        expect(Object.fromEntries(r.rows.map((x) => [x.role, x.ok])), fn).toEqual({
          anon: false,
          authenticated: false,
          service_role: true,
        });
        const acl = await pg.query<{ acl: string | null; public_exec: number }>(
          `select p.proacl::text as acl,
                  (select count(*)::int from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
             from pg_proc p where p.oid = ('public.' || $1)::regprocedure`,
          [fn],
        );
        expect(acl.rows[0]?.acl, fn).not.toBeNull();
        expect(acl.rows[0]?.public_exec, fn).toBe(0);
      }
    });

    it("refuses every key function to anon and authenticated callers", async () => {
      const k = await pending("ledger");
      for (const role of ["anon", "authenticated"] as const) {
        const as = pgliteDb(pg, role, "acme.near");
        for (const fn of [
          "agent_key_secret",
          "agent_key_list",
          "agent_key_insert",
          "agent_key_set_status",
          "agent_keys_active_all",
          "key_rotation_rows",
          "key_rotation_apply",
        ]) {
          await expect(
            as.rpc(fn, { tenant_id: k.tenant, purpose: "ledger" }),
            `${role} ${fn}`,
          ).rejects.toThrow(/permission denied/);
        }
      }
    });

    it("lets a member read key metadata but never the ciphertext or nonce columns", async () => {
      const k = await pending("agent");
      const meta = await asRole(pg, "authenticated", "acme.near", (tx) =>
        tx.query<{ public_key: string; status: string }>(
          "select public_key, status from agent_keys where tenant_id = $1",
          [k.tenant],
        ),
      );
      expect(meta.rows).toEqual([{ public_key: k.publicKey, status: "pending" }]);
      for (const col of ["secret_ciphertext", "secret_nonce", "*"]) {
        await expect(
          asRole(pg, "authenticated", "acme.near", (tx) =>
            tx.query(`select ${col} from agent_keys`),
          ),
          col,
        ).rejects.toThrow(/permission denied/);
      }
      await expect(
        asRole(pg, "anon", null, (tx) => tx.query("select public_key from agent_keys")),
      ).rejects.toThrow(/permission denied/);
    });

    const LEAKS = `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and (p.proname like 'public\\_%'
             or has_function_privilege('anon', p.oid, 'execute')
             or has_function_privilege('authenticated', p.oid, 'execute'))
        and p.prosrc ~* '(secret_ciphertext|secret_nonce|content_ciphertext|content_nonce)'`;

    it("has no public_* or anon/authenticated-callable function that touches a sealed column", async () => {
      expect((await pg.query(LEAKS)).rows).toEqual([]);
    });

    it("that check fires on a function that would leak (rolled back)", async () => {
      await pg
        .transaction(async (tx) => {
          await tx.exec(`
            create function public.public_leak(p jsonb) returns jsonb language sql stable
              set search_path = public, pg_temp as $$ select jsonb_agg(secret_ciphertext) from public.agent_keys $$;
            grant execute on function public.public_leak(jsonb) to anon;
            create function public.member_leak(p jsonb) returns jsonb language sql stable
              set search_path = public, pg_temp as $$ select jsonb_agg(content_nonce) from public.invoices $$;
            grant execute on function public.member_leak(jsonb) to authenticated;`);
          const found = (await tx.query<{ proname: string }>(LEAKS)).rows
            .map((r) => r.proname)
            .sort();
          expect(found).toEqual(["member_leak", "public_leak"]);
          throw new Error("rollback");
        })
        .catch((e: unknown) => {
          if (!(e instanceof Error) || e.message !== "rollback") throw e;
        });
      expect((await pg.query(LEAKS)).rows).toEqual([]);
    });

    it("documents key_version as a rotation counter on the column itself", async () => {
      const r = await pg.query<{ c: string | null }>(
        `select col_description('public.agent_keys'::regclass,
           (select attnum from pg_attribute where attrelid = 'public.agent_keys'::regclass and attname = 'key_version')) as c`,
      );
      expect(r.rows[0]?.c).toMatch(/rotation counter/i);
      expect(r.rows[0]?.c).toMatch(/not .*master/i);
    });
  });
});

// ---- rotation ----------------------------------------------------------------------------------

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
  });

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
