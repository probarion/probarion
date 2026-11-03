import type { PGlite } from "@electric-sql/pglite";
import { type AgentView, type MandateView, NETWORKS } from "@probarion/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import type { VaultReader } from "@/lib/near/reader";
import { freshDb, seedTenant } from "../../../test/db/harness";
import { pgliteDb } from "../../../test/db/pglite-db";
import { fakeReader, vaultConfig } from "../../../test/fixtures/reader";
import { contractError, transportError } from "../../../test/fixtures/rpc";

// The mandates page and the create action: who may see and do what (requireMember, memberForApi), that
// the server checks the form again against the chain, and that nothing read from the chain is shown as a
// zero or an empty list when it could not be read.

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  db: null as unknown as Db,
  reader: null as unknown as VaultReader,
  /** Every wallet button the page rendered, with its props. */
  buttons: [] as {
    label: string;
    expectedSigner?: string;
    lockKey?: string;
    confirm?: string;
    tx?: {
      receiverId: string;
      actions: { params: { methodName: string; args: Record<string, unknown>; deposit: string } }[];
    };
  }[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name) } : undefined),
  }),
  headers: async () => ({ get: () => null }),
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
  getEnv: () => ({ NEAR_NETWORK: "mainnet" }),
}));
vi.mock("@/lib/near/server", async () => {
  const { NETWORKS: N } = await import("@probarion/core");
  return { getReader: () => h.reader, getRpc: () => ({}), chainConsts: () => N.mainnet };
});
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

import { prepareMandateAction } from "@/app/console/[vault]/mandates/actions";
import MandatesPage, { maxDuration } from "@/app/console/[vault]/mandates/page";
import { OUT_OF_NEAR } from "@/lib/console/out-of-near";
import { MANDATE_STORAGE_DEPOSIT, TGAS, type WalletTx } from "@/lib/near/tx";
import type { MandateForm } from "./mandates";

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
const VAULT = "acme.vaults.probarion.near";
const OTHER = "other.vaults.probarion.near";
const BASE_ASSET = NETWORKS.mainnet.allowedAssets.base;
const AGENT = `ed25519:${"3".repeat(44)}`;
const REMOVED_AGENT = `ed25519:${"4".repeat(44)}`;
const CHECKSUMMED = "0x52908400098527886E0F7030069857D2E4169EE7";
const DAY = 24 * 3600_000;

const nsIn = (ms: number) => String(BigInt(Date.now() + ms) * 1_000_000n);
const dayIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let pg: PGlite;

beforeAll(async () => {
  pg = await freshDb();
  h.db = pgliteDb(pg);
  // acme.near owns VAULT, cfo.near approves it, view.near only views it; mallory.near owns OTHER only.
  const tenant = await seedTenant(pg, {
    vault: VAULT,
    owner: "acme.near",
    approvers: ["cfo.near"],
  });
  await pg.query(
    "insert into public.tenant_members (tenant_id, account_id, role) values ($1, 'view.near', 'viewer')",
    [tenant],
  );
  await seedTenant(pg, { vault: OTHER, owner: "mallory.near" });
});
afterAll(async () => {
  await pg.close();
});

