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
    prepare?: () => Promise<unknown>;
    describe?: (r: unknown) => unknown;
    onResult?: (r: unknown) => void;
  }[],
  /** The props of every MandateFormPanel the page rendered. */
  panels: [] as Record<string, unknown>[],
  constsThrow: false,
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
  return {
    getReader: () => h.reader,
    getRpc: () => ({}),
    chainConsts: () => {
      if (h.constsThrow) throw new Error("no network configured");
      return N.mainnet;
    },
  };
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

// The real panel, with its props recorded: what the page hands the form is part of what is tested.
vi.mock("@/components/console/MandateFormPanel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/console/MandateFormPanel")>();
  return {
    MandateFormPanel: (p: Parameters<typeof real.MandateFormPanel>[0]) => {
      h.panels.push(p as unknown as Record<string, unknown>);
      return real.MandateFormPanel(p);
    },
  };
});

import { checkPayeeAction, prepareMandateAction } from "@/app/console/[vault]/mandates/actions";
import MandatesPage, { maxDuration } from "@/app/console/[vault]/mandates/page";
import { MandateFormPanel } from "@/components/console/MandateFormPanel";
import { OUT_OF_NEAR } from "@/lib/console/out-of-near";
import { log } from "@/lib/log";
import { MANDATE_STORAGE_DEPOSIT, TGAS, type WalletTx } from "@/lib/near/tx";
import { formatNear } from "@/lib/near/units";
import { CHANGED_SINCE_REVIEW, createLockKey } from "./mandate-create";
import type { MandateForm } from "./mandates";
import { EXPIRED_REVOKE_NOTE, EXPIRED_REVOKE_NOTE_UNKNOWN } from "./mandates-view";

// stderr stays clean, and the events are asserted
const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
const logError = vi.spyOn(log, "error").mockImplementation(() => {});

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
  h.panels.length = 0;
  h.constsThrow = false;
  reads.n = 0;
  warn.mockClear();
  logError.mockClear();
  chain();
});

/** The mandate ids of the Revoke buttons the page rendered. */
const revoked = () =>
  h.buttons
    .filter((b) => b.label === "Revoke")
    .map((b) => b.tx?.actions[0]?.params.args.mandate_id)
    .sort();
