import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { freshDb, seedTenant } from "./db/harness";
import { pgliteDb } from "./db/pglite-db";
import { MAINNET_HOST, TESTNET_HOST } from "./fixtures/networks";

// W-NET-R4: a tenant's network is fixed. This was the adversarial case ADV-NET-1 of the review of task NET: at the TESTNET
// address, with the testnet chain showing a Probarion vault at the same id string, owned by the same owner string, Register
// used to rewrite tenants.network to testnet, and the membership (account strings, not per network) then opened the mainnet
// vault at the testnet address and turned its owner away from the mainnet one. It must now fail at every step.
const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  host: null as string | null,
  db: null as unknown as Db,
  chainCalls: [] as string[],
  revalidated: [] as string[],
  /** What the (fake) testnet chain answers for get_config at the vault id. */
  testnetConfig: null as unknown,
}));

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name) } : undefined),
    set: () => {},
  }),
  headers: async () => ({ get: (name: string) => (name === "host" ? h.host : null) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => h.revalidated.push(p) }));
vi.mock("@/lib/crypto/server", () => ({
  masterKey: () => MASTER,
  subkey: (purpose: Parameters<typeof deriveSubkey>[1]) => deriveSubkey(MASTER, purpose),
}));
vi.mock("@/lib/db/clients", () => ({
  serviceDb: () => h.db,
  publicDb: () => h.db,
}));
vi.mock("@/lib/env", async () => {
  const { networkPart } = await import("./fixtures/networks");
  return {
    getEnv: () => ({
      ...networkPart({ defaultNetwork: "testnet", both: true }),
      ONECLICK_JWT: null,
      TELEGRAM_BOT_TOKEN: null,
      RESEND_API_KEY: null,
      NEARAI_API_KEY: null,
      NEARAI_MODEL: null,
    }),
  };
});
// The chain check has its own tests; here it passes, and is recorded, so that "no chain was asked" covers it too.
vi.mock("@/lib/near/chain", async (orig) => ({
  ...(await orig<typeof import("@/lib/near/chain")>()),
  ensureChain: async (network: string) => {
    h.chainCalls.push(`chain:${network}`);
  },
}));
vi.mock("@/lib/near/server", async () => {
  const { NETWORKS } = await import("@probarion/core");
  const { KNOWN_VAULT_CODE_HASHES: KNOWN } = await import("@probarion/core");
  const down = (what: string) => async () => {
    throw new Error(`${what} is unreachable in this test`);
  };
  return {
    getReader: (network: string) => {
      h.chainCalls.push(`reader:${network}`);
      return new Proxy(
        {},
        {
          get: (_t, method) =>
            method === "getConfig" && network === "testnet"
              ? async () => h.testnetConfig
              : down(`reader.${String(method)}`),
        },
      );
    },
    getRpc: (network: string) => {
      h.chainCalls.push(`rpc:${network}`);
      return new Proxy(
        {},
        {
          get: (_t, method) =>
            method === "viewAccount" && network === "testnet"
              ? async () => ({ code_hash: KNOWN[0], global_contract_hash: null, amount: "1" })
              : down(`rpc.${String(method)}`),
        },
      );
    },
    chainConsts: (network: "mainnet" | "testnet") => NETWORKS[network],
  };
});

import { syncKeysAction } from "@/app/console/[vault]/keys/actions";
import { registerVaultAction } from "@/app/console/actions";
import { REGISTER_ERROR_TEXT } from "@/lib/console/vaults";
import { LIMITS } from "@/lib/ratelimit";

// A vault id and an owner id that two different people can each hold, one per chain (for example a top-level name long
// enough that no registrar is needed). Any id string works the same way for the code; nothing checks the shape.
const VAULT = "acmetreasuryvaultonmainnet0000001";
const OWNER = "acmetreasuryowneronmainnet0000001";

let pg: PGlite;
let tenantId: string;

beforeAll(async () => {
  pg = await freshDb();
  h.db = pgliteDb(pg);
  tenantId = await seedTenant(pg, {
    vault: VAULT,
    owner: OWNER,
    approvers: ["cfo.near"],
    network: "mainnet",
  });
  h.testnetConfig = {
    owner: OWNER,
    approvers: ["mallory.testnet"],
    usdc: "usdc.probarion.testnet",
    intents: "intents-stub.probarion.testnet",
    allowed_assets: [],
    daily_backstop: "0",
    held_ttl_ns: "0",
    frozen: false,
    factory: null,
    version: "1.0.0",
    ledger_key: null,
  };
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  h.jar.clear();
  h.chainCalls = [];
  h.revalidated = [];
  await pg.exec("delete from public.rate_limits");
});

