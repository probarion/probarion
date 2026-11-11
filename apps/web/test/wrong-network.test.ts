import type { PGlite } from "@electric-sql/pglite";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { freshDb, seedTenant } from "./db/harness";
import { pgliteDb } from "./db/pglite-db";
import { MAINNET_HOST, TESTNET_HOST } from "./fixtures/networks";

// W-NET-R4, R10: a vault registered on the other network is never touched by a page, a route or a server action. The
// person is a real member of the vault, signed in at the other network's address with a session of that network, so the
// guard (the real one, on PGlite) is what stops the call, and it must stop it BEFORE any chain read, any database write
// and any signing step. Every call below is made for a vault on testnet from the mainnet address, and again for a vault
// on mainnet (the control) to show the same call does get past the guard and does reach the chain and the database.
const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  host: null as string | null,
  db: null as unknown as Db,
  /** Every database function the code asked for, and every chain client it asked for. */
  dbCalls: [] as string[],
  chainCalls: [] as string[],
  revalidated: [] as string[],
  /** Whether the site serves the other network too (an origin for it). */
  both: true,
  /** The default network. */
  defaultNetwork: "testnet" as "mainnet" | "testnet",
}));

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name) } : undefined),
  }),
  headers: async () => ({ get: (name: string) => (name === "host" ? h.host : null) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => h.revalidated.push(p) }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/crypto/server", () => ({
  masterKey: () => MASTER,
  subkey: (purpose: Parameters<typeof deriveSubkey>[1]) => deriveSubkey(MASTER, purpose),
}));
vi.mock("@/lib/db/clients", () => ({
  serviceDb: () => ({
    rpc: (fn: string, p?: Record<string, unknown>) => {
      h.dbCalls.push(fn);
      return h.db.rpc(fn, p);
    },
  }),
  publicDb: () => ({
    rpc: (fn: string) => {
      h.dbCalls.push(fn);
      return Promise.resolve(null);
    },
  }),
}));
vi.mock("@/lib/env", async () => {
  const { networkPart } = await import("./fixtures/networks");
  return {
    getEnv: () => ({
      ...networkPart({ defaultNetwork: h.defaultNetwork, both: h.both }),
      ONECLICK_JWT: "jwt-for-tests",
      TELEGRAM_BOT_TOKEN: null,
      RESEND_API_KEY: null,
      NEARAI_API_KEY: null,
      NEARAI_MODEL: null,
    }),
  };
});
// Register and the approvers re-sync take their clients from the chain check (`verifiedChain`), which asks every node of the
// network's list: a chain call like the others, recorded, and it fails like an unreachable node (so nothing reaches the
// network, and a call that gets this far shows it in `chainCalls`).
vi.mock("@/lib/near/chain", async (orig) => ({
  ...(await orig<typeof import("@/lib/near/chain")>()),
  verifiedChain: async (network: string) => {
    h.chainCalls.push(`chain:${network}`);
    throw new Error("the chain check is unreachable in this test");
  },
}));
// A chain client that is asked for at all is a read: each one records itself, and fails like an unreachable node.
vi.mock("@/lib/near/server", async () => {
  const { NETWORKS } = await import("@probarion/core");
  const down = (what: string) => async () => {
    throw new Error(`${what} is unreachable in this test`);
  };
  const reader = new Proxy({}, { get: (_t, method) => down(`reader.${String(method)}`) });
  return {
    getReader: (network: string) => {
      h.chainCalls.push(`reader:${network}`);
      return reader;
    },
    getRpc: (network: string) => {
      h.chainCalls.push(`rpc:${network}`);
      return new Proxy({}, { get: (_t, method) => down(`rpc.${String(method)}`) });
    },
    chainConsts: (network: "mainnet" | "testnet") => NETWORKS[network],
  };
});
vi.mock("@/lib/alerts/server", () => ({ alertSenders: () => ({ telegram: null, email: null }) }));
vi.mock("@/components/wallet/TxButton", () => ({
  TxButton: (p: { label: string }) => createElement("button", { type: "button" }, p.label),
}));

const MAINNET_VAULT = "acme.vaults.probarion.near";
const TESTNET_VAULT = "acme.vaults.probarion.testnet";
const OWNER = "acme.near";
const INVOICE = "00000000-0000-4000-8000-000000000001";
/** A well-formed public key, so the Agent (MCP) actions get past their own checks to the chain in the control. */
const AGENT_PK = "ed25519:7BPBxA6r525pdwRKzkKs6mNXMhEHj9SDSMBqffjYC3hP";