/** The create button, if the page rendered one. */
const createButton = () => h.buttons.find((b) => b.label === "Sign mandate in my wallet");

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
      expect(h.buttons, who).toEqual([]); // neither a Revoke nor a create button
    }
  });

  it("shows the owner the form and a Revoke for the active mandate, signed by the owner", async () => {
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("New mandate");
    expect(out).toContain("Sign mandate in my wallet");
    const revokes = h.buttons.filter((b) => b.label === "Revoke");
    expect(revokes).toHaveLength(1);
    const revoke = revokes[0];
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
    expect(revoked()).toEqual([]); // no Revoke without a list
    expect(warn).toHaveBeenCalledWith(
      "console.read_failed",
      expect.objectContaining({ what: "list_mandates", vault: VAULT, kind: "transport" }),
    );
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

  it("explains what the purpose hash is for (R15), and shows no review until the form can be signed", async () => {
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("sha256");
    expect(out).toContain("attach it to the invoices it covers");
    expect(out).toContain("hashes to this value");
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
      expect(
        await prepareMandateAction(VAULT, bad as unknown as MandateForm),
        String(bad),
      ).toMatchObject({ error: expect.stringContaining("Payee type") }); // the form's own refusal
    }
    expect(logError).not.toHaveBeenCalled(); // refused, not crashed and caught
  });

  it("answers an error, not a throw or a guess, when the vault cannot be read", async () => {
    chain({ config: "throw" });
    await signInAs("acme.near");
    expect(await prepareMandateAction(VAULT, goodForm())).toMatchObject({
      error: expect.stringContaining("nothing was signed"),
    });
    expect(warn).toHaveBeenCalledWith(
      "console.mandate_prepare_read_failed",
      expect.objectContaining({ vault: VAULT, kind: "transport" }),
    );
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
    expect(await prepareMandateAction(VAULT, goodForm())).toMatchObject({
      error: expect.stringMatching(/answer could not be read/),
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("refuses an agent answer that is not a list at all, without throwing", async () => {
    for (const bad of [{}, "keys", 5, null]) {
      h.reader = fakeReader({
        getConfig: async () => vaultConfig(),
        listAgents: async () => bad as unknown as AgentView[],
      });
      await signInAs("acme.near");
      expect(await prepareMandateAction(VAULT, goodForm()), JSON.stringify(bad)).toMatchObject({
        error: expect.stringMatching(/answer could not be read/),
      });
    }
    expect(logError).not.toHaveBeenCalled();
  });

  it("refuses an agent list that is not a list of keys", async () => {
    h.reader = fakeReader({
      getConfig: async () => vaultConfig(),
      listAgents: async () => [{ label: "x" }] as unknown as AgentView[],
    });
    await signInAs("acme.near");
    expect(await prepareMandateAction(VAULT, goodForm())).toMatchObject({
      error: expect.stringMatching(/answer could not be read/),
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("refuses an answer from the chain that has not the shape of a config", async () => {
    h.reader = fakeReader({
      getConfig: async () => ({ owner: "acme.near" }) as never,
      listAgents: async () => [agent()],
    });
    await signInAs("acme.near");
    expect(await prepareMandateAction(VAULT, goodForm())).toMatchObject({
      error: expect.stringMatching(/answer could not be read/),
    });
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("the out-of-NEAR codes reach the form from the server", () => {
  it("passes the SDK's codes as plain data", () => {
    expect(OUT_OF_NEAR.codes.length).toBeGreaterThan(0);
  });
});

const panelProps = (over: Partial<Parameters<typeof MandateFormPanel>[0]> = {}) => ({
  vault: VAULT,
  owner: "acme.near",
  network: "mainnet" as const,
  baseAsset: BASE_ASSET,
  allowedAssets: [BASE_ASSET],
  protocolAccounts: [NETWORKS.mainnet.usdc, NETWORKS.mainnet.intents, BASE_ASSET],
  agentKeys: [{ public_key: AGENT, label: "invoice bot" }],
  dailyBackstop: "500000000",
  floats: {
    near: { ok: true as const, units: "500000000" },
    base: { ok: true as const, units: "500000000" },
  },
  outOfNearCodes: OUT_OF_NEAR.codes,
  ...over,
});
/** The real form panel, started with these fields. */
const panel = (initialForm: Partial<MandateForm> = {}, over = {}) =>
  renderToStaticMarkup(
    createElement(MandateFormPanel, { ...panelProps(over), initialForm } as Parameters<
      typeof MandateFormPanel
    >[0]),
  );

describe("W-T9-R1: Revoke where it still changes what the contract does, and only for the real owner", () => {
  it("offers Revoke on an expired mandate that still has funds reserved, and says what it stops", async () => {
    chain({
      mandates: [
        mandate({ id: 1, expires_at_ns: nsIn(-DAY), reserved: "5000000" }), // expired, a payment still reserved
        mandate({ id: 2, expires_at_ns: nsIn(-DAY), reserved: "0" }), // expired, nothing left to stop
        mandate({ id: 3, expires_at_ns: nsIn(-DAY), reserved: "5000000", status: "revoked" }),
      ],
    });
    await signInAs("acme.near");
    const out = await html();
    expect(revoked()).toEqual([1]);
    expect(out.split(EXPIRED_REVOKE_NOTE).length - 1).toBe(1); // the note sits with that one button
    expect(out).toContain("stops any held payments from being approved");
    expect(out).toContain(">expired<");
    expect(out).toContain(">revoked<");
  });

  it("offers Revoke on an expired mandate whose reserved figure cannot be read, with the note that says so", async () => {
    chain({
      mandates: [
        mandate({ id: 1, expires_at_ns: nsIn(-DAY), reserved: "not a number" }),
        mandate({ id: 2, expires_at_ns: nsIn(-DAY), reserved: "0" }),
      ],
    });
    await signInAs("acme.near");
    const out = await html();
    expect(revoked()).toEqual([1]);
    expect(out.split(EXPIRED_REVOKE_NOTE_UNKNOWN).length - 1).toBe(1);
    expect(out).not.toContain(EXPIRED_REVOKE_NOTE); // not the note that claims a reserved amount
  });

  it("shows an approver neither the Revoke nor the note", async () => {
    chain({ mandates: [mandate({ expires_at_ns: nsIn(-DAY), reserved: "5000000" })] });
    await signInAs("cfo.near");
    const out = await html();
    expect(revoked()).toEqual([]);
    expect(out).not.toContain(EXPIRED_REVOKE_NOTE);
  });

  it("offers no Revoke, and no form, when the contract's owner is another account than the signed-in owner", async () => {
    chain({ config: { owner: "someone-else.near" } });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("Acme Design retainer"); // the list still shows
    expect(revoked()).toEqual([]);
    expect(createButton()).toBeUndefined();
  });

  it("offers no Revoke when the vault's config cannot be read", async () => {
    chain({ config: "throw" });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain("Acme Design retainer");
    expect(revoked()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "console.read_failed",
      expect.objectContaining({ what: "get_config", vault: VAULT }),
    );
  });

  it("still offers Revoke on a vault whose token is not the network USDC (revoking needs no decimals)", async () => {
    chain({ config: { usdc: "other-token.near" } });
    await signInAs("acme.near");
    await html();
    expect(revoked()).toEqual([1]);
    expect(createButton()).toBeUndefined();
  });
});

describe("W-T9-R1: the create button is always there, locked by the action, signed by the owner", () => {
  it("is rendered even while the form is incomplete, with the owner as signer and the vault's lock", async () => {
    await signInAs("acme.near");
    await html();
    const b = createButton();
    expect(b).toBeDefined();
    expect(b?.expectedSigner).toBe("acme.near");
    expect(b?.lockKey).toBe(createLockKey(VAULT));
    expect(b?.lockKey).toContain(`create-mandate:${VAULT}`);
    expect(b?.confirm).toBeUndefined(); // nothing to confirm yet
    expect(await b?.prepare?.()).toMatchObject({
      error: expect.stringContaining("Fix the highlighted"),
    });
  });

  it("keeps the same lock whatever the form holds, so an edit after an unknown outcome stays locked", () => {
    const keys = new Set<string | undefined>();
    for (const initial of [
      {},
      { payee: "designer.near" },
      { payee: "designer.near", purposeHash: "ab".repeat(32), expiresOn: dayIn(30), label: "A" },
      { payee: "designer.near", purposeHash: "ab".repeat(32), expiresOn: dayIn(30), label: "B" },
      { payeeKind: "base" as const, payee: CHECKSUMMED },
    ]) {
      h.buttons.length = 0;
      panel(initial);
      keys.add(createButton()?.lockKey);
    }
    expect([...keys]).toEqual([createLockKey(VAULT)]);
  });

  it("is not rendered for anyone but the owner", async () => {
    for (const who of ["cfo.near", "view.near"]) {
      h.buttons.length = 0;
      await signInAs(who);
      await html();
      expect(createButton(), who).toBeUndefined();
    }
  });
});

describe("W-T9-R1: the form panel, started with a complete form", () => {
  const complete = (over: Partial<MandateForm> = {}): Partial<MandateForm> => ({
    payee: "designer.near",
    purposeHash: "ab".repeat(32),
    expiresOn: dayIn(30),
    label: "Acme Design retainer",
    agentPk: AGENT,
    ...over,
  });

  it("shows the review: the payee, the amounts, the exact expiry and the deposit from the builder", () => {
    const out = panel(complete());
    expect(out).toContain("You are about to create");
    expect(out).toContain("designer.near (USDC on NEAR)");
    expect(out).toContain("up to 100 USDC");
    expect(out).toContain("up to 1000 USDC, at most 10");
    expect(out).toContain(`${dayIn(30)} 23:59:59 UTC`);
    expect(out).toContain(`Your wallet attaches ${formatNear(MANDATE_STORAGE_DEPOSIT)} NEAR`);
    expect(out).toContain("payee&#x27;s USDC registration"); // a NEAR payee is registered with the same attachment
    expect(out).not.toContain("Still to fill in");
  });

  it("leaves the registration out of the deposit text for a Base payee, and shows the EIP-55 address", () => {
    const out = panel(complete({ payeeKind: "base", payee: CHECKSUMMED.toLowerCase() }));
    expect(out).toContain(`${CHECKSUMMED} (USDC on Base)`);
    expect(out).toContain("(checksummed)");
    expect(out).not.toContain("registration");
  });

  it("hands the wallet button the owner, the vault's lock, and a confirm built from what will be signed", () => {
    panel(
      complete({ payeeKind: "base", payee: CHECKSUMMED.toLowerCase(), maxPerPaymentUsdc: "12.5" }),
    );
    const b = createButton();
    expect(b?.expectedSigner).toBe("acme.near");
    expect(b?.lockKey).toBe(createLockKey(VAULT));
    expect(b?.confirm).toContain(CHECKSUMMED);
    expect(b?.confirm).toContain("12.5 USDC per payment");
    expect(b?.confirm).toContain("1000 USDC in all");
    expect(b?.confirm).toContain(`until ${dayIn(30)} 23:59:59 UTC`);
  });

  it("signs the transaction the server prepares when it is the one reviewed", async () => {
    await signInAs("acme.near");
    panel(complete());
    const answer = (await createButton()?.prepare?.()) as WalletTx;
    expect(answer.receiverId).toBe(VAULT);
    expect(createCall(answer).methodName).toBe("create_mandate");
    const reviewed = await prepareMandateAction(VAULT, goodForm({ expiresOn: dayIn(30) }));
    expect(answer).toEqual(reviewed);
  });

  it("refuses to sign, with CHANGED_SINCE_REVIEW, when the server's transaction is not the reviewed one", async () => {
    await signInAs("acme.near");
    // the browser was handed another Base asset than the one the server builds with
    panel(complete({ payeeKind: "base", payee: CHECKSUMMED }), {
      baseAsset: "base-other.omft.near",
      allowedAssets: ["base-other.omft.near"],
    });
    expect(await createButton()?.prepare?.()).toEqual({ error: CHANGED_SINCE_REVIEW });
  });

  it("passes the server's refusal through (here: the account is not the vault's owner)", async () => {
    await signInAs("mallory.near");
    panel(complete());
    expect(await createButton()?.prepare?.()).toMatchObject({ status: 403 });
  });

  it("words an out-of-NEAR refusal for the signer, in the detail line only", () => {
    panel(complete());
    const code = OUT_OF_NEAR.codes[0] ?? "LackBalanceForState";
    const words = createButton()?.describe?.({ status: "failed", txHash: null, code, error: null });
    expect(Object.keys(words as object)).toEqual(["detail"]);
    expect(
      createButton()?.describe?.({
        status: "failed",
        txHash: null,
        code: "PROBARION:NotOwner",
        error: null,
      }),
    ).toBeUndefined();
  });

  it("refuses a NEAR payee that is a token or bridge contract of the vault", () => {
    for (const payee of [NETWORKS.mainnet.usdc, NETWORKS.mainnet.intents, BASE_ASSET]) {
      const out = panel(complete({ payee }));
      expect(out, payee).toContain("token or bridge contract");
      expect(out, payee).not.toContain("You are about to create");
    }
  });

  it("warns, without blocking, that a 0x address typed as a NEAR account is not a Base payout", () => {
    const out = panel(complete({ payee: `0x${"ab".repeat(20)}` }));
    expect(out).toContain("ETH-implicit");
    expect(out).toContain("You are about to create"); // the vault accepts it, so the form does too
  });

  it("says the vault does not allow Base USDC payouts, rather than 'could not read', for a Base payee", () => {
    const out = panel(complete({ payeeKind: "base", payee: CHECKSUMMED }), {
      floats: {
        near: { ok: true, units: "500000000" },
        base: { ok: false, notAllowed: true },
      },
    });
    expect(out).toContain("so a Base payee cannot be paid from it"); // the float's words, not the field error's
    expect(out).not.toContain("Balance unavailable");
  });

  it("takes a Base payee's balance from the Base USDC in Intents, not from the USDC on NEAR", () => {
    // plenty on NEAR, nothing readable in Intents
    let out = panel(complete({ payeeKind: "base", payee: CHECKSUMMED }), {
      floats: { near: { ok: true, units: "500000000" }, base: { ok: false } },
    });
    expect(out).toContain("Balance unavailable");
    expect(out).toContain("Base USDC in Intents");
    // plenty in Intents, little on NEAR: a NEAR payee is warned, a Base payee is not
    const floats = {
      near: { ok: true as const, units: "25000000" },
      base: { ok: true as const, units: "500000000" },
    };
    out = panel(complete({ payeeKind: "base", payee: CHECKSUMMED }), { floats });
    expect(out).not.toContain("the vault holds now");
    out = panel(complete(), { floats });
    expect(out).toContain("USDC on NEAR the vault holds now (25 USDC)");
    // and the reverse: little in Intents warns the Base payee
    out = panel(complete({ payeeKind: "base", payee: CHECKSUMMED }), {
      floats: { near: floats.base, base: floats.near },
    });
    expect(out).toContain("Base USDC in Intents the vault holds now (25 USDC)");
  });

  it("starts empty of everything it must not guess: no payee, no purpose, no date", () => {
    const out = panel();
    expect(out).toContain("Still to fill in: Payee, Purpose document hash, Expires on, Name.");
    expect(out).not.toContain("You are about to create");
  });
});

describe("W-T9-R1: what the page hands the form is read from the chain, and made safe", () => {
  it("gives the form the vault's own token and bridge contracts as accounts that are not payees", async () => {
    await signInAs("acme.near");
    await html();
    expect(h.panels[0]?.protocolAccounts).toEqual([
      NETWORKS.mainnet.usdc,
      NETWORKS.mainnet.intents,
      BASE_ASSET,
    ]);
  });

  it("tells a Base asset the vault does not allow from a balance that could not be read", async () => {
    await signInAs("acme.near");
    chain({ config: { allowed_assets: [] } });
    await html();
    expect(h.panels[0]?.floats).toMatchObject({ base: { ok: false, notAllowed: true } });
    h.panels.length = 0;
    chain({ intents: "throw" });
    await html();
    const floats = h.panels[0]?.floats as { base: Record<string, unknown> } | undefined;
    const base = floats?.base;
    expect(base).toEqual({ ok: false }); // a failed read, not an asset the vault refuses
  });

  it("passes balances that were read, and an unreadable NEAR balance as unreadable, never as zero", async () => {
    await signInAs("acme.near");
    chain({ usdc: "25000000" });
    await html();
    expect(h.panels[0]?.floats).toMatchObject({ near: { ok: true, units: "25000000" } });
    h.panels.length = 0;
    chain({ usdc: "throw" });
    await html();
    const floats = h.panels[0]?.floats as { near: unknown } | undefined;
    expect(floats?.near).toEqual({ ok: false });
  });

  it("shows agent keys with text from the chain made safe, but keeps the key itself exact", async () => {
    chain({ agents: [{ ...agent(), label: "bot\u202E evil" }] });
    await signInAs("acme.near");
    const out = await html();
    const keys = h.panels[0]?.agentKeys as { public_key: string; label: string }[];
    expect(keys[0]?.public_key).toBe(AGENT);
    expect(keys[0]?.label).toBe("bot\uFFFD evil");
    expect(out).not.toContain("\u202E");
  });

  it("falls back to the start of the key when an agent has no label, and cuts a long one", async () => {
    chain({
      agents: [
        { ...agent(), label: "" },
        { ...agent(REMOVED_AGENT), label: "x".repeat(200) },
      ],
    });
    await signInAs("acme.near");
    await html();
    const keys = h.panels[0]?.agentKeys as { label: string }[];
    expect(keys[0]?.label).toBe(`${AGENT.slice(0, 20)}…`);
    expect(keys[1]?.label).toBe(`${"x".repeat(40)}…`);
  });

  it("shows the vault's owner and token in the notices as safe text", async () => {
    chain({ config: { owner: "evil\u202E.near" } });
    await signInAs("acme.near");
    expect(await html()).not.toContain("\u202E");
    chain({ config: { usdc: "tok\u202Een.near" } });
    expect(await html()).not.toContain("\u202E");
  });

  it("puts a purpose hash in a tooltip only when it is a sha256", async () => {
    chain({
      mandates: [mandate({ id: 1 }), mandate({ id: 2, purpose_hash: 'x" onmouseover="alert(1)' })],
    });
    await signInAs("acme.near");
    const out = await html();
    expect(out).toContain(`title="${"ab".repeat(32)}"`);
    expect(out.match(/title="/g)).toHaveLength(1);
    expect(out).not.toContain("onmouseover");
    expect(out).toContain("PO unreadable");
  });

  it("shows agent keys that are not a list of keys as unavailable, never as 'no key yet'", async () => {
    await signInAs("acme.near");
    for (const bad of [
      {},
      "keys",
      5,
      [{ label: "x" }],
      [null],
      [{ public_key: 5 }],
      [{ public_key: "" }],
    ]) {
      chain({ agents: bad as unknown as AgentView[] });
      const out = await html();
      expect(out, JSON.stringify(bad)).toContain("agent keys are unavailable");
      expect(out, JSON.stringify(bad)).not.toContain("this vault has none yet");
      expect(out, JSON.stringify(bad)).not.toContain("Sign mandate in my wallet");
    }
  });
});

describe("W-T9-R1: prepareMandateAction, the rest of the NEAR payee rules", () => {
  it("refuses the vault's USDC, its Intents contract and its allowed assets as NEAR payees", async () => {
    await signInAs("acme.near");
    for (const payee of [NETWORKS.mainnet.usdc, NETWORKS.mainnet.intents, BASE_ASSET]) {
      expect(await prepareMandateAction(VAULT, goodForm({ payee })), payee).toMatchObject({
        error: expect.stringContaining("token or bridge contract"),
      });
    }
  });

  it("takes the protocol accounts from the chain's config, not from the browser", async () => {
    chain({ config: { usdc: NETWORKS.mainnet.usdc, intents: "bridge.near" } });
    await signInAs("acme.near");
    expect(await prepareMandateAction(VAULT, goodForm({ payee: "bridge.near" }))).toMatchObject({
      error: expect.stringContaining("token or bridge contract"),
    });
    // ...and an account that is not one is a payee
    expect(
      "error" in (await prepareMandateAction(VAULT, goodForm({ payee: "designer.near" }))),
    ).toBe(false);
  });

  it("accepts a 0x address typed as a NEAR account: the console warns, the vault allows it", async () => {
    await signInAs("acme.near");
    const tx = await prepareMandateAction(VAULT, goodForm({ payee: `0x${"ab".repeat(20)}` }));
    expect("error" in tx).toBe(false);
  });

  it("answers an error, not a throw, when the membership read fails, and logs the event", async () => {
    await signInAs("acme.near");
    const real = h.db;
    h.db = new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error("db down");
        },
      },
    ) as unknown as Db;
    try {
      expect(await prepareMandateAction(VAULT, goodForm())).toMatchObject({
        error: expect.stringContaining("nothing was signed"),
      });
    } finally {
      h.db = real;
    }
    expect(logError).toHaveBeenCalledWith("console.mandate_prepare_failed", { error: "Error" });
  });

  it("answers an error, not a throw, when the network constants fail", async () => {
    await signInAs("acme.near");
    h.constsThrow = true;
    expect(await prepareMandateAction(VAULT, goodForm())).toMatchObject({
      error: expect.stringContaining("nothing was signed"),
    });
    expect(logError).toHaveBeenCalledWith("console.mandate_prepare_failed", expect.anything());
  });
});

describe("W-T9-R1: checkPayeeAction (does the named account exist?), owner-only", () => {
  const exists = (answer: boolean | "throw") => {
    h.reader = fakeReader({
      accountExists: async () => {
        reads.n += 1;
        if (answer === "throw") throw transportError();
        return answer;
      },
    });
  };

  it("401 without a session and 403 for a non-owner, before any chain read", async () => {
    exists(true);
    expect(await checkPayeeAction(VAULT, "designer.near")).toMatchObject({ status: 401 });
    for (const who of ["mallory.near", "cfo.near", "view.near"]) {
      await signInAs(who);
      expect(await checkPayeeAction(VAULT, "designer.near"), who).toMatchObject({ status: 403 });
    }
    await signInAs("acme.near");
    expect(await checkPayeeAction(OTHER, "designer.near")).toMatchObject({ status: 403 });
    expect(reads.n).toBe(0);
  });

  it("tells an account that exists from one that does not", async () => {
    await signInAs("acme.near");
    exists(true);
    expect(await checkPayeeAction(VAULT, "designer.near")).toEqual({ exists: true });
    exists(false);
    expect(await checkPayeeAction(VAULT, "  desinger.near ")).toEqual({ exists: false });
  });

  it("says null, never 'does not exist', when it cannot tell", async () => {
    await signInAs("acme.near");
    exists("throw");
    expect(await checkPayeeAction(VAULT, "designer.near")).toEqual({ exists: null });
    expect(warn).toHaveBeenCalledWith(
      "console.payee_check_failed",
      expect.objectContaining({ vault: VAULT, kind: "transport" }),
    );
  });

  it("does not read the chain for text that is not an account id", async () => {
    await signInAs("acme.near");
    exists(false);
    for (const bad of ["", "Not An Account", "a", `${"x".repeat(70)}`, 5 as unknown as string]) {
      expect(await checkPayeeAction(VAULT, bad)).toEqual({ exists: null });
    }
    expect(reads.n).toBe(0);
  });

  it("says null, not a throw, when the membership read fails", async () => {
    await signInAs("acme.near");
    const real = h.db;
    h.db = new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error("db down");
        },
      },
    ) as unknown as Db;
    try {
      expect(await checkPayeeAction(VAULT, "designer.near")).toEqual({ exists: null });
    } finally {
      h.db = real;
    }
    expect(logError).toHaveBeenCalledWith("console.payee_check_crashed", { error: "Error" });
  });
});