const asTestnet = async () => {
  h.host = TESTNET_HOST;
  h.jar.set(
    SESSION_COOKIE,
    await createSessionToken(await deriveSubkey(MASTER, "session"), OWNER, "testnet"),
  );
};
/** A signed-in account at an address of `network`. */
const asAccount = async (account: string, network: "mainnet" | "testnet") => {
  h.host = network === "testnet" ? TESTNET_HOST : MAINNET_HOST;
  h.jar.set(
    SESSION_COOKIE,
    await createSessionToken(await deriveSubkey(MASTER, "session"), account, network),
  );
};
const asMainnet = async () => {
  h.host = MAINNET_HOST;
  h.jar.set(
    SESSION_COOKIE,
    await createSessionToken(await deriveSubkey(MASTER, "session"), OWNER, "mainnet"),
  );
};
const row = async () =>
  (
    await pg.query<{ network: string }>("select network from public.tenants where id = $1", [
      tenantId,
    ])
  ).rows[0]?.network;
const members = async () =>
  (
    await pg.query<{ account_id: string; role: string }>(
      "select account_id, role from public.tenant_members where tenant_id = $1 order by account_id",
      [tenantId],
    )
  ).rows;

describe("Register at the testnet address cannot move a mainnet tenant to testnet", () => {
  const SENTENCE = "This vault is on NEAR mainnet. Open it at the mainnet address.";

  it("answers 409 before any chain client is made, and leaves the tenant, its members and the guard as they were", async () => {
    await asTestnet();
    // The guard holds before: a testnet session for the same id string gets 409 on the mainnet tenant.
    expect(await syncKeysAction(VAULT)).toMatchObject({ status: 409 });
    const peopleBefore = await members();
    h.chainCalls = [];

    const r = await registerVaultAction(VAULT);
    expect(r).toEqual({ ok: false, error: SENTENCE, code: "network_mismatch", status: 409 });
    expect(h.chainCalls).toEqual([]);
    expect(h.revalidated).toEqual([]);
    expect(await row()).toBe("mainnet");
    expect(await members()).toEqual(peopleBefore);

    // Still the same after: the testnet session is turned away, and no chain was asked.
    h.chainCalls = [];
    expect(await syncKeysAction(VAULT)).toMatchObject({ status: 409 });
    expect(h.chainCalls).toEqual([]);

    // And the mainnet owner, at the mainnet address, still reaches the vault: past the guard, to the mainnet chain.
    await asMainnet();
    const owner = await syncKeysAction(VAULT).catch(() => undefined);
    expect((owner as { status?: number } | undefined)?.status).not.toBe(409);
    expect(h.chainCalls).toContain("reader:mainnet");
  });

  it("is refused by the database as well, when the action's own check is out of the way", async () => {
    // The action is the first line; tenant_register is the last. Call it as the action would have after a lookup that raced.
    await expect(
      h.db.rpc("tenant_register", {
        vault_id: VAULT,
        network: "testnet",
        kind: "external",
        display_name: null,
        owner_account: OWNER,
        approvers: ["mallory.testnet"],
      }),
    ).rejects.toMatchObject({ code: "network_mismatch" });
    expect(await row()).toBe("mainnet");
    expect((await members()).map((m) => m.account_id)).not.toContain("mallory.testnet");
  });
});

