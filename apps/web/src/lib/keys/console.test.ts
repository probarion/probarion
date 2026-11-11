import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { formatPublicKey } from "@probarion/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { openAgentSecret } from "@/lib/crypto/secrets";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import type { AccessKeyState, VaultReader } from "@/lib/near/reader";
import type { WalletTx } from "@/lib/near/tx";
import { freshDb, seedTenant } from "../../../test/db/harness";
import { silenceLogs } from "../../../test/db/keys-helpers";
import { pgliteDb } from "../../../test/db/pglite-db";
import { fakeReader, vaultConfig } from "../../../test/fixtures/reader";
import { transportError } from "../../../test/fixtures/rpc";

// The keys page and its actions, end to end over PGlite: who may do what (requireMember on the page,
// memberForApi through memberForAction in every action), and the one property that matters most here,
// that the secret of a generated key never reaches the browser, a log line or an action result.

type Captured = {
  label: string;
  tx?: WalletTx;
  prepare?: () => Promise<WalletTx | { error: string }>;
  expectedSigner?: string;
  confirm?: string;
  confirmTone?: string;
  lockKey?: string;
  onResult?: (r: unknown) => void | Promise<void>;
  describe?: (r: TxResult) => { detail?: string } | null | undefined;
};

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  db: null as unknown as Db,
  reader: null as unknown as VaultReader,
  revalidated: [] as string[],
  buttons: [] as Captured[],
  /** The vault account's code identity the page reads; null makes the read fail. */
  codeHash: null as string | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name) } : undefined),
  }),
  headers: async () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => {
    h.revalidated.push(p);
  },
}));
vi.mock("@/lib/crypto/server", async () => {
  const sodium = await import("@/lib/crypto/sodium");
  const master = sodium.parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
  return {
    masterKey: () => master,
    subkey: (purpose: Parameters<typeof sodium.deriveSubkey>[1]) =>
      sodium.deriveSubkey(master, purpose),
  };
});
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => h.db }));
vi.mock("@/lib/env", async () => {
  const { networkPart } = await import("../../../test/fixtures/networks");
  return { getEnv: () => networkPart({ defaultNetwork: "mainnet" }) };
});
vi.mock("@/lib/near/server", () => ({
  getReader: () => h.reader,
  getRpc: () => ({
    viewAccount: async () => {
      if (h.codeHash === null) throw new Error("no account read in this test");
      return {
        amount: "1",
        locked: "0",
        code_hash: h.codeHash,
        global_contract_hash: null,
        storage_usage: 1,
      };
    },
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/components/wallet/TxButton", () => ({
  TxButton: (p: Captured) => {
    h.buttons.push(p);
    return createElement("button", { type: "button" }, p.label);
  },
}));

import {
  discardKeyAction,
  generateKeyAction,
  keepKeyAction,
  syncKeysAction,
} from "@/app/console/[vault]/keys/actions";
import KeysPage, { maxDuration } from "@/app/console/[vault]/keys/page";
import {
  LEDGER_HELD_ELSEWHERE,
  REPLACE_MAYBE_OUTSIDE_LEDGER_CONFIRM,
  REPLACE_OUTSIDE_LEDGER_CONFIRM,
} from "@/components/console/KeyActions";
import { SIGNER_OUT_OF_NEAR } from "@/lib/console/display";
import { OUT_OF_NEAR } from "@/lib/console/out-of-near";
import { VAULT_CODE_HASHES_WITHOUT_LEDGER_RECOVERY } from "@/lib/keys/rules";
import type { TxResult } from "@/lib/near/outcome";
import { generateKey } from "./service";
import { loadKeysView } from "./view";

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
const VAULT = "acme.vaults.probarion.near";
const OTHER = "other.vaults.probarion.near";

let pg: PGlite;
let tenant: string;
/** Console output is silenced; the lines are kept for the exposure test. */
const logs = silenceLogs();

const fc = (methods: string[]): AccessKeyState => ({
  exists: true,
  kind: "FunctionCall",
  fullAccess: false,
  allowance: "1000000000000000000000000",
  receiverId: VAULT,
  methodNames: methods,
});
const NO_KEY: AccessKeyState = {
  exists: false,
  kind: null,
  fullAccess: false,
  allowance: null,
  receiverId: null,
  methodNames: [],
};

/** A chain on which every key the database knows is added and registered. */
function chainWithAllKeys(over: Partial<VaultReader> = {}): VaultReader {
  return fakeReader({
    getConfig: async () => vaultConfig({ owner: "acme.near", ledger_key: null }),
    listAgents: async () =>
      (
        await pg.query<{ public_key: string }>(
          "select public_key from agent_keys where purpose = 'agent'",
        )
      ).rows.map((r) => ({ public_key: r.public_key, label: "x", added_at_ns: "1" })),
    accessKey: async () => fc(["spend"]),
    ...over,
  });
}

beforeAll(async () => {
  pg = await freshDb();
  h.db = pgliteDb(pg);
  tenant = await seedTenant(pg, { vault: VAULT, owner: "acme.near", approvers: ["cfo.near"] });
  await seedTenant(pg, { vault: OTHER, owner: "mallory.near" });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(() => {
  h.jar.clear();
  h.revalidated.length = 0;
  h.buttons.length = 0;
  h.reader = chainWithAllKeys();
  h.codeHash = null;
});

async function signInAs(account: string) {
  h.jar.set(
    SESSION_COOKIE,
    await createSessionToken(await deriveSubkey(MASTER, "session"), account, "mainnet"),
  );
}

async function digest(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as { digest?: unknown }).digest ?? e);
  }
  return "no throw";
}

const page = (vault: string) => KeysPage({ params: Promise.resolve({ vault }) });
const html = async (vault: string) => renderToStaticMarkup((await page(vault)) as ReactElement);
const keyCount = async () =>
  (await pg.query<{ n: number }>("select count(*)::int as n from agent_keys")).rows[0]?.n;

/** The plaintext of every key in the database (the test holds the master; the app never shows it). */
async function allSecrets(): Promise<{ secrets: string[]; sealed: string[] }> {
  const rows = await pg.query<{ secret_ciphertext: string; secret_nonce: string }>(
    "select secret_ciphertext, secret_nonce from agent_keys",
  );
  const secrets: string[] = [];
  for (const r of rows.rows) secrets.push(await openAgentSecret(MASTER, r));
  return { secrets, sealed: rows.rows.flatMap((r) => [r.secret_ciphertext, r.secret_nonce]) };
}

describe("keys page guard (requireMember)", () => {
  it("exports maxDuration 60 (the wallet buttons wait for FINAL)", () => {
    expect(maxDuration).toBe(60);
  });

  it("sends a signed-out visitor to /login", async () => {
    expect(await digest(page(VAULT))).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login/);
  });

  it("is a 404 for a non-member and for a vault that does not exist", async () => {
    await signInAs("mallory.near");
    expect(await digest(page(VAULT))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(await digest(page("nope.vaults.probarion.near"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("shows an approver the keys but no button that generates, adds or removes one", async () => {
    await signInAs("acme.near");
    await generateKeyAction(VAULT, "agent", "payables");
    h.buttons.length = 0;
    await signInAs("cfo.near");
    const out = await html(VAULT);
    expect(out).toContain("payables");
    expect(out).toContain("Check on-chain status");
    expect(out).not.toContain("Generate agent key");
    expect(out).not.toContain("Add on-chain");
    expect(h.buttons).toEqual([]);
  });

  it("gives the owner the wallet buttons, signed by the session account, each with a stable lock key", async () => {
    // Several keys of each kind, so every per-key button appears more than once.
    for (const purpose of ["agent", "agent", "ledger", "ledger"] as const) {
      await generateKey(h.db, MASTER, {
        tenantId: tenant,
        purpose,
        label: "x",
        createdBy: "acme.near",
      });
    }
    await signInAs("acme.near");
    const out = await html(VAULT);
    expect(h.buttons.filter((b) => b.label === "Add on-chain").length).toBeGreaterThanOrEqual(2);
    expect(h.buttons.filter((b) => b.label === "Set as ledger key").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(out).toContain("Generate agent key and add it in my wallet");
    expect(out).toContain("Generate ledger key and set it in my wallet");
    expect(h.buttons.length).toBeGreaterThanOrEqual(2);
    for (const b of h.buttons) {
      expect(b.expectedSigner, b.label).toBe("acme.near");
      expect(b.lockKey, b.label).toMatch(/^probarion:txlock:keys:/);
    }
    const locks = h.buttons.map((b) => b.lockKey);
    expect(new Set(locks).size).toBe(locks.length);
  });
});

describe("key buttons: out-of-NEAR wording (W-T8-R1)", () => {
  it("names the signer first on every key button, and leaves other refusals alone", async () => {
    await signInAs("acme.near");
    await generateKeyAction(VAULT, "agent", "wording"); // a pending key: its "Add on-chain" button too
    h.buttons.length = 0;
    await html(VAULT);
    expect(h.buttons.some((b) => b.label === "Add on-chain")).toBe(true);
    const outOfNear = OUT_OF_NEAR.codes[0];
    expect(outOfNear).toBeDefined();
    for (const b of h.buttons) {
      const r = (code: string | null): TxResult => ({
        status: "failed",
        txHash: "h",
        code,
        error: "x",
      });
      expect(b.describe?.(r(outOfNear ?? null)), b.label).toEqual({ detail: SIGNER_OUT_OF_NEAR });
      expect(b.describe?.(r("PROBARION:NotOwner")), b.label).toBeUndefined();
    }
  });
});

describe("key actions guard (memberForApi)", () => {
  it("generate: 401 signed out, 403 for a non-member and for an approver, and nothing is stored", async () => {
    const before = await keyCount();
    expect(await generateKeyAction(VAULT, "agent", "x")).toMatchObject({ status: 401 });
    await signInAs("mallory.near");
    expect(await generateKeyAction(VAULT, "agent", "x")).toMatchObject({ status: 403 });
    await signInAs("cfo.near");
    expect(await generateKeyAction(VAULT, "ledger", "x")).toMatchObject({ status: 403 });
    // The vault id is only a lookup key: acme.near owns VAULT, not OTHER.
    await signInAs("acme.near");
    expect(await generateKeyAction(OTHER, "agent", "x")).toMatchObject({ status: 403 });
    expect(await keyCount()).toBe(before);
  });

  it("generate refuses a purpose or label the form should never send", async () => {
    await signInAs("acme.near");
    const before = await keyCount();
    expect(await generateKeyAction(VAULT, "full" as never, "x")).toEqual({
      error: expect.stringMatching(/purpose/),
    });
    expect(await generateKeyAction(VAULT, "agent", "a".repeat(65))).toEqual({
      error: expect.stringMatching(/64 bytes/),
    });
    expect(await keyCount()).toBe(before);
  });

  it("generate gives the owner an add_agent / set_ledger_key for the PUBLIC key only", async () => {
    await signInAs("acme.near");
    const agent = (await generateKeyAction(VAULT, "agent", " payroll ")) as WalletTx;
    expect(agent.receiverId).toBe(VAULT);
    expect(agent.actions).toHaveLength(1);
    const call = agent.actions[0];
    expect(call?.type).toBe("FunctionCall");
    if (call?.type !== "FunctionCall") throw new Error("expected one FunctionCall");
    expect(call.params.methodName).toBe("add_agent");
    expect(call.params.args).toEqual({
      public_key: expect.stringMatching(/^ed25519:/),
      allowance: "1000000000000000000000000",
      label: "payroll",
    });
    const row = await pg.query<{
      status: string;
      tenant_id: string;
      created_by: string;
      label: string;
    }>("select status, tenant_id, created_by, label from agent_keys where public_key = $1", [
      call.params.args.public_key,
    ]);
    expect(row.rows).toEqual([
      { status: "pending", tenant_id: tenant, created_by: "acme.near", label: "payroll" },
    ]);

    const ledger = (await generateKeyAction(VAULT, "ledger", "")) as WalletTx;
    const set = ledger.actions[0];
    if (set?.type !== "FunctionCall") throw new Error("expected one FunctionCall");
    expect(set.params.methodName).toBe("set_ledger_key");
    expect(Object.keys(set.params.args).sort()).toEqual(["allowance", "public_key"]);
    expect(set.params.args.allowance).toBe("250000000000000000000000");
  });

  it("sync: 401 signed out, 403 for a non-member; any member may re-read the chain", async () => {
    expect(await syncKeysAction(VAULT, null)).toMatchObject({ ok: false, status: 401 });
    await signInAs("mallory.near");
    expect(await syncKeysAction(VAULT, null)).toMatchObject({ ok: false, status: 403 });
    expect(h.revalidated).toEqual([]);
    await signInAs("cfo.near");
    expect(await syncKeysAction(VAULT, null)).toMatchObject({ ok: true });
    expect(h.revalidated).toEqual([`/console/${VAULT}/keys`]);
  });

  it("sync says the chain could not be read and changes nothing", async () => {
    await signInAs("acme.near");
    await generateKeyAction(VAULT, "agent", "x");
    const before = (await pg.query("select id, status from agent_keys order by id")).rows;
    h.reader = chainWithAllKeys({
      listAgents: async () => {
        throw transportError();
      },
      getConfig: async () => {
        throw transportError();
      },
      accessKey: async () => {
        throw transportError();
      },
    });
    const r = await syncKeysAction(VAULT, null);
    expect(r).toMatchObject({ ok: true });
    expect(JSON.stringify(r)).toMatch(/unchanged/);
    expect((await pg.query("select id, status from agent_keys order by id")).rows).toEqual(before);
  });
});

describe("pending, registered and stuck keys (W-T10-R1)", () => {
  let n = 0;
  /** A vault of its own (acme.near owns it, cfo.near approves), so these tests see only their keys. */
  async function ownVault(): Promise<{ vault: string; tenantId: string }> {
    n += 1;
    const vault = `r${n}.vaults.probarion.near`;
    return {
      vault,
      tenantId: await seedTenant(pg, { vault, owner: "acme.near", approvers: ["cfo.near"] }),
    };
  }
  const publicKeyOf = (tx: unknown) => {
    const a = (tx as WalletTx).actions[0];
    return a?.type === "FunctionCall" ? (a.params.args.public_key as string) : null;
  };
  const statusOf = async (publicKey: string | null) =>
    (
      await pg.query<{ status: string }>("select status from agent_keys where public_key = $1", [
        publicKey,
      ])
    ).rows[0]?.status;

  it("generate hands out the same unused pending key again instead of a new one", async () => {
    const { vault, tenantId } = await ownVault();
    await signInAs("acme.near");
    const first = publicKeyOf(await generateKeyAction(vault, "agent", "one"));
    const again = publicKeyOf(await generateKeyAction(vault, "agent", "two"));
    expect(again).toBe(first);
    const rows = await pg.query("select label from agent_keys where tenant_id = $1", [tenantId]);
    expect(rows.rows).toEqual([{ label: "two" }]);
  });

  it("discard: owner only; it sets a pending key aside, and the next generate makes a new key", async () => {
    const { vault } = await ownVault();
    await signInAs("acme.near");
    const pk = publicKeyOf(await generateKeyAction(vault, "agent", "x"));
    const id = (
      await pg.query<{ id: string }>("select id from agent_keys where public_key = $1", [pk])
    ).rows[0]?.id as string;
    for (const who of [null, "mallory.near", "cfo.near"]) {
      h.jar.clear();
      if (who) await signInAs(who);
      await discardKeyAction(vault, id);
      expect(await statusOf(pk), String(who)).toBe("pending");
    }
    // The vault id is only a lookup key: mallory.near's own vault does not reach acme's key.
    await signInAs("mallory.near");
    await discardKeyAction(OTHER, id);
    expect(await statusOf(pk)).toBe("pending");

    await signInAs("acme.near");
    h.buttons.length = 0;
    expect(await html(vault)).toContain("Discard");
    await discardKeyAction(vault, id);
    expect(await statusOf(pk)).toBe("removed");
    expect(h.revalidated).toContain(`/console/${vault}/keys`);
    const next = publicKeyOf(await generateKeyAction(vault, "agent", "x"));
    expect(next).not.toBe(pk);
  });

  it("offers Remove for every agent key the vault registers, and shows a stuck key for what it is", async () => {
    const { vault, tenantId } = await ownVault();
    const mk = async (purpose: "agent" | "ledger") =>
      (await generateKey(h.db, MASTER, { tenantId, purpose, label: "x", createdBy: "acme.near" }))
        .publicKey;
    const stuckAgent = await mk("agent"); // list_agents has it, its access key was never added
    const goneAgent = await mk("agent"); // removed here, but still listed (and keyless)
    const plainAgent = await mk("agent"); // pending, not on chain at all
    const stuckLedger = await mk("ledger"); // get_config names it, no access key
    const plainLedger = await mk("ledger"); // pending, not on chain: still not offered while stuck
    await pg.query(
      "update agent_keys set status = 'removed', revoked_at = now() where public_key = $1",
      [goneAgent],
    );
    h.reader = fakeReader({
      getConfig: async () => vaultConfig({ owner: "acme.near", ledger_key: stuckLedger }),
      listAgents: async () =>
        [stuckAgent, goneAgent].map((pk) => ({ public_key: pk, label: "x", added_at_ns: "1" })),
      accessKey: async () => NO_KEY,
    });
    await signInAs("acme.near");
    const sync = await syncKeysAction(vault, null);
    const notes = sync?.ok ? sync.notes.join("\n") : "";
    expect(notes).toMatch(/registered in the vault but its access key was never added/);
    // The vault's code could not be read here, so the ledger note says so (W-T10-R3).
    expect(notes).toMatch(/code could not be read/);
    expect(notes).not.toMatch(/contract fix/i);
    expect(notes).not.toMatch(/check again in a minute.*(registered|contract)/);
    // With old vault code, the sync says the vault needs a new one.
    h.codeHash = VAULT_CODE_HASHES_WITHOUT_LEDGER_RECOVERY[0] ?? null;
    const oldSync = await syncKeysAction(vault, null);
    expect(oldSync?.ok ? oldSync.notes.join("\n") : "").toMatch(/needs a new vault/);
    h.codeHash = null;

    h.buttons.length = 0;
    const out = await html(vault);
    expect(out.match(/Stuck: this key/g)?.length).toBe(3); // the two keyless agents and the ledger key
    const removeFor = h.buttons
      .filter((b) => b.label === "Remove")
      .map((b) => publicKeyOf(b.tx))
      .sort();
    expect(removeFor).toEqual([stuckAgent, goneAgent].sort());
    // A key the vault already registers is never offered for adding again (the contract would refuse it).
    const addFor = h.buttons
      .filter((b) => b.label === "Add on-chain")
      .map((b) => publicKeyOf(b.tx));
    expect(addFor).toEqual([plainAgent]);
    expect(out).toContain(plainLedger);
    expect(h.buttons.filter((b) => b.label === "Set as ledger key")).toEqual([]);
    for (const b of h.buttons) expect(b.expectedSigner, b.label).toBe("acme.near");
    // The ledger key is stuck, and the vault's code could not be read: no new ledger key is offered.
    expect(h.buttons.map((b) => b.label)).not.toContain(
      "Generate ledger key and set it in my wallet",
    );
    expect(out).toContain("could not be read, so a new");
    expect(out).not.toMatch(/contract fix/i);
    expect(h.buttons.map((b) => b.label)).toContain("Generate agent key and add it in my wallet");

    // Old vault code (before the set_ledger_key fix): a stuck ledger key cannot be replaced there.
    h.codeHash = VAULT_CODE_HASHES_WITHOUT_LEDGER_RECOVERY[0] ?? null;
    h.buttons.length = 0;
    const onOld = await html(vault);
    expect(onOld).toContain("This vault&#x27;s code cannot replace a stuck ledger key");
    expect(onOld).toContain("needs a new vault");
    expect(h.buttons.map((b) => b.label)).not.toContain(
      "Generate ledger key and set it in my wallet",
    );
    expect(h.buttons.filter((b) => b.label === "Set as ledger key")).toEqual([]);
    // Current code: setting a new ledger key recovers it, so it is offered, with the top-up advice.
    h.codeHash = "11111111111111111111111111111111";
    h.buttons.length = 0;
    const onCurrent = await html(vault);
    expect(onCurrent).toContain("Setting a new ledger key recovers it");
    expect(onCurrent).toContain("top it up");
    expect(h.buttons.map((b) => b.label)).toContain("Generate ledger key and set it in my wallet");
    expect(
      h.buttons.filter((b) => b.label === "Set as ledger key").map((b) => publicKeyOf(b.tx)),
    ).toEqual([plainLedger]);
    expect(onCurrent).not.toMatch(/contract fix/i);
    h.codeHash = null;

    // An approver sees the same state, with no button.
    await signInAs("cfo.near");
    h.buttons.length = 0;
    const seen = await html(vault);
    expect(seen.match(/Stuck: this key/g)?.length).toBe(3);
    expect(h.buttons).toEqual([]);
    expect(seen).not.toContain("Discard");
  });

  it("shows a discarded key that is on chain, and lets only the owner Keep it, through the full check", async () => {
    const { vault, tenantId } = await ownVault();
    const k = await generateKey(h.db, MASTER, {
      tenantId,
      purpose: "agent",
      label: "x",
      createdBy: "acme.near",
    });
    await pg.query(
      "update agent_keys set status = 'removed', revoked_at = now(), discarded_at = now() where id = $1",
      [k.id],
    );
    const onChain = fakeReader({
      getConfig: async () => vaultConfig({ owner: "acme.near", ledger_key: null }),
      listAgents: async () => [{ public_key: k.publicKey, label: "x", added_at_ns: "1" }],
      accessKey: async () => ({ ...fc(["spend"]), receiverId: vault }),
    });
    h.reader = onChain;
    await signInAs("acme.near");
    const sync = await syncKeysAction(vault, null);
    expect(sync?.ok ? sync.notes.join("\n") : "").toMatch(/on the vault although you discarded it/);
    expect(await statusOf(k.publicKey)).toBe("removed"); // a sync never makes it active

    h.buttons.length = 0;
    const out = await html(vault);
    expect(out).toContain(
      "Discarded, but on chain: this key is on the vault although you discarded it",
    );
    expect(out).toContain(">Keep<");
    expect(h.buttons.filter((b) => b.label === "Remove").map((b) => publicKeyOf(b.tx))).toEqual([
      k.publicKey,
    ]);

    // Keep: not for a signed-out visitor, a non-member, an approver, or another vault's owner.
    for (const [who, at] of [
      [null, vault],
      ["mallory.near", vault],
      ["cfo.near", vault],
      ["mallory.near", OTHER],
    ] as const) {
      h.jar.clear();
      if (who) await signInAs(who);
      const r = await keepKeyAction(at, k.id);
      expect(r?.ok, `${who} ${at}`).toBe(false);
      expect(r?.message, `${who} ${at}`).toBeTruthy();
      expect(await statusOf(k.publicKey), `${who} ${at}`).toBe("removed");
    }
    // The owner, while the chain does not show the full state: still not kept.
    await signInAs("acme.near");
    h.reader = fakeReader({
      getConfig: async () => vaultConfig({ owner: "acme.near", ledger_key: null }),
      listAgents: async () => [],
      accessKey: async () => ({ ...fc(["spend"]), receiverId: vault }),
    });
    expect(await keepKeyAction(vault, k.id)).toEqual({
      ok: false,
      message: "Not kept: the vault does not register this key. Nothing changed.",
    });
    expect(await statusOf(k.publicKey)).toBe("removed");
    // The owner, with the full state on chain: kept, active.
    h.reader = onChain;
    expect(await keepKeyAction(vault, k.id)).toEqual({
      ok: true,
      message: "Kept: the key is active again.",
    });
    expect(await statusOf(k.publicKey)).toBe("active");
    expect(h.revalidated).toContain(`/console/${vault}/keys`);

    // An approver sees the note but no Keep.
    await pg.query(
      "update agent_keys set status = 'removed', revoked_at = now(), discarded_at = now() where id = $1",
      [k.id],
    );
    await signInAs("cfo.near");
    h.buttons.length = 0;
    const seen = await html(vault);
    expect(seen).toContain("Discarded, but on chain");
    expect(seen).not.toContain(">Keep<");
    expect(h.buttons).toEqual([]);

    // On chain, registered, but as a gas key: Keep would refuse, so it is not offered.
    h.reader = fakeReader({
      getConfig: async () => vaultConfig({ owner: "acme.near", ledger_key: null }),
      listAgents: async () => [{ public_key: k.publicKey, label: "x", added_at_ns: "1" }],
      accessKey: async () => ({
        ...fc(["spend"]),
        receiverId: vault,
        kind: "GasKeyFunctionCall" as const,
      }),
    });
    await signInAs("acme.near");
    await syncKeysAction(vault, null);
    h.buttons.length = 0;
    const gas = await html(vault);
    expect(gas).not.toContain("Discarded, but on chain");
    expect(gas).not.toContain(">Keep<");
  });
});

describe("the secret never leaves the server", () => {
  it("is absent from every action result, the rendered page, every prop and every log line", async () => {
    const out: string[] = [];
    {
      await signInAs("acme.near");
      out.push(JSON.stringify(await generateKeyAction(VAULT, "agent", "payables")));
      out.push(JSON.stringify(await generateKeyAction(VAULT, "ledger", "ledger")));
      // Activate them: every agent key is listed, and the newest ledger key is get_config's.
      const newestLedger = (
        await pg.query<{ public_key: string }>(
          "select public_key from agent_keys where purpose = 'ledger' order by created_at desc limit 1",
        )
      ).rows[0]?.public_key;
      h.reader = chainWithAllKeys({
        getConfig: async () => vaultConfig({ owner: "acme.near", ledger_key: newestLedger }),
        accessKey: async (_v, pk) => (pk === newestLedger ? fc(["anchor"]) : fc(["spend"])),
      });
      out.push(JSON.stringify(await syncKeysAction(VAULT, null)));

      // Every role's page, with every prop the wallet buttons received.
      for (const who of ["acme.near", "cfo.near"]) {
        await signInAs(who);
        h.buttons.length = 0;
        out.push(await html(VAULT));
        out.push(JSON.stringify(h.buttons));
        // And what the buttons themselves would do: prepare a transaction, sync afterwards.
        for (const b of [...h.buttons]) {
          if (b.prepare) out.push(JSON.stringify(await b.prepare()));
          if (b.onResult) out.push(JSON.stringify((await b.onResult({ status: "ok" })) ?? null));
        }
      }
      out.push(
        JSON.stringify(await loadKeysView(h.db, h.reader, { tenant_id: tenant, vault_id: VAULT })),
      );
    }

    const { secrets, sealed } = await allSecrets();
    expect(secrets.length).toBeGreaterThanOrEqual(3);
    expect(
      (await pg.query("select 1 from agent_keys where status = 'active'")).rows.length,
    ).toBeGreaterThan(0);
    const everything = [...out, ...logs.lines].join("\n");
    // The log lines were captured (so their check below means something).
    expect(logs.lines.some((l) => /keys\.(generated|reused_pending)/.test(l))).toBe(true);
    expect(everything).toContain("ed25519:"); // public keys are shown, as they should be
    for (const secret of secrets) {
      const body = secret.slice("ed25519:".length);
      expect(everything).not.toContain(body);
      expect(everything).not.toContain(body.slice(20, 50));
    }
    for (const s of sealed) expect(everything).not.toContain(s);
  });

  it("the page loader copies named fields only, so a secret column a query returned would not pass", async () => {
    const leaky: Db = {
      async rpc<T>(fn: string, p?: Record<string, unknown>): Promise<T> {
        const r = await h.db.rpc<unknown>(fn, p);
        if (fn !== "agent_key_list") return r as T;
        return (r as Record<string, unknown>[]).map((row) => ({
          ...row,
          secret_ciphertext: "LEAKED-CIPHERTEXT",
          secret: "ed25519:LEAKED",
        })) as T;
      },
    };
    const view = await loadKeysView(leaky, chainWithAllKeys(), {
      tenant_id: tenant,
      vault_id: VAULT,
    });
    expect(view.keys.length).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toMatch(/LEAKED/);
  });
});

describe("allowance shown on the page", () => {
  it("reads the allowance only from a key that exists: NO_KEY is not on chain, never unlimited", async () => {
    await signInAs("acme.near");
    await generateKeyAction(VAULT, "agent", "allow");
    await syncKeysAction(VAULT, null); // every agent key is on the chain above: all become active
    const seen = async (accessKey: VaultReader["accessKey"]) => {
      const view = await loadKeysView(h.db, chainWithAllKeys({ accessKey }), {
        tenant_id: tenant,
        vault_id: VAULT,
      });
      return view.keys.filter((k) => k.status === "active").map((k) => k.allowance);
    };
    expect(await seen(async () => fc(["spend"]))).toContainEqual({
      state: "limited",
      yocto: "1000000000000000000000000",
    });
    expect(await seen(async () => NO_KEY)).toContainEqual({ state: "not_on_chain" });
    expect((await seen(async () => NO_KEY)).some((a) => a?.state === "unlimited")).toBe(false);
    expect(await seen(async () => ({ ...fc(["spend"]), allowance: null }))).toContainEqual({
      state: "unlimited",
    });
    expect(
      await seen(async () => {
        throw transportError();
      }),
    ).toContainEqual({ state: "unavailable", why: "transport" });

    h.reader = chainWithAllKeys({ accessKey: async () => NO_KEY });
    const out = await html(VAULT);
    expect(out).toContain("not on chain");
    expect(out).not.toMatch(/unlimited/i);
  });
});

describe("static guards: only server code can reach a secret", () => {
  const SRC = fileURLToPath(new URL("../..", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
    });
  const source = (p: string) => readFileSync(p, "utf8");

  it("the key service and the page loader are server-only modules", () => {
    for (const f of ["lib/keys/service.ts", "lib/keys/view.ts"]) {
      expect(source(join(SRC, f)).startsWith('import "server-only";'), f).toBe(true);
    }
  });

  it("no client module imports the key service, the loader or the secret crypto", () => {
    const offenders = files(SRC)
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => /^\s*["']use client["']/.test(source(f)))
      .filter((f) =>
        /@\/lib\/keys\/(service|view)|@\/lib\/crypto\/(secrets|server)|lib\/keys\/rotate/.test(
          source(f),
        ),
      )
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("no page, action or component opens a secret (only the server cycles of Tasks 13 and 17 may)", () => {
    const offenders = [...files(join(SRC, "app")), ...files(join(SRC, "components"))]
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) =>
        /loadActiveSecret|loadActiveSecretFor|openAgentSecret|agent_key_secret|key_rotation_rows/.test(
          source(f),
        ),
      )
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});

describe("keys held outside Probarion (the user's own agent, Agent (MCP) tab)", () => {
  const OWN_AGENT = formatPublicKey(new Uint8Array(32).fill(77));
  const OWN_LEDGER = formatPublicKey(new Uint8Array(32).fill(78));
  /** This vault's agent keys from its own key rows, as the chain would list them once added. */
  const consoleAgents = async () =>
    (
      await pg.query<{ public_key: string }>(
        "select public_key from agent_keys where purpose = 'agent' and tenant_id = $1",
        [tenant],
      )
    ).rows.map((r) => ({ public_key: r.public_key, label: "x", added_at_ns: "1" }));
  /** The chain with every key this vault's rows name, plus the user's own agent key and ledger key. */
  const withOwnAgent = (over: Partial<VaultReader> = {}) =>
    chainWithAllKeys({
      getConfig: async () => vaultConfig({ owner: "acme.near", ledger_key: OWN_LEDGER }),
      listAgents: async () => [
        ...(await consoleAgents()),
        { public_key: OWN_AGENT, label: "mcp-claude", added_at_ns: "2" },
      ],
      accessKey: async (_v, key) => fc([key === OWN_LEDGER ? "anchor" : "spend"]),
      ...over,
    });
  const view = (reader: VaultReader) =>
    loadKeysView(h.db, reader, { tenant_id: tenant, vault_id: VAULT });

  it("lists the vault's keys that have no key row, with their allowance, and says the ledger key is held elsewhere", async () => {
    const v = await view(withOwnAgent());
    expect(v.outside).toEqual([
      {
        purpose: "agent",
        public_key: OWN_AGENT,
        label: "mcp-claude",
        allowance: { state: "limited", yocto: "1000000000000000000000000" },
      },
      {
        purpose: "ledger",
        public_key: OWN_LEDGER,
        // The vault stores no label for its ledger key: the table names it, as the mockup does.
        label: "the vault's ledger key",
        allowance: { state: "limited", yocto: "1000000000000000000000000" },
      },
    ]);
    expect(v.ledgerHeldElsewhere).toBe(true);
  });

  it("lists nothing when every key on the vault is one the console made", async () => {
    const v = await view(chainWithAllKeys({ listAgents: consoleAgents }));
    expect(v.outside).toEqual([]);
    expect(v.ledgerHeldElsewhere).toBe(false);
  });

  it("says unknown, never none, when the chain's key list or config cannot be read", async () => {
    const noConfig = await view(
      withOwnAgent({
        getConfig: async () => {
          throw transportError();
        },
      }),
    );
    expect(noConfig.outside).toBeNull();
    expect(noConfig.ledgerHeldElsewhere).toBeNull();
    const noAgents = await view(
      withOwnAgent({
        listAgents: async () => {
          throw transportError();
        },
      }),
    );
    expect(noAgents.outside).toBeNull();
    expect(noAgents.ledgerHeldElsewhere).toBe(true);
  });

  it("shows the owner the card, Remove for the agent key, and the ledger key's way to Agent (MCP)", async () => {
    await signInAs("acme.near");
    h.reader = withOwnAgent();
    const out = (await html(VAULT)).replaceAll("&#x27;", "'");
    expect(out).toContain("On the vault, held outside Probarion");
    expect(out).toContain(
      "These keys are on the vault but Probarion did not make them: your own agent holds their secrets. Probarion's hosted Payables never signs with them.",
    );
    expect(out).toContain(OWN_AGENT);
    expect(out).toContain("<td>the vault's ledger key</td>");
    expect(out).toContain(`href="/console/${VAULT}/agent"`);
    expect(out).toContain("See Agent (MCP)");
    const remove = h.buttons.find(
      (b) => b.label === "Remove" && JSON.stringify(b.tx).includes(OWN_AGENT),
    );
    expect(remove?.tx?.receiverId).toBe(VAULT);
    expect(JSON.stringify(remove?.tx)).toContain('"remove_agent"');
    expect(remove?.confirmTone).toBe("danger");
    // No button removes or replaces the ledger key from this card.
    expect(h.buttons.some((b) => JSON.stringify(b.tx ?? {}).includes(OWN_LEDGER))).toBe(false);
  });

  it("warns in red before a ledger key made here replaces the agent's, and asks with a danger confirm", async () => {
    await signInAs("acme.near");
    h.reader = withOwnAgent();
    const out = (await html(VAULT)).replaceAll("&#x27;", "'");
    expect(out).toContain(LEDGER_HELD_ELSEWHERE);
    expect(LEDGER_HELD_ELSEWHERE).toBe(
      "The vault's ledger key is held outside Probarion, by your own agent. A ledger key made here replaces it, and that agent then refuses every payment. Hosted Payables needs a vault of its own.",
    );
    const generate = h.buttons.find(
      (b) => b.label === "Generate ledger key and set it in my wallet",
    );
    expect(generate?.confirm).toBe(REPLACE_OUTSIDE_LEDGER_CONFIRM);
    expect(generate?.confirmTone).toBe("danger");
    expect(REPLACE_OUTSIDE_LEDGER_CONFIRM).toMatch(/refuses every payment/);
  });

  it("asks with a danger confirm that says it is unknown when the vault's keys could not be read", async () => {
    await signInAs("acme.near");
    h.reader = withOwnAgent({
      getConfig: async () => {
        throw transportError();
      },
    });
    await html(VAULT);
    const generate = h.buttons.find(
      (b) => b.label === "Generate ledger key and set it in my wallet",
    );
    expect(generate?.confirm).toBe(REPLACE_MAYBE_OUTSIDE_LEDGER_CONFIRM);
    expect(generate?.confirmTone).toBe("danger");
    expect(REPLACE_MAYBE_OUTSIDE_LEDGER_CONFIRM).toMatch(
      /^The vault's keys could not be read\. If/,
    );
    expect(REPLACE_MAYBE_OUTSIDE_LEDGER_CONFIRM).not.toMatch(/held outside Probarion\?/);
  });

  it("keeps the plain confirm when the vault's ledger key is the console's own", async () => {
    await signInAs("acme.near");
    h.reader = chainWithAllKeys({ listAgents: consoleAgents });
    const out = (await html(VAULT)).replaceAll("&#x27;", "'");
    expect(out).not.toContain(LEDGER_HELD_ELSEWHERE);
    expect(out).not.toContain("On the vault, held outside Probarion");
    const generate = h.buttons.find(
      (b) => b.label === "Generate ledger key and set it in my wallet",
    );
    expect(generate?.confirmTone).toBeUndefined();
    expect(generate?.confirm).not.toBe(REPLACE_OUTSIDE_LEDGER_CONFIRM);
  });

  it("shows an approver the card, with no Remove", async () => {
    await signInAs("cfo.near");
    h.reader = withOwnAgent();
    const out = await html(VAULT);
    expect(out).toContain("On the vault, held outside Probarion");
    expect(out).toContain(OWN_AGENT);
    expect(h.buttons).toEqual([]);
  });
});
