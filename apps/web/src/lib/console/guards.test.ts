import type { PGlite } from "@electric-sql/pglite";
import { NETWORKS } from "@probarion/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import type { VaultReader } from "@/lib/near/reader";
import { freshDb, seedTenant } from "../../../test/db/harness";
import { pgliteDb } from "../../../test/db/pglite-db";
import { fakeReader, vaultConfig, viewAccount } from "../../../test/fixtures/reader";
import { contractError, transportError } from "../../../test/fixtures/rpc";

// Every console page, server action and route checks the signed session and the membership itself
// (the proxy only looks for a cookie). Pages answer a non-member with a 404, actions with a 403.

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  db: null as unknown as Db,
  reader: null as unknown as VaultReader,
  account: null as unknown as () => Promise<unknown>,
  revalidated: [] as string[],
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
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    NEAR_NETWORK: "mainnet",
    PROBARION_FACTORY_ID: NETWORKS.mainnet.factory,
    CANARY_VAULT_ID: null,
    TEAM_VAULT_IDS: [],
  }),
}));
vi.mock("@/lib/near/server", async () => {
  const { NETWORKS: N } = await import("@probarion/core");
  return {
    getReader: () => h.reader,
    getRpc: () => ({
      viewAccount: () => h.account(),
      viewFunction: async () => {
        throw new Error("no factory in this test");
      },
    }),
    chainConsts: () => N.mainnet,
  };
});
// Client components call useRouter, which needs the app router; notFound and redirect stay real.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
// The wallet button needs the browser wallet; here it only shows what it would sign.
vi.mock("@/components/wallet/TxButton", () => ({
  TxButton: (p: { label: string }) => createElement("button", { type: "button" }, p.label),
}));

import { refreshMembersAction, updateSettingsAction } from "@/app/console/[vault]/actions";
import VaultPage from "@/app/console/[vault]/page";
import { prepareCreateVaultAction, registerVaultAction } from "@/app/console/actions";
import ConsolePage from "@/app/console/page";

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
const VAULT = "acme.vaults.probarion.near";
const OTHER = "other.vaults.probarion.near";

let pg: PGlite;