// Round 2 (W-NET-R5), RR1-ORACLE: the pre-check's answer names the network a vault is registered on, so it is given only to a
// member of that tenant, by the membership read the guards use. Everyone else goes on as for a vault nobody registered.
describe("Register tells only a member which network a vault is on", () => {
  const STRANGER = "mallory.testnet";
  const UNREGISTERED = "nobodyregisteredthisvault00000001";
  const original = () => h.testnetConfig as Record<string, unknown>;

  it("treats a stranger's registered vault id exactly like an id nobody registered: the chain's answer, no network named", async () => {
    await asAccount(STRANGER, "testnet");
    // The guard's own answer for this stranger: nothing is confirmed.
    expect(await syncKeysAction(VAULT)).toMatchObject({ ok: false, status: 403 });

    h.chainCalls = [];
    const registered = await registerVaultAction(VAULT);
    const clientsForRegistered = [...h.chainCalls];
    h.chainCalls = [];
    const unregistered = await registerVaultAction(UNREGISTERED);
    // The chain answered (its owner is somebody else): the same answer for both, and it is the chain's.
    expect(registered).toEqual(unregistered);
    expect(registered).toEqual({
      ok: false,
      error: REGISTER_ERROR_TEXT.not_owner,
      code: "not_owner",
    });
    expect(JSON.stringify(registered)).not.toMatch(/mainnet|network/);
    // Both went to the request network's chain, the registered one included: nothing was answered before it.
    expect(clientsForRegistered).toEqual(h.chainCalls);
    expect(h.chainCalls).toContain("chain:testnet");
    expect(h.chainCalls).toContain("reader:testnet");
    expect(h.chainCalls.some((c) => c.endsWith(":mainnet"))).toBe(false);
    expect(await row()).toBe("mainnet");
  });

  it("still refuses a takeover by someone who holds the id on this chain but is not the tenant's owner", async () => {
    await asAccount(STRANGER, "testnet");
    const before = await members();
    // The testnet chain says this stranger owns the id there: the chain checks pass, and the database refuses.
    h.testnetConfig = { ...original(), owner: STRANGER, approvers: [STRANGER] };
    try {
      const r = await registerVaultAction(VAULT);
      expect(r).toMatchObject({ ok: false, code: "owner_mismatch" });
    } finally {
      h.testnetConfig = { ...original(), owner: OWNER, approvers: ["mallory.testnet"] };
    }
    expect(await row()).toBe("mainnet");
    expect(await members()).toEqual(before);
    expect(h.revalidated).toEqual([]);
  });

  it("gives a member the 409, whichever role they have", async () => {
    // The owner (above) and an approver of the mainnet tenant, both at the testnet address.
    for (const account of [OWNER, "cfo.near"]) {
      h.chainCalls = [];
      await asAccount(account, "testnet");
      expect(await registerVaultAction(VAULT), account).toEqual({
        ok: false,
        error: "This vault is on NEAR mainnet. Open it at the mainnet address.",
        code: "network_mismatch",
        status: 409,
      });
      expect(h.chainCalls, account).toEqual([]);
    }
    expect(await row()).toBe("mainnet");
  });

  it("limits Register per account and network, with its own bucket for each, and answers 429 before anything else", async () => {
    const [max] = LIMITS.registerPerAccount;
    await asAccount(STRANGER, "testnet");
    for (let i = 0; i < max; i++) {
      const r = await registerVaultAction(UNREGISTERED);
      expect((r as { status?: number }).status, `call ${i + 1}`).not.toBe(429);
    }
    h.chainCalls = [];
    const over = await registerVaultAction(UNREGISTERED);
    expect(over).toEqual({
      ok: false,
      error: "Too many attempts to register a vault just now. Try again in a few minutes.",
      status: 429,
    });
    expect(h.chainCalls).toEqual([]);
    expect(h.revalidated).toEqual([]);
    const buckets = await pg.query<{ bucket: string }>("select bucket from public.rate_limits");
    expect(buckets.rows.map((b) => b.bucket)).toEqual(["register:testnet:mallory.testnet"]);

    // Another account, and the same account on the other network, have their own bucket. (The mainnet chain is down in
    // this test, so that call ends in the chain read: what matters is that it got past the limiter.)
    const attempt = () => registerVaultAction(UNREGISTERED).catch(() => ({ threw: true }));
    await asAccount("other.testnet", "testnet");
    expect(await attempt()).not.toHaveProperty("status", 429);
    await asAccount(STRANGER, "mainnet");
    expect(await attempt()).not.toHaveProperty("status", 429);
    const after = await pg.query<{ bucket: string }>(
      "select bucket from public.rate_limits order by bucket",
    );
    expect(after.rows.map((b) => b.bucket)).toEqual([
      "register:mainnet:mallory.testnet",
      "register:testnet:mallory.testnet",
      "register:testnet:other.testnet",
    ]);
  });

  it("counts a member's attempt too, and takes the token before it looks anything up", async () => {
    await asAccount(OWNER, "testnet");
    await registerVaultAction(VAULT);
    const buckets = await pg.query<{ bucket: string; count: number }>(
      "select bucket, count from public.rate_limits",
    );
    expect(buckets.rows).toEqual([{ bucket: `register:testnet:${OWNER}`, count: 1 }]);
  });

  it("answers 401 without a session, and takes no token", async () => {
    h.jar.clear();
    expect(await registerVaultAction(VAULT)).toMatchObject({ ok: false, status: 401 });
    expect((await pg.query("select 1 from public.rate_limits")).rows).toEqual([]);
  });
});