const agent = (public_key = AGENT): AgentView => ({
  public_key,
  label: "invoice bot",
  added_at_ns: "1",
});
function mandate(over: Partial<MandateView> = {}): MandateView {
  return {
    id: 1,
    payee: { type: "near", account_id: "designer.near" },
    purpose_hash: "ab".repeat(32),
    max_per_payment: "100000000",
    max_total: "1000000000",
    spent: "0",
    reserved: "0",
    max_uses: 10,
    uses: 0,
    expires_at_ns: nsIn(30 * DAY),
    approval_above: "100000000",
    agent_pk: AGENT,
    label: "Acme Design retainer",
    status: "active",
    created_at_ns: nsIn(-DAY),
    ...over,
  };
}
const reads = { n: 0 };
function chain(
  over: {
    mandates?: MandateView[] | "throw";
    agents?: AgentView[] | "throw";
    config?: Parameters<typeof vaultConfig>[0] | "throw";
    usdc?: string | "throw";
    intents?: string | "throw";
  } = {},
) {
  const val = <T>(v: T | "throw" | undefined, dflt: T, err: () => Error = transportError): T => {
    reads.n += 1;
    if (v === "throw") throw err();
    return v === undefined ? dflt : v;
  };
  h.reader = fakeReader({
    getConfig: async () => {
      reads.n += 1;
      if (over.config === "throw") throw transportError();
      return vaultConfig(over.config);
    },
    listAgents: async () => val(over.agents, [agent()]),
    listMandates: async () => val(over.mandates, [mandate()]),
    ftBalance: async () =>
      val(over.usdc, "500000000", () => contractError("CONTRACT_EXECUTION_ERROR")),
    intentsBalance: async () => val(over.intents, "500000000"),
  });
}