let pg: PGlite;

beforeAll(async () => {
  pg = await freshDb();
  h.db = pgliteDb(pg);
  await seedTenant(pg, { vault: MAINNET_VAULT, owner: OWNER });
  await seedTenant(pg, { vault: TESTNET_VAULT, owner: OWNER, network: "testnet" });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  h.jar.clear();
  h.host = MAINNET_HOST;
  h.dbCalls = [];
  h.chainCalls = [];
  h.revalidated = [];
  h.both = true;
  h.defaultNetwork = "testnet";
  h.jar.set(
    SESSION_COOKIE,
    await createSessionToken(await deriveSubkey(MASTER, "session"), OWNER, "mainnet"),
  );
});

// --- the entry points ------------------------------------------------------------------------------------------------

import { POST as invoices } from "@/app/api/console/[vault]/invoices/route";
import { POST as topupQuote } from "@/app/api/topup/quote/route";
import { GET as topupStatus } from "@/app/api/topup/status/route";
import { POST as topupSubmit } from "@/app/api/topup/submit/route";
import { refreshMembersAction, updateSettingsAction } from "@/app/console/[vault]/actions";
import {
  prepareAddAgentAction,
  prepareSetLedgerKeyAction,
} from "@/app/console/[vault]/agent/actions";
import {
  addEmailAction,
  connectTelegramAction,
  removeSubscriptionAction,
} from "@/app/console/[vault]/alerts/actions";
import {
  discardKeyAction,
  generateKeyAction,
  keepKeyAction,
  syncKeysAction,
} from "@/app/console/[vault]/keys/actions";
import { checkPayeeAction, prepareMandateAction } from "@/app/console/[vault]/mandates/actions";
import {
  confirmInvoiceAction,
  prepareConfirmAction,
  rejectInvoiceAction,
  setZeroRetentionAction,
} from "@/app/console/[vault]/payables/actions";
import { prepareFundAction } from "@/app/console/[vault]/topup/actions";
import { registerVaultAction } from "@/app/console/actions";

const ORIGIN = `https://${MAINNET_HOST}`;
const form = (fields: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const post = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

type Call = (vault: string) => Promise<unknown>;
const ROUTES: [string, Call][] = [
  [
    "POST /api/console/[vault]/invoices",
    (vault) =>
      invoices(
        new Request(`${ORIGIN}/api/console/${vault}/invoices`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-length": "10" },
          body: "x".repeat(10),
        }),
        { params: Promise.resolve({ vault }) },
      ),
  ],
  [
    "POST /api/topup/quote",
    (vault) => topupQuote(post("/api/topup/quote", { vault, amountUsdc: "20" })),
  ],
  [
    "GET /api/topup/status",
    (vault) =>
      topupStatus(
        new Request(`${ORIGIN}/api/topup/status?vault=${vault}&depositAddress=${"a".repeat(64)}`),
      ),
  ],
  [
    "POST /api/topup/submit",
    (vault) =>
      topupSubmit(
        post("/api/topup/submit", {
          vault,
          txHash: "9fV2pZ7mUq5f6p3rGq7bX1tYkqfUu1Vb3bWm2C5g7h8J",
          depositAddress: "a".repeat(64),
        }),
      ),
  ],
];
const ACTIONS: [string, Call][] = [
  ["updateSettingsAction", (v) => updateSettingsAction(v, null, form({ zero_retention: "on" }))],
  ["refreshMembersAction", (v) => refreshMembersAction(v, null)],
  ["generateKeyAction", (v) => generateKeyAction(v, "agent", "a key")],
  ["discardKeyAction", (v) => discardKeyAction(v, INVOICE)],
  ["keepKeyAction", (v) => keepKeyAction(v, INVOICE)],
  ["syncKeysAction", (v) => syncKeysAction(v)],
  ["prepareAddAgentAction", (v) => prepareAddAgentAction(v, AGENT_PK, "mcp")],
  ["prepareSetLedgerKeyAction", (v) => prepareSetLedgerKeyAction(v, AGENT_PK, null)],
  ["prepareMandateAction", (v) => prepareMandateAction(v, {} as never)],
  ["checkPayeeAction", (v) => checkPayeeAction(v, "payee.near")],
  ["setZeroRetentionAction", (v) => setZeroRetentionAction(v, form({ zero_retention: "on" }))],
  ["prepareConfirmAction", (v) => prepareConfirmAction(v, INVOICE)],
  ["confirmInvoiceAction", (v) => confirmInvoiceAction(v, INVOICE, "nonce", {})],
  ["rejectInvoiceAction", (v) => rejectInvoiceAction(v, INVOICE, {} as never)],
  ["prepareFundAction", (v) => prepareFundAction(v, "5")],
  ["addEmailAction", (v) => addEmailAction(v, null, form({ email: "a@example.com" }))],
  ["connectTelegramAction", (v) => connectTelegramAction(v)],
  ["removeSubscriptionAction", (v) => removeSubscriptionAction(v, INVOICE)],
];

