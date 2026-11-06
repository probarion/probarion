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
  /** Factory views by method name; a method left out throws (the factory cannot be read). */
  factory: {} as Record<string, unknown>,
  /** Every wallet button the page rendered, with its props. */
  buttons: [] as {
    label: string;
    expectedSigner?: string;
    confirm?: string;
    tx?: { receiverId: string; actions: { type: string; params: { methodName?: string } }[] };
    onResult?: (r: import("@/lib/near/outcome").TxResult) => void | Promise<void>;
    describe?: (
      r: import("@/lib/near/outcome").TxResult,
    ) => { headline?: string; detail?: string | null } | null | undefined;
  }[],
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
vi.mock("@/lib/near/server", async () => {
  const { NETWORKS: N } = await import("@probarion/core");
  return {
    getReader: () => h.reader,
    getRpc: () => ({
      viewAccount: () => h.account(),
      viewFunction: async (_contract: string, method: string) => {
        if (!(method in h.factory)) throw new Error("no factory in this test");
        return h.factory[method];
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
  TxButton: (p: (typeof h.buttons)[number]) => {
    h.buttons.push(p);
    return createElement("button", { type: "button" }, p.label);
  },
}));

import { KNOWN_VAULT_CODE_HASHES } from "@probarion/core";
import { refreshMembersAction, updateSettingsAction } from "@/app/console/[vault]/actions";
import VaultPage, { maxDuration as vaultMaxDuration } from "@/app/console/[vault]/page";
import { prepareCreateVaultAction, registerVaultAction } from "@/app/console/actions";
import ConsolePage, { maxDuration as homeMaxDuration } from "@/app/console/page";
import { cli } from "@/lib/proof/cli";
import { SIGNER_OUT_OF_NEAR, VAULT_LOW_SUGGESTION } from "./display";

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
const VAULT = "acme.vaults.probarion.near";
const OTHER = "other.vaults.probarion.near";
const CANARY = "canary.vaults.probarion.near";

let pg: PGlite;

beforeAll(async () => {
  pg = await freshDb();
  h.db = pgliteDb(pg);
  // acme.near owns VAULT, cfo.near approves it, mallory.near owns OTHER only.
  await seedTenant(pg, { vault: VAULT, owner: "acme.near", approvers: ["cfo.near"] });
  await seedTenant(pg, { vault: OTHER, owner: "mallory.near" });
  await seedTenant(pg, { vault: CANARY, owner: "probarion.near", kind: "canary" });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(() => {
  h.jar.clear();
  h.revalidated.length = 0;
  h.buttons.length = 0;
  h.factory = {};
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

describe("the Canary's settings (its ledger is private)", () => {
  const private_ = "The Canary's ledger is private: visitors' words never become public.";

  it("shows the owner of the Canary one line instead of the public-proof checkbox", async () => {
    await signInAs("probarion.near");
    const out = (await html(CANARY)).replaceAll("&#x27;", "'");
    expect(out).toContain("Save settings");
    expect(out).toContain(private_);
    expect(out).not.toContain('name="proof_public"');
    // an ordinary vault still gets the checkbox
    await signInAs("acme.near");
    const ordinary = (await html(VAULT)).replaceAll("&#x27;", "'");
    expect(ordinary).toContain('name="proof_public"');
    expect(ordinary).not.toContain(private_);
  });

  it("saves the Canary's other setting and never sends it a public proof, whatever the form says", async () => {
    await signInAs("probarion.near");
    const r = await updateSettingsAction(
      CANARY,
      null,
      form({ zero_retention: "on", proof_public: "on" }),
    );
    expect(r).toMatchObject({ ok: true });
    expect(await settings(CANARY)).toEqual({ zero_retention: true, proof_public: false });
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
    // The command a visitor can run today (the repository build until the npm package is out).
    expect(out).toContain(cli("--network mainnet vault create"));
    expect(out).not.toContain("Create vault in my wallet");
  });
});

const HOUR_NS = 3_600_000_000_000n;
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const heldSpend = (id: number, heldUntilNs: string) => ({
  id,
  mandate_id: 1,
  amount: "2500000",
  invoice_hash: "aa",
  ref: `inv-${id}`,
  decision_hash: "bb",
  agent_pk: "ed25519:x",
  destination: { type: "near" as const, account_id: "payee.near" },
  status: "held" as const,
  created_at_ns: "1",
  held_until_ns: heldUntilNs,
  memo: null,
});

describe("W-T8-R1 item 3: Freeze survives an unreadable config", () => {
  const configDown = () => {
    h.reader = fakeReader({
      getConfig: async () => {
        throw transportError();
      },
    });
  };

  it("the owner still gets Freeze (signed by the session account), never Unfreeze", async () => {
    configDown();
    await signInAs("acme.near");
    const out = await html(VAULT);
    expect(out).toContain("config could not be read");
    expect(out).toContain("Freeze vault");
    expect(out).not.toContain(">Unfreeze vault<");
    expect(h.buttons.map((b) => b.label)).not.toContain("Unfreeze vault");
    const freeze = h.buttons.find((b) => b.label === "Freeze vault");
    expect(freeze?.expectedSigner).toBe("acme.near");
    expect(freeze?.tx?.receiverId).toBe(VAULT);
    expect(freeze?.tx?.actions.map((a) => a.params.methodName)).toEqual(["freeze"]);
  });

  it("an approver gets no Freeze", async () => {
    configDown();
    await signInAs("cfo.near");
    const out = await html(VAULT);
    expect(out).toContain("config could not be read");
    expect(out).not.toContain("Freeze vault");
  });
});

describe("vault page: approvals, withdraw and tokens", () => {
  it("an approver gets Approve and Reject for a live hold", async () => {
    h.reader = fakeReader({
      getConfig: async () => vaultConfig({ owner: "acme.near", approvers: ["cfo.near"] }),
      listSpends: async () => [heldSpend(7, (nowNs() + HOUR_NS).toString())],
    });
    await signInAs("cfo.near");
    const out = await html(VAULT);
    expect(out).toContain("Held for approval (1)");
    expect(out).toContain(">Approve<");
    expect(out).toContain(">Reject<");
    expect(h.buttons.find((b) => b.label === "Approve")?.expectedSigner).toBe("cfo.near");
  });

  it("Approve is hidden while the vault is frozen; Reject stays", async () => {
    h.reader = fakeReader({
      getConfig: async () =>
        vaultConfig({ owner: "acme.near", approvers: ["cfo.near"], frozen: true }),
      listSpends: async () => [heldSpend(7, (nowNs() + HOUR_NS).toString())],
    });
    await signInAs("cfo.near");
    const out = await html(VAULT);
    expect(out).not.toContain(">Approve<");
    expect(out).toContain(">Reject<");
    expect(out).toContain("frozen");
  });

  it("the owner gets Withdraw for a positive USDC balance, none for zero", async () => {
    await signInAs("acme.near");
    expect(await html(VAULT)).toContain("Withdraw all 25 USDC to my wallet");
    h.reader = fakeReader({
      getConfig: async () => vaultConfig({ owner: "acme.near", approvers: ["cfo.near"] }),
      ftBalance: async () => "0",
      intentsBalance: async () => "0",
    });
    expect(await html(VAULT)).not.toContain("Withdraw all");
  });

  it("a vault whose token is not the network USDC shows raw units, decimals unknown", async () => {
    h.reader = fakeReader({
      getConfig: async () => vaultConfig({ usdc: "other-token.near" }),
      ftBalance: async () => "25000000",
      intentsBalance: async () => "0",
    });
    await signInAs("acme.near");
    const out = await html(VAULT);
    expect(out).toContain("25000000 base units of other-token.near (decimals unknown)");
    expect(out).not.toContain("25 USDC");
    const w = h.buttons.find((b) => b.label.startsWith("Withdraw all"));
    expect(w?.label).toContain("25000000 base units of other-token.near (decimals unknown)");
    expect(w?.confirm).toContain("decimals unknown");
  });
});

describe("W-T8-R1 item 2: out-of-NEAR wording on the page", () => {
  const lack = () => ({
    status: "failed" as const,
    txHash: "HashHashHashHashHashHashHashHashHashHashHash",
    code: "LackBalanceForState",
    error: "vault is out of free NEAR",
  });

  it("names the signer first; no vault top-up while the vault's NEAR reads fine", async () => {
    await signInAs("acme.near");
    await html(VAULT);
    const r = lack();
    const words = h.buttons.find((b) => b.label === "Freeze vault")?.describe?.(r);
    expect(words?.detail).toBe(SIGNER_OUT_OF_NEAR);
    expect(r.error).toBe("vault is out of free NEAR"); // the result itself is not changed
  });

  it("adds the vault top-up when the vault's NEAR reads low (below 0.1)", async () => {
    h.account = async () =>
      viewAccount({
        amount: (250_733n * 10n ** 19n + 9n * 10n ** 22n).toString(),
        storage_usage: 250_733,
      });
    await signInAs("acme.near");
    await html(VAULT);
    const r = lack();
    const words = h.buttons.find((b) => b.label === "Freeze vault")?.describe?.(r);
    expect(words?.detail).toBe(`${SIGNER_OUT_OF_NEAR} ${VAULT_LOW_SUGGESTION}`);
  });

  it("does not suggest a top-up when the vault's NEAR is unavailable", async () => {
    h.account = async () => {
      throw transportError();
    };
    await signInAs("acme.near");
    await html(VAULT);
    const r = lack();
    const words = h.buttons.find((b) => b.label === "Freeze vault")?.describe?.(r);
    expect(words?.detail).toBe(SIGNER_OUT_OF_NEAR);
  });
});

describe("server actions: the success paths", () => {
  const factoryConfig = (minDeposit: string) => ({
    owner: "probarion.near",
    usdc: NETWORKS.mainnet.usdc,
    intents: NETWORKS.mainnet.intents,
    allowed_assets: [],
    min_deposit: minDeposit,
    current_version: 1,
  });
  const versions = (mode: string) => [
    { index: 1, code_hash: KNOWN_VAULT_CODE_HASHES[0] ?? "", mode, notes: "", at_ns: "1" },
  ];
  const form = {
    name: "fresh",
    approvers: "cfo.near",
    dailyBackstopUsdc: "500",
    heldTtlHours: "72",
    depositNear: "1",
  };

  it("prepareCreateVaultAction builds the factory call for the session account, global mode", async () => {
    h.factory = {
      get_config: factoryConfig((10n ** 24n / 2n).toString()),
      versions: versions("global"),
    };
    await signInAs("acme.near");
    const r = await prepareCreateVaultAction(form);
    if (!("actions" in r)) throw new Error(`expected a tx: ${JSON.stringify(r)}`);
    expect(r.receiverId).toBe(NETWORKS.mainnet.factory);
    const call = r.actions[0];
    expect(call?.type).toBe("FunctionCall");
    if (call?.type !== "FunctionCall") return;
    expect(call.params.methodName).toBe("create_vault");
    expect(call.params.deposit).toBe("1000000000000000000000000");
  });

  it("prepareCreateVaultAction passes the factory's mode through: embedded needs the code storage", async () => {
    h.factory = {
      get_config: factoryConfig((10n ** 24n / 2n).toString()),
      versions: versions("embedded"),
    };
    await signInAs("acme.near");
    const r = await prepareCreateVaultAction(form);
    expect(r).toMatchObject({ error: expect.stringMatching(/embedded mode: 3\.23352 NEAR/) });
    const ok = await prepareCreateVaultAction({ ...form, depositNear: "3.23352" });
    expect("actions" in ok).toBe(true);
  });

  it("prepareCreateVaultAction never trusts extra fields from the browser", async () => {
    h.factory = {
      get_config: factoryConfig((10n ** 24n / 2n).toString()),
      versions: versions("global"),
    };
    await signInAs("acme.near");
    const r = await prepareCreateVaultAction({
      ...form,
      factory: "vaults.evil.near",
      minDeposit: "0",
    } as typeof form);
    if (!("actions" in r)) throw new Error("expected a tx");
    expect(r.receiverId).toBe(NETWORKS.mainnet.factory);
  });

  it("registerVaultAction registers a known build for its on-chain owner", async () => {
    h.reader = fakeReader({
      getConfig: async () =>
        vaultConfig({ owner: "acme.near", approvers: ["coo.near"], factory: null }),
    });
    h.account = async () => viewAccount({ code_hash: KNOWN_VAULT_CODE_HASHES[0] ?? "" });
    await signInAs("acme.near");
    expect(await registerVaultAction(" fresh.near ")).toEqual({ ok: true, vaultId: "fresh.near" });
    const m = await pgliteDb(pg).rpc<{ role: string } | null>("member_role", {
      vault_id: "fresh.near",
      account: "coo.near",
    });
    expect(m?.role).toBe("approver");
    expect(h.revalidated).toEqual(["/console"]);
  });

  it("registerVaultAction says why it refused, with the code", async () => {
    h.reader = fakeReader({ getConfig: async () => vaultConfig({ owner: "someone.near" }) });
    h.account = async () => viewAccount({ code_hash: KNOWN_VAULT_CODE_HASHES[0] ?? "" });
    await signInAs("acme.near");
    expect(await registerVaultAction("taken.near")).toMatchObject({ ok: false, code: "not_owner" });
  });

  it("refreshMembersAction re-reads the approvers from the chain for the owner", async () => {
    h.reader = fakeReader({
      getConfig: async () =>
        vaultConfig({ owner: "acme.near", approvers: ["cfo.near", "coo.near"] }),
    });
    h.account = async () => viewAccount({ code_hash: KNOWN_VAULT_CODE_HASHES[0] ?? "" });
    await signInAs("acme.near");
    expect(await refreshMembersAction(VAULT, null)).toMatchObject({ ok: true });
    const m = await pgliteDb(pg).rpc<{ role: string } | null>("member_role", {
      vault_id: VAULT,
      account: "coo.near",
    });
    expect(m?.role).toBe("approver");
    expect(h.revalidated).toEqual([`/console/${VAULT}`]);
  });
});

describe("pages that host a wallet button wait for FINAL", () => {
  it("export maxDuration = 60", () => {
    expect(homeMaxDuration).toBe(60);
    expect(vaultMaxDuration).toBe(60);
  });
});

describe("console home: create pins the signer", () => {
  it("passes the session account to the create panel as the expected signer", async () => {
    h.factory = {
      get_config: {
        owner: "probarion.near",
        usdc: "u.near",
        intents: "i.near",
        allowed_assets: [],
        min_deposit: "500000000000000000000000",
        current_version: 1,
      },
      versions: [{ index: 1, code_hash: "h", mode: "global", notes: "", at_ns: "1" }],
    };
    await signInAs("acme.near");
    renderToStaticMarkup((await ConsolePage()) as ReactElement);
    expect(h.buttons.find((b) => b.label === "Create vault in my wallet")?.expectedSigner).toBe(
      "acme.near",
    );
  });
});
