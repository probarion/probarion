import type { PGlite } from "@electric-sql/pglite";
import type { SpendView } from "@probarion/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { generateKey } from "@/lib/keys/service";
import type { VaultReader } from "@/lib/near/reader";
import { freshDb, seedTenant } from "../../../test/db/harness";
import { pgliteDb } from "../../../test/db/pglite-db";
import { fakeReader, vaultConfig } from "../../../test/fixtures/reader";
import { transportError } from "../../../test/fixtures/rpc";

// The vault overview shows "Your first agent payment" (site audit P1-8) to the owner of an external vault until its
// first payment, above everything else on the page, and to nobody else.

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  db: null as unknown as Db,
  reader: null as unknown as VaultReader,
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
vi.mock("@/lib/env", async () => {
  const { networkPart } = await import("../../../test/fixtures/networks");
  return { getEnv: () => networkPart({ defaultNetwork: "mainnet" }) };
});
vi.mock("@/lib/near/server", async () => {
  const { NETWORKS: N } = await import("@probarion/core");
  return {
    getReader: () => h.reader,
    getRpc: () => ({}),
    chainConsts: () => N.mainnet,
  };
});
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => null,
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/components/wallet/TxButton", () => ({
  TxButton: (p: { label: string }) => createElement("button", { type: "button" }, p.label),
}));

import VaultPage from "@/app/console/[vault]/page";

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
const VAULT = "acme.vaults.probarion.near";
const TEAM = "team.vaults.probarion.near";
const CANARY = "canary.vaults.probarion.near";
const KEYED = "keyed.vaults.probarion.near";
const AGENT = `ed25519:${"3".repeat(44)}`;
const TITLE = "Your first agent payment";

let pg: PGlite;

beforeAll(async () => {
  pg = await freshDb();
  h.db = pgliteDb(pg);
  await seedTenant(pg, { vault: VAULT, owner: "acme.near", approvers: ["cfo.near"] });
  await seedTenant(pg, { vault: TEAM, owner: "acme.near", kind: "team" });
  await seedTenant(pg, { vault: CANARY, owner: "acme.near", kind: "canary" });
  // KEYED has an active agent key and an active ledger key in the console, as Payables needs.
  const keyed = await seedTenant(pg, { vault: KEYED, owner: "acme.near" });
  for (const purpose of ["agent", "ledger"] as const) {
    const { id } = await generateKey(h.db, MASTER, {
      tenantId: keyed,
      purpose,
      label: purpose,
      createdBy: "acme.near",
    });
    await h.db.rpc("agent_key_set_status", {
      tenant_id: keyed,
      id,
      from: "pending",
      status: "active",
    });
  }
});
afterAll(async () => {
  await pg.close();
});

const spend = (status: SpendView["status"]): SpendView => ({
  id: 1,
  mandate_id: 1,
  amount: "2000000",
  invoice_hash: "f".repeat(64),
  ref: "inv-1",
  decision_hash: "d".repeat(64),
  agent_pk: AGENT,
  destination: { type: "near", account_id: "acme.near" },
  status,
  created_at_ns: "1",
  held_until_ns: null,
  memo: null,
});

function chain(
  over: {
    spends?: SpendView[];
    config?: Parameters<typeof vaultConfig>[0] | "throw";
    usdc?: string | "throw";
    agents?: { public_key: string; label: string; added_at_ns: string }[] | "throw";
  } = {},
) {
  h.reader = fakeReader({
    listAgents: async () => {
      if (over.agents === "throw") throw transportError();
      return over.agents ?? [];
    },
    getConfig: async () => {
      if (over.config === "throw") throw transportError();
      return vaultConfig(over.config);
    },
    listSpends: async () => over.spends ?? [],
    ftBalance: async () => {
      if (over.usdc === "throw") throw transportError();
      return over.usdc ?? "0";
    },
  });
}

beforeEach(() => {
  h.jar.clear();
  chain();
});