/** The status a route answered with, or the status an action put in its answer (undefined when it answered none). */
async function statusOf(result: unknown): Promise<number | undefined> {
  if (result instanceof Response) return result.status;
  if (typeof result === "object" && result !== null && "status" in result) {
    return (result as { status?: number }).status;
  }
  return undefined;
}

/**
 * The form actions that do not answer with an error and a status. Three of them return nothing at all (a `Promise<void>`,
 * the page shows the result): discardKeyAction, setZeroRetentionAction and removeSubscriptionAction. keepKeyAction answers
 * with a message, which for a vault on the other network is the guard's sentence.
 */
const SILENT = new Set([
  "discardKeyAction",
  "keepKeyAction",
  "setZeroRetentionAction",
  "removeSubscriptionAction",
]);

/** What a call for a vault on the other network answered: the 409 and the sentence, in whichever form the entry point has. */
async function expectWrongNetwork(name: string, result: unknown, sentence: string) {
  if (result instanceof Response) {
    expect(result.status, name).toBe(409);
    expect(await result.json(), name).toEqual({ error: "wrong_network", detail: sentence });
  } else if (name === "keepKeyAction") {
    expect(result, name).toEqual({ ok: false, message: sentence });
  } else if (SILENT.has(name)) {
    // A form action that returns nothing: what shows it did nothing is that it touched nothing (asserted by the caller).
    expect(result, name).toBeUndefined();
  } else {
    // An action shows one plain sentence and the status.
    expect(result, name).toMatchObject({ error: sentence, status: 409 });
  }
}

/** The actions whose own answer, for a vault they may act on, comes before any read or write. */
const EARLY = new Set(["rejectInvoiceAction", "addEmailAction", "connectTelegramAction"]);

/** What the call touched beyond reading the membership: any other database function, any chain client. */
const touched = () => ({
  db: h.dbCalls.filter((fn) => fn !== "member_role"),
  chain: h.chainCalls,
});

describe("a vault on the other network, opened at this network's address", () => {
  describe.each([...ROUTES, ...ACTIONS])("%s", (name, call) => {
    it("answers 409, and has read no chain, written nothing and signed nothing", async () => {
      const result = await call(TESTNET_VAULT);
      await expectWrongNetwork(
        name,
        result,
        "This vault is on NEAR testnet. Open it at the testnet address.",
      );
      expect(touched(), name).toEqual({ db: [], chain: [] });
      expect(h.revalidated, name).toEqual([]);
    });

    it("is not stopped for a vault on its own network: the control that shows the test can tell", async () => {
      const result = await call(MAINNET_VAULT).catch(() => undefined);
      expect(await statusOf(result), name).not.toBe(409);
      if (EARLY.has(name)) {
        // These stop on the server's own settings or on the arguments (no bot, no mail provider, a snapshot that is not
        // one) before they read or write anything: the control is that the answer is theirs and not the guard's.
        expect(result, name).toBeDefined();
        expect(JSON.stringify(result), name).not.toContain("This vault is on NEAR");
      } else {
        // It got past the guard: it asked the database for more than the membership, or asked for a chain client.
        const t = touched();
        expect(t.db.length + t.chain.length, name).toBeGreaterThan(0);
      }
    });
  });

  it("says the site does not serve that network yet, with no address to open, when it has none", async () => {
    h.both = false;
    h.defaultNetwork = "mainnet";
    const sentence = "This vault is on NEAR testnet, which this site does not serve yet.";
    for (const [name, call] of [...ROUTES, ...ACTIONS]) {
      await expectWrongNetwork(name, await call(TESTNET_VAULT), sentence);
    }
    expect(touched()).toEqual({ db: [], chain: [] });
  });

  it("is a 409 for a member only: a stranger still gets the same 403 as for a vault that does not exist", async () => {
    h.jar.set(
      SESSION_COOKIE,
      await createSessionToken(await deriveSubkey(MASTER, "session"), "mallory.near", "mainnet"),
    );
    const stranger = await syncKeysAction(TESTNET_VAULT);
    const missing = await syncKeysAction("no-such.vaults.probarion.testnet");
    expect(stranger).toEqual(missing);
    expect(stranger).toMatchObject({ ok: false, status: 403 });
  });

  it("is gone once the person is at the vault's own address with a session of that network", async () => {
    h.host = TESTNET_HOST;
    h.jar.set(
      SESSION_COOKIE,
      await createSessionToken(await deriveSubkey(MASTER, "session"), OWNER, "testnet"),
    );
    const result = await syncKeysAction(TESTNET_VAULT);
    expect(await statusOf(result)).not.toBe(409);
    expect(h.chainCalls).toContain("reader:testnet");
    expect(h.chainCalls).not.toContain("reader:mainnet");
  });

  it("cannot be reached with a session of the vault's network at the other address either", async () => {
    // A testnet session at the mainnet host is no session: the cookie is host-only, but the check does not rely on that.
    h.jar.set(
      SESSION_COOKIE,
      await createSessionToken(await deriveSubkey(MASTER, "session"), OWNER, "testnet"),
    );
    const result = await syncKeysAction(TESTNET_VAULT);
    expect(await statusOf(result)).toBe(401);
    expect(touched()).toEqual({ db: [], chain: [] });
  });
});