beforeAll(async () => {
  pg = await freshDb();
  h.db = pgliteDb(pg);
  // acme.near owns VAULT, cfo.near approves it, mallory.near owns OTHER only.
  await seedTenant(pg, { vault: VAULT, owner: "acme.near", approvers: ["cfo.near"] });
  await seedTenant(pg, { vault: OTHER, owner: "mallory.near" });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(() => {
  h.jar.clear();
  h.revalidated.length = 0;
  h.reader = fakeReader({
    getConfig: async () => vaultConfig({ owner: "acme.near", approvers: ["cfo.near"] }),
    ftBalance: async () => "25000000",
    intentsBalance: async () => "0",
  });
  h.account = async () =>
    viewAccount({ amount: "3000000000000000000000000", storage_usage: 250_733 });
});

async function signInAs(account: string) {
  h.jar.set(
    SESSION_COOKIE,
    await createSessionToken(await deriveSubkey(MASTER, "session"), account),
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

const page = (vault: string) => VaultPage({ params: Promise.resolve({ vault }) });
const html = async (vault: string) => renderToStaticMarkup((await page(vault)) as ReactElement);
const form = (fields: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const settings = async (vault: string) =>
  (
    await pg.query<{ zero_retention: boolean; proof_public: boolean }>(
      "select zero_retention, proof_public from public.tenants where vault_id = $1",
      [vault],
    )
  ).rows[0];

describe("vault page guard (requireMember)", () => {
  it("sends a signed-out visitor to /login", async () => {
    expect(await digest(page(VAULT))).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login/);
  });

  it("is a 404 for a signed-in non-member, and for a vault that does not exist", async () => {
    await signInAs("mallory.near");
    expect(await digest(page(VAULT))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(await digest(page("nope.vaults.probarion.near"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(await digest(page("Not A Vault"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("renders for the owner and for an approver", async () => {
    await signInAs("acme.near");
    const owner = await html(VAULT);
    expect(owner).toContain("25 USDC");
    expect(owner).toContain("Freeze vault");
    expect(owner).toContain("Save settings");
    await signInAs("cfo.near");
    const approver = await html(VAULT);
    expect(approver).toContain("25 USDC");
    expect(approver).not.toContain("Freeze vault"); // freeze is the owner's
    expect(approver).not.toContain("Save settings"); // settings are the owner's
  });
});

describe("vault page: honest balances", () => {
  it("shows unavailable, never 0, when a balance view fails", async () => {
    await signInAs("acme.near");
    h.reader = fakeReader({
      getConfig: async () => vaultConfig(),
      ftBalance: async () => {
        throw contractError("CONTRACT_EXECUTION_ERROR");
      },
      intentsBalance: async () => {
        throw transportError();
      },
    });
    h.account = async () => {
      throw transportError();
    };
    const out = await html(VAULT);
    expect(out.match(/unavailable/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(out).not.toMatch(/>0 USDC|0 NEAR free/);
    expect(out).not.toContain("Withdraw all"); // no withdraw of an amount nobody read
    expect(out).toContain("Send NEAR"); // the top-up does not depend on a balance
  });

  it("shows the held queue as unavailable, not as empty, when the spend list fails", async () => {
    await signInAs("acme.near");
    h.reader = fakeReader({
      getConfig: async () => vaultConfig(),
      listSpends: async () => {
        throw transportError();
      },
    });
    const out = await html(VAULT);
    expect(out).not.toContain("Nothing waiting");
    expect(out).toContain("Payments may be waiting");
  });

  it("says so when the config cannot be read, and shows no state at all", async () => {
    await signInAs("acme.near");
    h.reader = fakeReader({
      getConfig: async () => {
        throw transportError();
      },
    });
    const out = await html(VAULT);
    expect(out).toContain("config could not be read");
    expect(out).not.toContain("USDC on NEAR");
    expect(out).toContain("Save settings"); // settings live in the database, not on chain
  });

  it("amber runway below 0.1 NEAR free", async () => {
    await signInAs("acme.near");
    h.account = async () =>
      viewAccount({
        amount: (250_733n * 10n ** 19n + 9n * 10n ** 22n).toString(),
        storage_usage: 250_733,
      });
    const out = await html(VAULT);
    expect(out).toContain("0.09 NEAR free");
    expect(out).toContain("bg-amber-100");
  });
});

describe("server action guards (memberForApi: 403)", () => {
  it("settings: 401 signed out, 403 for a non-member and for an approver, ok for the owner", async () => {
    expect(await updateSettingsAction(VAULT, null, form({ proof_public: "on" }))).toMatchObject({
      ok: false,
      status: 401,
    });
    await signInAs("mallory.near");
    expect(await updateSettingsAction(VAULT, null, form({ proof_public: "on" }))).toMatchObject({
      ok: false,
      status: 403,
    });
    await signInAs("cfo.near");
    expect(await updateSettingsAction(VAULT, null, form({ proof_public: "on" }))).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await settings(VAULT)).toEqual({ zero_retention: false, proof_public: false });
    expect(h.revalidated).toEqual([]);

    await signInAs("acme.near");
    expect(await updateSettingsAction(VAULT, null, form({ proof_public: "on" }))).toMatchObject({
      ok: true,
    });
    expect(await settings(VAULT)).toEqual({ zero_retention: false, proof_public: true });
    expect(h.revalidated).toEqual([`/console/${VAULT}`]);
  });

  it("settings: the owner of one vault cannot change another (the vault id is only a lookup key)", async () => {
    await signInAs("acme.near");
    expect(await updateSettingsAction(OTHER, null, form({ zero_retention: "on" }))).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await settings(OTHER)).toEqual({ zero_retention: false, proof_public: false });
  });

  it("re-sync: 403 for a non-member and an approver", async () => {
    await signInAs("mallory.near");
    expect(await refreshMembersAction(VAULT, null)).toMatchObject({ ok: false, status: 403 });
    await signInAs("cfo.near");
    expect(await refreshMembersAction(VAULT, null)).toMatchObject({ ok: false, status: 403 });
  });

  it("create and register need a session (401), before anything is read", async () => {
    let reads = 0;
    h.reader = fakeReader({
      getConfig: async () => {
        reads += 1;
        return vaultConfig();
      },
    });
    expect(
      await prepareCreateVaultAction({
        name: "acme",
        approvers: "cfo.near",
        dailyBackstopUsdc: "500",
        heldTtlHours: "72",
        depositNear: "1",
      }),
    ).toMatchObject({ status: 401 });
    expect(await registerVaultAction(VAULT)).toMatchObject({ ok: false, status: 401 });
    expect(reads).toBe(0);
  });

  it("create says the factory cannot be read rather than preparing a guess", async () => {
    await signInAs("acme.near");
    const r = await prepareCreateVaultAction({
      name: "acme",
      approvers: "cfo.near",
      dailyBackstopUsdc: "500",
      heldTtlHours: "72",
      depositNear: "1",
    });
    expect(r).toMatchObject({ error: expect.stringMatching(/factory cannot be read/) });
  });
});

describe("console home guard (requireSession)", () => {
  it("sends a signed-out visitor to /login", async () => {
    expect(await digest(ConsolePage())).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login/);
  });

  it("offers the CLI when the factory cannot be read", async () => {
    await signInAs("acme.near");
    const out = renderToStaticMarkup((await ConsolePage()) as ReactElement);
    expect(out).toContain(VAULT);
    expect(out).toContain("npx probarion vault create");
    expect(out).not.toContain("Create vault in my wallet");
  });
});
