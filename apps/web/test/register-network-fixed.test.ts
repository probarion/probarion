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
beforeEach(() => {
  h.jar.clear();
  h.chainCalls = [];
  h.revalidated = [];
});

const asTestnet = async () => {
  h.host = TESTNET_HOST;
  h.jar.set(
    SESSION_COOKIE,
    await createSessionToken(await deriveSubkey(MASTER, "session"), OWNER, "testnet"),
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