// --- a vault of the other network that is not a member's: Register ---------------------------------------------------------

describe("Register (registerVaultAction) for a vault registered on the other network", () => {
  beforeEach(async () => {
    // Each attempt takes a token of the account's Register bucket; every test starts with the bucket empty.
    await pg.exec("delete from public.rate_limits");
  });

  const tenantNetworks = async () =>
    (
      await pg.query<{ vault_id: string; network: string }>(
        "select vault_id, network from public.tenants where vault_id = any ($1) order by vault_id",
        [[MAINNET_VAULT, TESTNET_VAULT]],
      )
    ).rows;
  const asTestnetOwner = async () => {
    h.host = TESTNET_HOST;
    h.jar.set(
      SESSION_COOKIE,
      await createSessionToken(await deriveSubkey(MASTER, "session"), OWNER, "testnet"),
    );
  };

  it("answers 409 for a testnet vault from the mainnet address: one sentence, no chain client, no write", async () => {
    const before = await tenantNetworks();
    const r = await registerVaultAction(TESTNET_VAULT);
    expect(r).toEqual({
      ok: false,
      error: "This vault is on NEAR testnet. Open it at the testnet address.",
      code: "network_mismatch",
      status: 409,
    });
    expect(h.chainCalls).toEqual([]);
    expect(h.dbCalls).not.toContain("tenant_register");
    expect(h.revalidated).toEqual([]);
    expect(await tenantNetworks()).toEqual(before);
  });

  it("answers 409 for a mainnet vault from the testnet address, the same way", async () => {
    await asTestnetOwner();
    const before = await tenantNetworks();
    const r = await registerVaultAction(MAINNET_VAULT);
    expect(r).toEqual({
      ok: false,
      error: "This vault is on NEAR mainnet. Open it at the mainnet address.",
      code: "network_mismatch",
      status: 409,
    });
    expect(h.chainCalls).toEqual([]);
    expect(h.dbCalls).not.toContain("tenant_register");
    expect(await tenantNetworks()).toEqual(before);
  });

  it("says the site does not serve that network yet when it has no address for it", async () => {
    h.both = false;
    h.defaultNetwork = "mainnet";
    const r = await registerVaultAction(TESTNET_VAULT);
    expect(r).toEqual({
      ok: false,
      error: "This vault is on NEAR testnet, which this site does not serve yet.",
      code: "network_mismatch",
      status: 409,
    });
    expect(JSON.stringify(r)).not.toContain("address");
    expect(h.chainCalls).toEqual([]);
    expect(h.dbCalls).not.toContain("tenant_register");
  });

  it("is not stopped for a vault of its own network, or for one nobody has registered: the control", async () => {
    for (const vault of [MAINNET_VAULT, "new.vaults.probarion.near"]) {
      h.chainCalls = [];
      const r = await registerVaultAction(vault).catch(() => undefined);
      expect((r as { status?: number } | undefined)?.status, vault).not.toBe(409);
      // It got past the check and asked this network's chain (through the chain check, which is down in this test).
      expect(h.chainCalls, vault).toContain("chain:mainnet");
    }
  });

  it("asks the database for the tenant only for an account id, and answers the same 401 as before without a session", async () => {
    h.jar.clear();
    expect(await registerVaultAction(TESTNET_VAULT)).toMatchObject({ ok: false, status: 401 });
    expect(h.dbCalls).toEqual([]);
    expect(h.chainCalls).toEqual([]);
  });
});

