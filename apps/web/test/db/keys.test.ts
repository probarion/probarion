import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { KeyPair, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openAgentSecret, sealAgentSecret } from "@/lib/crypto/secrets";
import {
  discardKey,
  generateKey,
  KeyMismatchError,
  type KeyRow,
  keepKey,
  listKeys,
  loadActiveSecret,
  loadActiveSecretFor,
  PENDING_REUSE_SECONDS,
  reuseOrGenerateKey,
  SYNC_READ_CONCURRENCY,
  syncKeyStatuses,
} from "@/lib/keys/service";
import type { AccessKeyState, VaultReader } from "@/lib/near/reader";
import { fakeReader, vaultConfig } from "../fixtures/reader";
import { nodeError, transportError } from "../fixtures/rpc";
import { asRole, freshDb, seedTenant } from "./harness";
import { at, expectNoSecret, MASTER, silenceLogs } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

// Agent and ledger keys over PGlite: generation, the activation rules, the SQL guards and privileges.
// Master-key rotation is in key-rotation.test.ts.

/** Every console line, silenced and kept for the tests that check what was (not) logged. */
const logs = silenceLogs();

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
  "chain_checked_at",
  "chain_has_key",
  "chain_registered",
  "chain_scoped",
  "chain_seen",
  "created_at",
  "created_by",
  "discarded_at",
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
  /** Holds each view_access_key read open until the returned promise resolves. */
  delay?: () => Promise<void>;
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
      await c.delay?.();
      const k = c.keys?.[pk] ?? NO_KEY;
      if (k instanceof Error) throw k;
      return k;
    },
  });
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
      expect(await loadActiveSecretFor(db(), MASTER, k.tenant, k.publicKey)).toBeNull();
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
      logs.lines.length = 0;
      {
        const k = await pending("agent");
        expect(logs.lines.join("\n")).toContain(k.publicKey);
        expectNoSecret(logs.lines.join("\n"), k.secret);
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
      const e = await loadActiveSecretFor(db(), MASTER, a.tenant, b.publicKey).catch(
        (x: unknown) => x,
      );
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
      const loaded = await loadActiveSecretFor(db(), MASTER, k.tenant, k.publicKey);
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
      logs.lines.length = 0;
      {
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
      const r = await syncKeyStatuses(db(), chainReader(k.vault, { agents: [] }), {
        tenant_id: k.tenant,
        vault_id: k.vault,
      });
      expect(r.keys[0]?.status).toBe("pending");
      expect(r.checks[0]?.reason).toBe("not_on_chain");
      // Read, so the key now has an observation: not registered, no key, never seen.
      expect(r.keys[0]).toMatchObject({
        chain_registered: false,
        chain_has_key: false,
        chain_seen: false,
      });
      expect(r.keys[0]?.chain_checked_at).not.toBeNull();
    });

    it("reports an agent key list_agents has but whose access key was never added as stuck, and stores it", async () => {
      const k = await pending("agent");
      const r = await syncKeyStatuses(db(), chainReader(k.vault, { agents: [k.publicKey] }), {
        tenant_id: k.tenant,
        vault_id: k.vault,
      });
      expect(r.keys[0]?.status).toBe("pending");
      expect(r.checks[0]?.reason).toBe("registered_without_key");
      expect(r.keys[0]).toMatchObject({
        chain_registered: true,
        chain_has_key: false,
        chain_seen: true,
      });
    });

    it("reports a ledger key get_config names but whose access key was never added as stuck", async () => {
      const l = await pending("ledger");
      const r = await syncKeyStatuses(db(), chainReader(l.vault, { ledgerKey: l.publicKey }), {
        tenant_id: l.tenant,
        vault_id: l.vault,
      });
      expect(r.keys[0]?.status).toBe("pending");
      expect(r.checks[0]?.reason).toBe("registered_without_key");
      expect(r.keys[0]).toMatchObject({ chain_registered: true, chain_has_key: false });
      expect(await loadActiveSecret(db(), MASTER, l.tenant, "ledger")).toBeNull();
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
      expect(await loadActiveSecretFor(db(), MASTER, k.tenant, k.publicKey)).toBeNull();
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
      logs.lines.length = 0;
      {
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
      }
      for (const key of [a, b]) {
        expect(await loadActiveSecretFor(db(), MASTER, t.id, key.publicKey)).toBeNull();
      }
    });

    it("a NO_KEY (a lagging node), then the key back on chain: active again, through the full check only", async () => {
      const k = await pending("agent");
      const on = { agents: [k.publicKey], keys: { [k.publicKey]: fc(k.vault, ["spend"]) } };
      await syncKeyStatuses(db(), chainReader(k.vault, on), {
        tenant_id: k.tenant,
        vault_id: k.vault,
      });
      // One node lags and says the key is gone.
      await syncKeyStatuses(db(), chainReader(k.vault, { agents: [k.publicKey] }), {
        tenant_id: k.tenant,
        vault_id: k.vault,
      });
      expect(await statusOf(k.keyId)).toBe("removed");
      expect(await loadActiveSecretFor(db(), MASTER, k.tenant, k.publicKey)).toBeNull();

      // A removed key is still read, but anything short of the full check leaves it removed.
      for (const partial of [
        { agents: [], keys: on.keys },
        {
          agents: [k.publicKey],
          keys: { [k.publicKey]: fc(k.vault, ["spend"], { kind: "GasKeyFunctionCall" }) },
        },
        { agents: [k.publicKey], keys: { [k.publicKey]: fc(k.vault, ["spend", "approve"]) } },
        { agents: [k.publicKey], keys: { [k.publicKey]: transportError() } },
      ]) {
        const reads: string[] = [];
        const r = await syncKeyStatuses(db(), chainReader(k.vault, { ...partial, reads }), {
          tenant_id: k.tenant,
          vault_id: k.vault,
        });
        expect(reads).toEqual([k.publicKey]);
        expect(r.keys[0]?.status).toBe("removed");
      }

      // The next node shows it, exactly as the vault added it: active again.
      const r = await syncKeyStatuses(db(), chainReader(k.vault, on), {
        tenant_id: k.tenant,
        vault_id: k.vault,
      });
      expect(r.checks[0]).toMatchObject({ from: "removed", to: "active", reason: "reactivated" });
      expect(r.keys[0]?.revoked_at).toBeNull();
      expect((await loadActiveSecretFor(db(), MASTER, k.tenant, k.publicKey))?.publicKey).toBe(
        k.publicKey,
      );
    });

    it("two overlapping ledger syncs, one on a stale node: the final state follows the chain", async () => {
      const t = await tenant();
      const a = await pending("ledger", t);
      const b = await pending("ledger", t);
      const keys = {
        [a.publicKey]: fc(t.vault, ["anchor"]),
        [b.publicKey]: fc(t.vault, ["anchor"]),
      };
      const sync = (ledgerKey: string) =>
        syncKeyStatuses(db(), chainReader(t.vault, { ledgerKey, keys }), {
          tenant_id: t.id,
          vault_id: t.vault,
        });
      // The chain: a was the ledger key, then the owner set b.
      await sync(a.publicKey); // an old sync, from before set_ledger_key(b)
      await sync(b.publicKey); // a fresh sync: b active, a retired
      await sync(a.publicKey); // a stale node, still at the old block: wrongly brings back a, retiring b
      expect(await statusOf(a.keyId)).toBe("active");
      expect(await statusOf(b.keyId)).toBe("revoked");
      // The next fresh sync puts the chain's ledger key back: b active, a retired, exactly one active.
      const r = await sync(b.publicKey);
      expect(r.keys.find((k) => k.id === b.keyId)?.status).toBe("active");
      expect(r.keys.find((k) => k.id === a.keyId)?.status).toBe("revoked");
      expect((await loadActiveSecret(db(), MASTER, t.id, "ledger"))?.publicKey).toBe(b.publicKey);
      const active = await pg.query(
        "select 1 from agent_keys where tenant_id = $1 and purpose = 'ledger' and status = 'active'",
        [t.id],
      );
      expect(active.rows).toHaveLength(1);
    });

    it(`reads at most ${SYNC_READ_CONCURRENCY} access keys at a time`, async () => {
      const t = await tenant();
      for (let i = 0; i < 10; i++) await pending("agent", t);
      let inFlight = 0;
      let most = 0;
      const reads: string[] = [];
      await syncKeyStatuses(
        db(),
        chainReader(t.vault, {
          agents: [],
          reads,
          delay: async () => {
            inFlight += 1;
            most = Math.max(most, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight -= 1;
          },
        }),
        { tenant_id: t.id, vault_id: t.vault },
      );
      expect(reads).toHaveLength(10);
      expect(most).toBe(SYNC_READ_CONCURRENCY);
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

    it("hands out no agent key by purpose: loadActiveSecret is ledger only, by type and in SQL", async () => {
      const t = await tenant();
      const a = await pending("agent", t);
      await syncKeyStatuses(
        db(),
        chainReader(t.vault, {
          agents: [a.publicKey],
          keys: { [a.publicKey]: fc(t.vault, ["spend"]) },
        }),
        { tenant_id: t.id, vault_id: t.vault },
      );
      expect(await statusOf(a.keyId)).toBe("active");
      // A payment signs with the key its mandate is bound to (loadActiveSecretFor), never "the" agent key.
      // @ts-expect-error: the purpose is "ledger" only (W-T10-R3)
      await expect(loadActiveSecret(db(), MASTER, t.id, "agent")).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(
        db().rpc("agent_key_secret", { tenant_id: t.id, purpose: "agent" }),
      ).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(db().rpc("agent_key_secret", { tenant_id: t.id })).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect((await loadActiveSecretFor(db(), MASTER, t.id, a.publicKey))?.secret).toBe(a.secret);
    });
  });

  describe("agent_key_set_status", () => {
    it("allows only pending→active, active→revoked/removed and revoked/removed→active, compare-and-set", async () => {
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
        ["revoked", "removed"],
        ["removed", "revoked"],
        ["removed", "pending"],
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
      // Back from removed or revoked (the caller asks only after the full activation check).
      expect(await set("removed", "active")).toMatchObject({ status: "active", changed: true });
      expect(await set("active", "revoked")).toMatchObject({ status: "revoked", changed: true });
      expect(await set("removed", "active")).toMatchObject({ status: "revoked", changed: false });
      expect(await set("revoked", "active")).toMatchObject({ status: "active", changed: true });
      const row = (
        await pg.query<{ activated_at: string | null; revoked_at: string | null }>(
          "select activated_at, revoked_at from agent_keys where id = $1",
          [k.keyId],
        )
      ).rows[0];
      expect(row?.activated_at).not.toBeNull();
      expect(row?.revoked_at).toBeNull();
    });

    it("agent_key_observe records what one sync saw, for the tenant's own keys only, all or nothing", async () => {
      const t = await tenant();
      const a = await pending("agent", t);
      const b = await pending("agent", t);
      const other = await pending("agent");
      const observe = (keys: unknown[], tenantId = t.id) =>
        db().rpc("agent_key_observe", { tenant_id: tenantId, keys });
      const state = async (id: string) =>
        (
          await pg.query(
            "select chain_registered, chain_has_key, chain_scoped, chain_seen from agent_keys where id = $1",
            [id],
          )
        ).rows[0];
      for (const bad of [
        [{ id: a.keyId, registered: "yes", has_key: false, scoped: false }],
        [{ id: a.keyId, registered: true, scoped: false }],
        [{ id: a.keyId, registered: true, has_key: true }],
        [{ id: a.keyId, registered: true, has_key: true, scoped: "yes" }],
        [{ id: "x", registered: true, has_key: true, scoped: true }],
      ]) {
        await expect(observe(bad)).rejects.toMatchObject({ code: "invalid_input" });
      }
      await expect(
        db().rpc("agent_key_observe", { tenant_id: t.id, keys: "x" }),
      ).rejects.toMatchObject({
        code: "invalid_input",
      });
      // Another tenant's key in the batch: not_found, and nothing of the batch is written.
      await expect(
        observe([
          { id: a.keyId, registered: true, has_key: true, scoped: true },
          { id: other.keyId, registered: true, has_key: true, scoped: true },
        ]),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await state(a.keyId)).toEqual({
        chain_registered: null,
        chain_has_key: null,
        chain_scoped: null,
        chain_seen: false,
      });
      await observe([
        { id: a.keyId, registered: true, has_key: false, scoped: false },
        { id: b.keyId, registered: false, has_key: true, scoped: true },
      ]);
      expect(await state(a.keyId)).toEqual({
        chain_registered: true,
        chain_has_key: false,
        chain_scoped: false,
        chain_seen: true,
      });
      expect(await state(b.keyId)).toEqual({
        chain_registered: false,
        chain_has_key: true,
        chain_scoped: true,
        chain_seen: true,
      });
      // chain_seen is sticky.
      await observe([{ id: a.keyId, registered: false, has_key: false, scoped: false }]);
      expect(await state(a.keyId)).toEqual({
        chain_registered: false,
        chain_has_key: false,
        chain_scoped: false,
        chain_seen: true,
      });
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

  describe("pending keys: reuse and discard (W-T10-R1)", () => {
    const offer = (t: { id: string }, purpose: "agent" | "ledger", label = "payables") =>
      reuseOrGenerateKey(db(), MASTER, { tenantId: t.id, purpose, label, createdBy: "acme.near" });

    it("hands out the same recent unused pending key again, with the new label, per purpose", async () => {
      const t = await tenant();
      const first = await offer(t, "agent", "one");
      expect(first.reused).toBe(false);
      const again = await offer(t, "agent", "two");
      expect(again).toEqual({ id: first.id, publicKey: first.publicKey, reused: true });
      const rows = await listKeys(db(), t.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.label).toBe("two");
      // Another purpose is another key.
      const ledger = await offer(t, "ledger", "ledger");
      expect(ledger.reused).toBe(false);
      expect(ledger.publicKey).not.toBe(first.publicKey);
    });

    it("never reuses a key seen on chain, an old one, a non-pending one, or another tenant's", async () => {
      const t = await tenant();
      const seen = await offer(t, "agent");
      await db().rpc("agent_key_observe", {
        tenant_id: t.id,
        keys: [{ id: seen.id, registered: true, has_key: false, scoped: false }],
      });
      const afterSeen = await offer(t, "agent");
      expect(afterSeen.reused).toBe(false);

      await pg.query(
        "update agent_keys set created_at = now() - make_interval(secs => $1) where id = $2",
        [PENDING_REUSE_SECONDS + 60, afterSeen.id],
      );
      const afterOld = await offer(t, "agent");
      expect(afterOld.reused).toBe(false);

      await discardKey(db(), t.id, afterOld.id);
      const afterDiscard = await offer(t, "agent");
      expect(afterDiscard.reused).toBe(false);

      const u = await tenant();
      const theirs = await offer(u, "agent");
      expect(theirs.publicKey).not.toBe(afterDiscard.publicKey);
      expect((await offer(u, "agent")).id).toBe(theirs.id);
      expect(new Set([seen.id, afterSeen.id, afterOld.id, afterDiscard.id]).size).toBe(4);
    });

    it("refuses a malformed reuse request", async () => {
      const t = await tenant();
      for (const bad of [
        { purpose: "full" },
        { label: "a".repeat(65) },
        { max_age_seconds: 0 },
        { max_age_seconds: "86400" },
        { tenant_id: "x" },
      ]) {
        await expect(
          db().rpc("agent_key_reuse_pending", {
            tenant_id: t.id,
            purpose: "agent",
            label: "x",
            max_age_seconds: 86400,
            ...bad,
          }),
          JSON.stringify(bad),
        ).rejects.toMatchObject({ code: "invalid_input" });
      }
    });

    it("discard sets a pending key aside (removed) and leaves any other key as it is", async () => {
      const t = await tenant();
      const p = await pending("agent", t);
      const a = await pending("agent", t);
      await db().rpc("agent_key_set_status", {
        tenant_id: t.id,
        id: a.keyId,
        from: "pending",
        status: "active",
      });
      expect(await discardKey(db(), t.id, p.keyId)).toEqual({
        id: p.keyId,
        status: "removed",
        changed: true,
      });
      expect(await discardKey(db(), t.id, p.keyId)).toEqual({
        id: p.keyId,
        status: "removed",
        changed: false,
      });
      expect(await discardKey(db(), t.id, a.keyId)).toEqual({
        id: a.keyId,
        status: "active",
        changed: false,
      });
      expect(await statusOf(a.keyId)).toBe("active");
      await expect(discardKey(db(), randomUUID(), p.keyId)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(discardKey(db(), t.id, "x")).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  describe("W-T10-R2: the key a payment signs with", () => {
    const activate = (tenantId: string, id: string, from = "pending") =>
      db().rpc("agent_key_set_status", { tenant_id: tenantId, id, from, status: "active" });
    const activatedAt = async (id: string) =>
      (
        await pg.query<{ a: string }>(
          "select activated_at::text as a from agent_keys where id = $1",
          [id],
        )
      ).rows[0]?.a;
    const pause = () => new Promise((r) => setTimeout(r, 5));

    it("a reactivated older key keeps its first activation date and never displaces the current key", async () => {
      const t = await tenant();
      const tt = { tenant_id: t.id, vault_id: t.vault };
      const k1 = await pending("agent", t);
      const k2 = await pending("agent", t);
      await activate(t.id, k1.keyId);
      await pause();
      await activate(t.id, k2.keyId); // K2 is the current key: the mandates are bound to it
      const k1First = await activatedAt(k1.keyId);
      const k2First = await activatedAt(k2.keyId);
      expect((await loadActiveSecretFor(db(), MASTER, t.id, k2.publicKey))?.publicKey).toBe(
        k2.publicKey,
      );

      // A lagging node: K1 is gone, then back, through the full check.
      const keys = {
        [k1.publicKey]: fc(t.vault, ["spend"]),
        [k2.publicKey]: fc(t.vault, ["spend"]),
      };
      const agents = [k1.publicKey, k2.publicKey];
      await syncKeyStatuses(
        db(),
        chainReader(t.vault, { agents, keys: { ...keys, [k1.publicKey]: NO_KEY } }),
        tt,
      );
      expect(await statusOf(k1.keyId)).toBe("removed");
      await pause();
      const r = await syncKeyStatuses(db(), chainReader(t.vault, { agents, keys }), tt);
      expect(r.checks.find((c) => c.id === k1.keyId)?.reason).toBe("reactivated");
      expect(await activatedAt(k1.keyId)).toBe(k1First);
      expect((await loadActiveSecretFor(db(), MASTER, t.id, k2.publicKey))?.publicKey).toBe(
        k2.publicKey,
      );

      // The same for K2: gone and back, it is still the current key, with its first date.
      await syncKeyStatuses(
        db(),
        chainReader(t.vault, { agents, keys: { ...keys, [k2.publicKey]: NO_KEY } }),
        tt,
      );
      await pause();
      await syncKeyStatuses(db(), chainReader(t.vault, { agents, keys }), tt);
      expect(await statusOf(k2.keyId)).toBe("active");
      expect(await activatedAt(k2.keyId)).toBe(k2First);
      expect((await loadActiveSecretFor(db(), MASTER, t.id, k2.publicKey))?.publicKey).toBe(
        k2.publicKey,
      );
    });

    it("loadActiveSecretFor never hands out the ledger key, even for a mandate that names it", async () => {
      const t = await tenant();
      const l = await pending("ledger", t);
      await activate(t.id, l.keyId);
      expect((await loadActiveSecret(db(), MASTER, t.id, "ledger"))?.secret).toBe(l.secret);
      expect(await loadActiveSecretFor(db(), MASTER, t.id, l.publicKey)).toBeNull();
      expect(
        await db().rpc("agent_key_secret_for", { tenant_id: t.id, public_key: l.publicKey }),
      ).toBeNull();
    });

    it("loadActiveSecretFor refuses a row that is not an agent key's, even if the database returned one", async () => {
      const t = await tenant();
      const l = await pending("ledger", t);
      await activate(t.id, l.keyId);
      const sealed = (
        await pg.query<{ secret_ciphertext: string; secret_nonce: string }>(
          "select secret_ciphertext, secret_nonce from agent_keys where id = $1",
          [l.keyId],
        )
      ).rows[0];
      const lying = {
        rpc: async <T>() =>
          ({ public_key: l.publicKey, purpose: "ledger", ...sealed }) as unknown as T,
      };
      expect(await loadActiveSecretFor(lying, MASTER, t.id, l.publicKey)).toBeNull();
    });

    it("loadActiveSecretFor opens exactly the bound key while it is active, and refuses everything else", async () => {
      const t = await tenant();
      const bound = await pending("agent", t);
      const newer = await pending("agent", t);
      await activate(t.id, bound.keyId);
      await pause();
      await activate(t.id, newer.keyId);
      // The mandate's key, though not the newest.
      expect(await loadActiveSecretFor(db(), MASTER, t.id, bound.publicKey)).toEqual({
        publicKey: bound.publicKey,
        secret: bound.secret,
      });
      expect((await loadActiveSecretFor(db(), MASTER, t.id, newer.publicKey))?.secret).toBe(
        newer.secret,
      );
      // Pending, removed, another tenant's, unknown: null.
      const p = await pending("agent", t);
      expect(await loadActiveSecretFor(db(), MASTER, t.id, p.publicKey)).toBeNull();
      await db().rpc("agent_key_set_status", {
        tenant_id: t.id,
        id: bound.keyId,
        from: "active",
        status: "removed",
      });
      expect(await loadActiveSecretFor(db(), MASTER, t.id, bound.publicKey)).toBeNull();
      const other = await tenant();
      expect(await loadActiveSecretFor(db(), MASTER, other.id, newer.publicKey)).toBeNull();
      const unknown = KeyPair.fromRandom("ed25519").getPublicKey().toString();
      expect(await loadActiveSecretFor(db(), MASTER, t.id, unknown)).toBeNull();
      await expect(loadActiveSecretFor(db(), MASTER, t.id, "ed25519:short")).rejects.toMatchObject({
        code: "invalid_input",
      });
      // A ciphertext in the wrong row is refused, never opened as another key.
      await pg.query(
        `update agent_keys set secret_ciphertext = s.secret_ciphertext, secret_nonce = s.secret_nonce
           from (select secret_ciphertext, secret_nonce from agent_keys where id = $1) s where id = $2`,
        [p.keyId, newer.keyId],
      );
      const e = await loadActiveSecretFor(db(), MASTER, t.id, newer.publicKey).catch(
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(KeyMismatchError);
      expectNoSecret(String((e as Error).message), p.secret);
    });

    it("a discarded key that appears on chain is never made active by a sync, and set_status refuses it", async () => {
      const t = await tenant();
      const k = await pending("agent", t);
      await discardKey(db(), t.id, k.keyId);
      const on = { agents: [k.publicKey], keys: { [k.publicKey]: fc(t.vault, ["spend"]) } };
      const r = await syncKeyStatuses(db(), chainReader(t.vault, on), {
        tenant_id: t.id,
        vault_id: t.vault,
      });
      expect(r.checks[0]).toMatchObject({
        from: "removed",
        to: "removed",
        reason: "discarded_on_chain",
      });
      expect(r.keys[0]).toMatchObject({
        status: "removed",
        chain_registered: true,
        chain_has_key: true,
      });
      expect(r.keys[0]?.discarded_at).not.toBeNull();
      expect(await loadActiveSecretFor(db(), MASTER, t.id, k.publicKey)).toBeNull();
      await expect(activate(t.id, k.keyId, "removed")).rejects.toMatchObject({ code: "discarded" });
      expect(await statusOf(k.keyId)).toBe("removed");
    });

    it("Keep makes a discarded key active only through the same full check", async () => {
      const t = await tenant();
      const k = await pending("agent", t);
      await discardKey(db(), t.id, k.keyId);
      const tt = { tenant_id: t.id, vault_id: t.vault };
      // Short of the full check: nothing changes.
      const partials: Chain[] = [
        { agents: [], keys: { [k.publicKey]: fc(t.vault, ["spend"]) } },
        {
          agents: [k.publicKey],
          keys: { [k.publicKey]: fc(t.vault, ["spend"], { kind: "GasKeyFunctionCall" }) },
        },
        { agents: [k.publicKey] },
        { agents: [k.publicKey], keys: { [k.publicKey]: transportError() } },
      ];
      // Each refusal names what is missing (the page shows it, W-T10-R3).
      const reasons: string[] = [];
      for (const partial of partials) {
        const r = await keepKey(db(), chainReader(t.vault, partial), tt, k.keyId);
        expect(r.kept).toBe(false);
        reasons.push(r.reason);
        expect(await statusOf(k.keyId)).toBe("removed");
      }
      expect(reasons).toEqual([
        "not_registered",
        "scope_gas_key",
        "registered_without_key",
        "unreadable",
      ]);
      const on = { agents: [k.publicKey], keys: { [k.publicKey]: fc(t.vault, ["spend"]) } };
      expect(await keepKey(db(), chainReader(t.vault, on), tt, k.keyId)).toEqual({
        kept: true,
        reason: "reactivated",
      });
      const row = (await listKeys(db(), t.id))[0];
      expect(row).toMatchObject({ status: "active", discarded_at: null, revoked_at: null });
      expect(row?.activated_at).not.toBeNull();
      expect((await loadActiveSecretFor(db(), MASTER, t.id, k.publicKey))?.secret).toBe(k.secret);
      // A key that is not discarded is never kept; another tenant's id is not found.
      expect((await keepKey(db(), chainReader(t.vault, on), tt, k.keyId)).reason).toBe(
        "not_discarded",
      );
      const other = await tenant();
      const theirs = { tenant_id: other.id, vault_id: t.vault };
      expect((await keepKey(db(), chainReader(t.vault, on), theirs, k.keyId)).reason).toBe(
        "not_found",
      );
      // agent_key_keep itself: another tenant is not_found, a non-discarded key is changed:false.
      await expect(
        db().rpc("agent_key_keep", { tenant_id: other.id, id: k.keyId }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await db().rpc("agent_key_keep", { tenant_id: t.id, id: k.keyId })).toMatchObject({
        changed: false,
      });
    });

    it("Keep refuses a key the owner never discarded, even one on chain (only a sync activates that)", async () => {
      const t = await tenant();
      const tt = { tenant_id: t.id, vault_id: t.vault };
      const k = await pending("agent", t);
      await activate(t.id, k.keyId);
      await db().rpc("agent_key_set_status", {
        tenant_id: t.id,
        id: k.keyId,
        from: "active",
        status: "removed",
      });
      const on = { agents: [k.publicKey], keys: { [k.publicKey]: fc(t.vault, ["spend"]) } };
      expect(await keepKey(db(), chainReader(t.vault, on), tt, k.keyId)).toEqual({
        kept: false,
        reason: "not_discarded",
      });
      expect(await statusOf(k.keyId)).toBe("removed");
      // agent_key_keep itself leaves a removed key that was never discarded as it is.
      expect(await db().rpc("agent_key_keep", { tenant_id: t.id, id: k.keyId })).toEqual({
        id: k.keyId,
        status: "removed",
        changed: false,
      });
      expect(await statusOf(k.keyId)).toBe("removed");
    });

    it("Keep of a discarded ledger key retires the other active ledger key", async () => {
      const t = await tenant();
      const a = await pending("ledger", t);
      const b = await pending("ledger", t);
      await activate(t.id, a.keyId);
      await discardKey(db(), t.id, b.keyId);
      const on = {
        ledgerKey: b.publicKey,
        keys: { [a.publicKey]: NO_KEY, [b.publicKey]: fc(t.vault, ["anchor"]) },
      };
      const tt = { tenant_id: t.id, vault_id: t.vault };
      expect((await keepKey(db(), chainReader(t.vault, on), tt, b.keyId)).kept).toBe(true);
      expect(await statusOf(b.keyId)).toBe("active");
      expect(await statusOf(a.keyId)).toBe("revoked");
    });
  });

  describe("privileges: the secret never leaves through the database API", () => {
    const FUNCTIONS = [
      "agent_key_uuid(text)",
      "agent_key_insert(jsonb)",
      "agent_key_list(jsonb)",
      "agent_key_secret(jsonb)",
      "agent_key_set_status(jsonb)",
      "agent_key_observe(jsonb)",
      "agent_key_reuse_pending(jsonb)",
      "agent_key_discard(jsonb)",
      "agent_key_keep(jsonb)",
      "agent_key_secret_for(jsonb)",
      "agent_key_make_active(uuid, uuid, text)",
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
          "agent_key_observe",
          "agent_key_reuse_pending",
          "agent_key_discard",
          "agent_key_keep",
          "agent_key_secret_for",
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