beforeEach(() => {
  h.jar.clear();
  h.buttons.length = 0;
  reads.n = 0;
  chain();
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
const page = (vault: string) => MandatesPage({ params: Promise.resolve({ vault }) });
const html = async (vault = VAULT) => renderToStaticMarkup((await page(vault)) as ReactElement);

/** The one contract call a prepared transaction holds. */
function createCall(tx: WalletTx) {
  const a = tx.actions[0];
  if (tx.actions.length !== 1 || !a || a.type !== "FunctionCall") {
    throw new Error("expected one contract call");
  }
  return a.params;
}

const goodForm = (over: Partial<MandateForm> = {}): MandateForm => ({
  payeeKind: "near",
  payee: "designer.near",
  purposeHash: "ab".repeat(32),
  maxPerPaymentUsdc: "100",
  maxTotalUsdc: "1000",
  maxUses: "10",
  expiresOn: dayIn(30),
  approvalAboveUsdc: "100",
  agentPk: AGENT,
  label: "Acme Design retainer",
  ...over,
});

describe("mandates page guard (requireMember)", () => {
  it("exports maxDuration 60: the wallet buttons confirm on chain", () => {
    expect(maxDuration).toBe(60);
  });

  it("sends a signed-out visitor to /login", async () => {
    expect(await digest(page(VAULT))).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login/);
    expect(reads.n).toBe(0);
  });

  it("is a 404 for a non-member, for a vault that does not exist, and for text that is no vault id", async () => {
    await signInAs("mallory.near");
    expect(await digest(page(VAULT))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(await digest(page("nope.vaults.probarion.near"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(await digest(page("Not A Vault"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(reads.n).toBe(0); // nothing is read for a stranger
  });

  it("shows the list to an approver and a viewer, with no form and no Revoke", async () => {
    for (const who of ["cfo.near", "view.near"]) {
      h.buttons.length = 0;
      await signInAs(who);
      const out = await html();
      expect(out, who).toContain("Acme Design retainer");
      expect(out, who).toContain("Only the vault&#x27;s owner can create or revoke mandates");
      expect(out, who).not.toContain("New mandate");
      expect(out, who).not.toContain("Sign mandate in my wallet");
      expect(h.buttons, who).toEqual([]);
    }
  });

  it("shows the owner the form and a Revoke for the active mandate, signed by the owner", async () => {
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("New mandate");
    expect(out).toContain("Sign mandate in my wallet");
    expect(h.buttons).toHaveLength(1);
    const revoke = h.buttons[0];
    expect(revoke?.label).toBe("Revoke");
    expect(revoke?.expectedSigner).toBe("acme.near");
    expect(revoke?.lockKey).toContain(`revoke-mandate:${VAULT}:1`);
    expect(revoke?.confirm).toContain("Revoke mandate #1");
    expect(revoke?.confirm).toContain("cannot be undone");
    expect(revoke?.tx?.receiverId).toBe(VAULT);
    expect(revoke?.tx?.actions[0]?.params).toMatchObject({
      methodName: "revoke_mandate",
      args: { mandate_id: 1 },
      deposit: "1",
    });
  });

  it("gives each mandate its own lock", async () => {
    chain({ mandates: [mandate({ id: 1 }), mandate({ id: 2 })] });
    await signInAs("acme.near");
    await html();
    const keys = h.buttons.filter((b) => b.label === "Revoke").map((b) => b.lockKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("mandates page: honest status", () => {
  it("shows expired and revoked as such, and offers Revoke only where it can still act", async () => {
    chain({
      mandates: [
        mandate({ id: 1, label: "live" }),
        mandate({ id: 2, label: "stale", expires_at_ns: nsIn(-DAY) }), // the chain still says active
        mandate({ id: 3, label: "gone", status: "revoked" }),
        mandate({ id: 4, label: "full", status: "exhausted", uses: 10 }),
        mandate({ id: 5, label: "old gone", status: "revoked", expires_at_ns: nsIn(-DAY) }),
      ],
    });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain(">expired<");
    expect(out).toContain(">revoked<");
    expect(out).toContain(">exhausted<");
    expect(out).toContain(">active<");
    const revoked = h.buttons
      .filter((b) => b.label === "Revoke")
      .map((b) => b.tx?.actions[0]?.params.args.mandate_id);
    expect(revoked.sort()).toEqual([1, 4]);
  });

  it("takes remaining from the chain's own figures", async () => {
    chain({ mandates: [mandate({ spent: "300000000", reserved: "200000000" })] });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("<strong>500 USDC</strong>");
    expect(out).toContain("of 1000 USDC");
    expect(out).toContain("paid 300 USDC");
    expect(out).toContain("reserved 200 USDC");
  });

  it("shows unreadable figures as unreadable, and does not crash", async () => {
    chain({
      mandates: [
        mandate({ spent: "x", expires_at_ns: "soon", max_per_payment: "" }),
        mandate({ id: 2, status: "frozen" as MandateView["status"] }),
      ],
    });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("unreadable");
    expect(
      h.buttons
        .filter((b) => b.label === "Revoke")
        .map((b) => b.tx?.actions[0]?.params.args.mandate_id),
    ).toEqual([]);
  });

  it("shows the list as unavailable, never as empty, when it cannot be read", async () => {
    chain({ mandates: "throw" });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("mandate list is unavailable");
    expect(out).not.toContain("No mandates yet");
    expect(out).not.toContain("Mandates (0)");
    expect(h.buttons).toEqual([]); // no Revoke without a list
  });

  it("says so when there are none", async () => {
    chain({ mandates: [] });
    await signInAs("acme.near");
    expect(await html()).toContain("No mandates yet");
  });
});

describe("mandates page: chain text is shown safely", () => {
  it("escapes a label and replaces direction marks, so the chain cannot inject markup", async () => {
    chain({
      mandates: [
        mandate({ label: '<img src=x onerror="alert(1)">' }),
        mandate({ id: 2, label: "Acme ‮gnisid" }),
      ],
    });
    await signInAs("acme.near");
    const out = await html();
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("‮");
  });

  it("links a valid payee account to the fixed explorer base, and never links text that is not an account id", async () => {
    chain({
      mandates: [
        mandate({ id: 1 }),
        mandate({ id: 2, payee: { type: "near", account_id: "javascript:alert(1)//x" } }),
        mandate({ id: 3, payee: { type: "near", account_id: "../../evil" } }),
      ],
    });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain('href="https://nearblocks.io/address/designer.near"');
    // shown as plain text, never as a link target
    expect(out).toContain("javascript:alert(1)//x");
    expect(out).not.toMatch(/href="[^"]*(javascript|evil)/);
    expect(out.match(/href="https:\/\/nearblocks\.io\/address\//g)).toHaveLength(1);
    expect(out.match(/>unreadable</g)?.length).toBe(2);
  });

  it("shows a Base payee with its chain, as text", async () => {
    chain({
      mandates: [
        mandate({
          payee: { type: "intents", chain: "base", address: CHECKSUMMED, asset: BASE_ASSET },
        }),
      ],
    });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain(CHECKSUMMED);
    expect(out).toContain("Base ");
  });
});

describe("mandates page: what the form needs", () => {
  it("offers no form when the vault's config cannot be read, and says why", async () => {
    chain({ config: "throw" });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("config is unavailable");
    expect(out).not.toContain("Sign mandate in my wallet");
    expect(out).toContain("base units"); // amounts are not claimed to be USDC
    expect(out).toContain("Acme Design retainer"); // the list still shows
  });

  it("offers no form for a vault whose token is not the network USDC", async () => {
    chain({ config: { usdc: "other-token.near" } });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("not this network&#x27;s USDC");
    expect(out).not.toContain("Sign mandate in my wallet");
    expect(out).toContain("base units (decimals unknown)");
  });

  it("offers no form when the chain's owner is another account than the signed-in one", async () => {
    chain({ config: { owner: "someone-else.near" } });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("someone-else.near");
    expect(out).not.toContain("Sign mandate in my wallet");
  });

  it("points to the Keys tab when the vault has no agent key, and says unavailable when it cannot read them", async () => {
    chain({ agents: [] });
    await signInAs("acme.near");
    let out = await html();
    expect(out).toContain(`/console/${VAULT}/keys`);
    expect(out).not.toContain("Sign mandate in my wallet");
    chain({ agents: "throw" });
    out = await html();
    expect(out).toContain("agent keys are unavailable");
    expect(out).not.toContain("Sign mandate in my wallet");
  });

  it("explains the purpose hash (R15) and the deposit, and names no number for the deposit that the builder does not own", async () => {
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("sha256");
    expect(out).toContain("attach it to the invoices it covers");
    expect(out).toContain("hashes to this value");
    // the deposit text is built from MANDATE_STORAGE_DEPOSIT (0.05 NEAR), only once there is something to review
    expect(out).not.toContain("You are about to create");
  });
});

describe("R3: the float warning on the form", () => {
  it("warns, without blocking, when the cap is above the USDC the vault holds", async () => {
    chain({ usdc: "25000000" });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("is more than the USDC on NEAR the vault holds now (25 USDC)");
    expect(out).toContain("Sign mandate in my wallet");
  });

  it("warns when the per-payment cap is above the vault's daily backstop", async () => {
    chain({ config: { daily_backstop: "50000000" } }); // 50 USDC a day, against the form's 100 USDC cap
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("daily backstop (50 USDC)");
    expect(out).toContain("OverDailyBackstop");
  });

  it("says nothing about the backstop when the cap is within it", async () => {
    await signInAs("acme.near");
    expect(await html()).not.toContain("OverDailyBackstop");
  });

  it("is quiet when the vault holds enough", async () => {
    chain({ usdc: "100000000" });
    await signInAs("acme.near");
    const out = await html();
    expect(out).not.toContain("the vault holds now");
    expect(out).not.toContain("Balance unavailable");
  });

  it("says 'balance unavailable' and never 0 when the balance cannot be read", async () => {
    chain({ usdc: "throw" });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("Balance unavailable");
    expect(out).not.toMatch(/\(0 USDC\)/);
  });
});

describe("prepareMandateAction: owner-only, and the server checks the form again", () => {
  it("401 without a session, before any chain read", async () => {
    expect(await prepareMandateAction(VAULT, goodForm())).toMatchObject({ status: 401 });
    expect(reads.n).toBe(0);
  });

  it("403 for a non-member, an approver and a viewer, before any chain read", async () => {
    for (const who of ["mallory.near", "cfo.near", "view.near"]) {
      await signInAs(who);
      expect(await prepareMandateAction(VAULT, goodForm()), who).toMatchObject({ status: 403 });
    }
    expect(reads.n).toBe(0);
  });

  it("403 for the owner of another vault: the vault argument is only a lookup key", async () => {
    await signInAs("mallory.near");
    expect(await prepareMandateAction(VAULT, goodForm())).toMatchObject({ status: 403 });
    // and the owner of this vault cannot act on the other one
    await signInAs("acme.near");
    expect(await prepareMandateAction(OTHER, goodForm())).toMatchObject({ status: 403 });
    expect(reads.n).toBe(0);
  });

  it("builds the create_mandate transaction for the owner: the vault from the membership, the deposit from the builder", async () => {
    await signInAs("acme.near");
    const tx = await prepareMandateAction(VAULT, goodForm());
    if ("error" in tx) throw new Error(tx.error);
    expect(tx.receiverId).toBe(VAULT);
    const call = createCall(tx);
    expect(call.methodName).toBe("create_mandate");
    expect(call.deposit).toBe(MANDATE_STORAGE_DEPOSIT);
    expect(call.gas).toBe(String(100n * TGAS));
    expect(call.args).toEqual({
      input: {
        payee: { type: "near", account_id: "designer.near" },
        purpose_hash: "ab".repeat(32),
        max_per_payment: "100000000",
        max_total: "1000000000",
        max_uses: 10,
        expires_at_ns: expect.stringMatching(/^[1-9][0-9]*$/),
        approval_above: "100000000",
        agent_pk: AGENT,
        label: "Acme Design retainer",
      },
    });
  });

  it("builds a Base payee with the EIP-55 address and the network's Base asset", async () => {
    await signInAs("acme.near");
    const tx = await prepareMandateAction(
      VAULT,
      goodForm({ payeeKind: "base", payee: CHECKSUMMED.toLowerCase() }),
    );
    if ("error" in tx) throw new Error(tx.error);
    const input = createCall(tx).args.input as { payee: unknown };
    expect(input.payee).toEqual({
      type: "intents",
      chain: "base",
      address: CHECKSUMMED,
      asset: BASE_ASSET,
    });
  });

  it("drops everything in the form that is not one of its ten fields (a vault, a tenant, a deposit)", async () => {
    await signInAs("acme.near");
    const forged = {
      ...goodForm(),
      vault: OTHER,
      tenant_id: "x",
      deposit: "1",
      owner: "mallory.near",
    };
    const tx = await prepareMandateAction(VAULT, forged as MandateForm);
    if ("error" in tx) throw new Error(tx.error);
    expect(tx.receiverId).toBe(VAULT);
    expect(tx.actions[0]?.params.deposit).toBe(MANDATE_STORAGE_DEPOSIT);
    expect(JSON.stringify(tx)).not.toContain("mallory");
  });

  it("refuses a forged form the browser's own check would have stopped", async () => {
    await signInAs("acme.near");
    const forged: Partial<MandateForm>[] = [
      { payee: "Designer.near" },
      { payee: VAULT },
      { payeeKind: "base", payee: "0x52908400098527886e0F7030069857D2E4169EE7" },
      { payeeKind: "base", payee: `0x${"0".repeat(40)}` },
      { maxPerPaymentUsdc: "2000" },
      { maxTotalUsdc: "0" },
      { maxPerPaymentUsdc: "1e3" },
      { maxUses: "0" },
      { maxUses: "10001" },
      { expiresOn: dayIn(-1) },
      { expiresOn: dayIn(400) },
      { purposeHash: "xyz" },
      { label: "x".repeat(65) },
      { agentPk: REMOVED_AGENT },
      { payeeKind: "evm" as MandateForm["payeeKind"] },
    ];
    for (const f of forged) {
      const r = await prepareMandateAction(VAULT, goodForm(f));
      expect(r, JSON.stringify(f)).toHaveProperty("error");
    }
  });

  it("checks against the chain as it is now: a key removed after the page loaded is refused", async () => {
    chain({ agents: [agent(REMOVED_AGENT)] });
    await signInAs("acme.near");
    const r = await prepareMandateAction(VAULT, goodForm());
    expect(r).toMatchObject({ error: expect.stringContaining("Agent key") });
  });

  it("refuses a Base payee when the vault no longer allows the Base asset", async () => {
    chain({ config: { allowed_assets: [] } });
    await signInAs("acme.near");
    const r = await prepareMandateAction(
      VAULT,
      goodForm({ payeeKind: "base", payee: CHECKSUMMED }),
    );
    expect(r).toMatchObject({ error: expect.stringMatching(/allow/) });
  });

  it("answers an error, never a throw, for a form that is not an object or has fields of other types", async () => {
    await signInAs("acme.near");
    for (const bad of [null, undefined, 5, "x", [], { payee: 5, label: {} }]) {
      expect(await prepareMandateAction(VAULT, bad as unknown as MandateForm)).toHaveProperty(
        "error",
      );
    }
  });

  it("answers an error, not a throw or a guess, when the vault cannot be read", async () => {
    chain({ config: "throw" });
    await signInAs("acme.near");
    expect(await prepareMandateAction(VAULT, goodForm())).toMatchObject({
      error: expect.stringContaining("nothing was signed"),
    });
    chain({ agents: "throw" });
    expect(await prepareMandateAction(VAULT, goodForm())).toMatchObject({
      error: expect.stringContaining("nothing was signed"),
    });
  });

  it("refuses when the chain's owner is not the signed-in account, even though the membership row says owner", async () => {
    chain({ config: { owner: "someone-else.near" } });
    await signInAs("acme.near");
    expect(await prepareMandateAction(VAULT, goodForm())).toMatchObject({ status: 403 });
  });

  it("refuses a vault whose token is not the network USDC: its decimals are unknown", async () => {
    chain({ config: { usdc: "other-token.near" } });
    await signInAs("acme.near");
    expect(await prepareMandateAction(VAULT, goodForm())).toMatchObject({
      error: expect.stringContaining("not this network's USDC"),
    });
  });

  it("refuses a config that names the right owner and token but has no allowed_assets, rather than guessing", async () => {
    h.reader = fakeReader({
      getConfig: async () =>
        ({ ...vaultConfig(), allowed_assets: undefined }) as unknown as ReturnType<
          typeof vaultConfig
        >,
      listAgents: async () => [agent()],
    });
    await signInAs("acme.near");
    expect(await prepareMandateAction(VAULT, goodForm())).toHaveProperty("error");
  });

  it("refuses an agent answer that is not a list at all, without throwing", async () => {
    for (const bad of [{}, "keys", 5, null]) {
      h.reader = fakeReader({
        getConfig: async () => vaultConfig(),
        listAgents: async () => bad as unknown as AgentView[],
      });
      await signInAs("acme.near");
      expect(await prepareMandateAction(VAULT, goodForm()), JSON.stringify(bad)).toHaveProperty(
        "error",
      );
    }
  });

  it("refuses an agent list that is not a list of keys", async () => {
    h.reader = fakeReader({
      getConfig: async () => vaultConfig(),
      listAgents: async () => [{ label: "x" }] as unknown as AgentView[],
    });
    await signInAs("acme.near");
    expect(await prepareMandateAction(VAULT, goodForm())).toHaveProperty("error");
  });

  it("refuses an answer from the chain that has not the shape of a config", async () => {
    h.reader = fakeReader({
      getConfig: async () => ({ owner: "acme.near" }) as never,
      listAgents: async () => [agent()],
    });
    await signInAs("acme.near");
    expect(await prepareMandateAction(VAULT, goodForm())).toHaveProperty("error");
  });
});

describe("the out-of-NEAR codes reach the form from the server", () => {
  it("passes the SDK's codes as plain data", () => {
    expect(OUT_OF_NEAR.codes.length).toBeGreaterThan(0);
  });
});