// --- the pages --------------------------------------------------------------------------------------------------------

import AgentPage from "@/app/console/[vault]/agent/page";
import AlertsPage from "@/app/console/[vault]/alerts/page";
import ApprovePage from "@/app/console/[vault]/approve/[spend]/page";
import KeysPage from "@/app/console/[vault]/keys/page";
import MandatesPage from "@/app/console/[vault]/mandates/page";
import VaultPage from "@/app/console/[vault]/page";
import InvoiceCyclePage from "@/app/console/[vault]/payables/[id]/page";
import PayablesPage from "@/app/console/[vault]/payables/page";
import TopUpPage from "@/app/console/[vault]/topup/page";

const params = (vault: string) => ({ params: Promise.resolve({ vault }) });
const PAGES: [string, (vault: string) => Promise<unknown>][] = [
  ["the overview", (v) => VaultPage(params(v))],
  ["Keys", (v) => KeysPage(params(v))],
  ["Agent (MCP)", (v) => AgentPage(params(v))],
  ["Mandates", (v) => MandatesPage(params(v))],
  ["Payables", (v) => PayablesPage(params(v))],
  [
    "a payables invoice",
    (v) => InvoiceCyclePage({ params: Promise.resolve({ vault: v, id: INVOICE }) }),
  ],
  ["Top-up", (v) => TopUpPage(params(v))],
  ["a spend to approve", (v) => ApprovePage({ params: Promise.resolve({ vault: v, spend: "7" }) })],
  ["Alerts", (v) => AlertsPage({ ...params(v), searchParams: Promise.resolve({}) } as never)],
];

describe.each(PAGES)("the page of %s for a vault on the other network", (name, render) => {
  it("shows the card in place of the page, and reads nothing from either chain", async () => {
    const out = renderToStaticMarkup((await render(TESTNET_VAULT)) as ReactElement).replaceAll(
      "&#x27;",
      "'",
    );
    expect(out, name).toContain("This vault is on NEAR testnet");
    expect(out, name).toContain(
      "You are on the mainnet console. Open it at the testnet address and sign in there with your testnet wallet.",
    );
    expect(out, name).toContain(
      'href="https://testnet.probarion.test/console/acme.vaults.probarion.testnet"',
    );
    expect(out, name).toContain("Open on testnet");
    expect(touched(), name).toEqual({ db: [], chain: [] });
  });
});

// --- the list ---------------------------------------------------------------------------------------------------------

import ConsolePage from "@/app/console/page";

describe("the console list, at the mainnet address", () => {
  const rendered = async () =>
    renderToStaticMarkup((await ConsolePage()) as ReactElement).replaceAll("&#x27;", "'");

  it("lists every vault of the account, and the one on testnet keeps its warn badge, now a link to its address", async () => {
    const out = await rendered();
    expect(out).toContain(MAINNET_VAULT);
    expect(out).toContain(TESTNET_VAULT);
    // The mainnet vault has no network badge; the testnet one has, and it is a link that reads "testnet ↗".
    expect(out).toMatch(
      /<a href="https:\/\/testnet\.probarion\.test\/console\/acme\.vaults\.probarion\.testnet"><span [^>]*bg-wait-bg[^>]*>testnet <span aria-hidden="true">↗<\/span><\/span><\/a>/,
    );
    expect([...out.matchAll(/bg-wait-bg/g)]).toHaveLength(1);
    // The vault's own link in the row is still the page on this address, which says where the vault is.
    expect(out).toContain('href="/console/acme.vaults.probarion.testnet"');
  });

  it("keeps the plain warn badge, with no link, when the site has no address for that network", async () => {
    h.both = false;
    h.defaultNetwork = "mainnet";
    const out = await rendered();
    expect(out).toContain(TESTNET_VAULT);
    expect(out).toMatch(/<span [^>]*bg-wait-bg[^>]*>testnet<\/span>/);
    expect(out).not.toContain("testnet ↗");
    expect(out).not.toContain("testnet.probarion.test");
  });

  it("offers to create and register on the network of this address: its factory and its chain, and no other", async () => {
    const out = await rendered();
    // The register form suggests a vault under this network's factory.
    expect(out).toContain('placeholder="acme.vaults.probarion.near"');
    expect(h.chainCalls.length).toBeGreaterThan(0);
    expect(h.chainCalls.every((c) => c === "rpc:mainnet")).toBe(true);
  });
});