async function signInAs(account: string) {
  h.jar.set(
    SESSION_COOKIE,
    await createSessionToken(await deriveSubkey(MASTER, "session"), account, "mainnet"),
  );
}
const html = async (vault = VAULT) =>
  renderToStaticMarkup((await VaultPage({ params: Promise.resolve({ vault }) })) as ReactElement);

describe("the vault overview's first-payment card", () => {
  it("shows the owner of a new external vault where to start, above the vault's details", async () => {
    await signInAs("acme.near");
    const page = await html();
    expect(page).toContain(TITLE);
    expect(page).toContain("1 of 5 done");
    expect(page.indexOf(TITLE)).toBeLessThan(page.indexOf(">Vault</h2>"));
  });

  it("ticks the keys from the console's own key rows: an active agent key and an active ledger key", async () => {
    await signInAs("acme.near");
    expect(await html(KEYED)).toContain("2 of 5 done");
  });

  it("ticks the keys when the chain shows an agent key and a ledger key the console did not make (own agent, MCP)", async () => {
    await signInAs("acme.near");
    const own = { public_key: `ed25519:${"4".repeat(44)}`, label: "mcp-claude", added_at_ns: "1" };
    chain({ config: { ledger_key: `ed25519:${"5".repeat(44)}` }, agents: [own] });
    expect(await html()).toContain("2 of 5 done");
    // The ledger key alone, with no agent key outside the console, is not both keys.
    chain({ config: { ledger_key: `ed25519:${"5".repeat(44)}` }, agents: [] });
    expect(await html()).toContain("1 of 5 done");
    // And when the agent keys cannot be read, the step says so rather than "to do".
    chain({ config: { ledger_key: `ed25519:${"5".repeat(44)}` }, agents: "throw" });
    const page = await html();
    expect(page).toContain("1 of 5 done");
    expect(page).toContain("Could not check.");
  });

  it("offers both ways to do the keys step: Keys for hosted Payables, Agent (MCP) for your own agent", async () => {
    await signInAs("acme.near");
    const page = await html();
    expect(page).toContain(`href="/console/${VAULT}/keys"`);
    expect(page).toContain(`href="/console/${VAULT}/agent"`);
    expect(page).toContain("Connect agent");
  });

  it("says a step could not be checked when its read fails, and the page still renders", async () => {
    await signInAs("acme.near");
    chain({ usdc: "throw" });
    const page = await html();
    expect(page).toContain(TITLE);
    expect(page).toContain("Could not check.");
    expect(page).toContain(">Vault</h2>");
  });

  it("goes away after the vault's first paid spend", async () => {
    await signInAs("acme.near");
    chain({ spends: [spend("paid")] });
    expect(await html()).not.toContain(TITLE);
  });

  it("stays while the only spend is held", async () => {
    await signInAs("acme.near");
    chain({ spends: [spend("held")] });
    expect(await html()).toContain(TITLE);
  });

  it("is not shown to an approver, who cannot do these steps", async () => {
    await signInAs("cfo.near");
    expect(await html()).not.toContain(TITLE);
  });

  it("is not shown on the team's own vaults, or on a Canary vault", async () => {
    await signInAs("acme.near");
    expect(await html(TEAM)).not.toContain(TITLE);
    expect(await html(CANARY)).not.toContain(TITLE);
  });

  it("is not shown when the vault's config cannot be read", async () => {
    await signInAs("acme.near");
    chain({ config: "throw" });
    expect(await html()).not.toContain(TITLE);
  });

  it("is not shown when the chain names another owner", async () => {
    await signInAs("acme.near");
    chain({ config: { owner: "someone.near" } });
    expect(await html()).not.toContain(TITLE);
  });

  it("is not shown for a vault whose token is not this network's USDC: Mandates cannot serve it", async () => {
    await signInAs("acme.near");
    chain({ config: { usdc: "other-token.near" } });
    expect(await html()).not.toContain(TITLE);
  });
});
