import type { PGlite } from "@electric-sql/pglite";
import { formatPublicKey } from "@probarion/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import type { AccessKeyState, VaultReader } from "@/lib/near/reader";
import type { WalletTx } from "@/lib/near/tx";
import { freshDb, seedTenant } from "../../../../../test/db/harness";
import { silenceLogs } from "../../../../../test/db/keys-helpers";
import { pgliteDb } from "../../../../../test/db/pglite-db";
import { fakeReader, vaultConfig } from "../../../../../test/fixtures/reader";
import { transportError } from "../../../../../test/fixtures/rpc";

// The Agent (MCP) page over PGlite: members only, the owner's form against the chain's view of the vault, the status
// card alone for an approver or a viewer, and no form when the vault's keys cannot be read.

type Captured = { label: string; tx?: WalletTx; confirmTone?: string };
const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  db: null as unknown as Db,
  reader: null as unknown as VaultReader,
  buttons: [] as Captured[],
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
  const { networkPart } = await import("../../../../../test/fixtures/networks");
  return { getEnv: () => networkPart({ defaultNetwork: "mainnet" }) };
});
vi.mock("@/lib/near/server", async () => {
  const { NETWORKS } = await import("@probarion/core");
  const { viewAccount: account } = await import("../../../../../test/fixtures/reader");
  return {
    getReader: () => h.reader,
    getRpc: () => ({ viewAccount: async () => account() }),
    chainConsts: () => NETWORKS.mainnet,
  };
});
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

import AgentPage, { maxDuration, metadata } from "./page";

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
const VAULT = "acme.vaults.probarion.near";
const AGENT = formatPublicKey(new Uint8Array(32).fill(31));
const LEDGER = formatPublicKey(new Uint8Array(32).fill(32));

let pg: PGlite;
silenceLogs();

const scoped = (method: string): AccessKeyState => ({
  exists: true,
  kind: "FunctionCall",
  fullAccess: false,
  allowance: "1000000000000000000000000",
  receiverId: VAULT,
  methodNames: [method],
});

function chain(
  over: { owner?: string; agents?: string[]; ledgerKey?: string | null; down?: boolean } = {},
) {
  h.reader = fakeReader({
    getConfig: async () => {
      if (over.down) throw transportError();
      return vaultConfig({ owner: over.owner ?? "acme.near", ledger_key: over.ledgerKey ?? null });
    },
    listAgents: async () =>
      (over.agents ?? []).map((public_key) => ({
        public_key,
        label: "mcp-claude",
        added_at_ns: "1",
      })),
    accessKey: async (_v, key) => scoped(key === LEDGER ? "anchor" : "spend"),
    ftBalance: async () => "25000000",
  });
}

async function signInAs(account: string) {
  h.jar.set(
    SESSION_COOKIE,
    await createSessionToken(await deriveSubkey(MASTER, "session"), account, "mainnet"),
  );
}
const html = async (vault = VAULT) =>
  renderToStaticMarkup((await AgentPage({ params: Promise.resolve({ vault }) })) as ReactElement)
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"');

beforeAll(async () => {
  pg = await freshDb();
  h.db = pgliteDb(pg);
  const tenant = await seedTenant(pg, {
    vault: VAULT,
    owner: "acme.near",
    approvers: ["cfo.near"],
  });
  await pg.query(
    "insert into public.tenant_members (tenant_id, account_id, role) values ($1, 'viewer.near', 'viewer')",
    [tenant],
  );
});
afterAll(async () => {
  await pg.close();
});
beforeEach(() => {
  h.jar.clear();
  h.buttons.length = 0;
  chain();
});

describe("the Agent (MCP) page", () => {
  it("is titled, and waits for FINAL like the other wallet pages", () => {
    expect(metadata).toEqual({ title: "Agent (MCP)" });
    expect(maxDuration).toBe(60);
  });

  it("is a 404 for a stranger, as for a vault that does not exist", async () => {
    await signInAs("mallory.near");
    await expect(html()).rejects.toMatchObject({ digest: expect.stringMatching(/404/) });
  });

  it("gives the owner the six steps, under the Agent (MCP) tab", async () => {
    await signInAs("acme.near");
    const page = await html();
    // A middle dot, as the other vault tabs write it.
    expect(page).toContain("Connect an AI agent (MCP) \u00b7 you are owner");
    expect(page).toContain(`href="/console/${VAULT}/agent"`);
    expect(page).toContain("Probarion never sees their secrets.");
    expect(page).toContain("Step 1 of 6");
    expect(page).toContain("Check these keys");
    expect(page).toContain(`PROBARION_VAULT_ID=${VAULT}`);
    // MCP_ON_NPM is false until the 0.1.1 release: the clone lines.
    expect(page).toContain("git clone https://github.com/probarion/probarion");
    // Mainnet: no test USDC link.
    expect(page).not.toContain("Add test USDC");
    expect(page).toContain("25.00 USDC");
  });

  it("gives an approver and a viewer the status card only", async () => {
    chain({ agents: [AGENT], ledgerKey: LEDGER });
    for (const who of ["cfo.near", "viewer.near"]) {
      await signInAs(who);
      h.buttons.length = 0;
      const page = await html();
      expect(page, who).toContain("Only the vault's owner can connect an agent.");
      expect(page, who).toContain("Agent key on the vault");
      expect(page, who).not.toContain("Check these keys");
      expect(page, who).not.toContain("<input");
      expect(h.buttons, who).toEqual([]);
    }
  });

  it("reads the agent's keys from the chain: ready rows, and Remove built for this vault", async () => {
    await signInAs("acme.near");
    chain({ agents: [AGENT], ledgerKey: LEDGER });
    const page = await html();
    expect(page).toContain("spend() only, 1.000 NEAR gas left");
    expect(page).toContain("anchor() only, 1.000 NEAR gas left");
    const remove = h.buttons.find((b) => b.label === "Remove this agent key");
    expect(remove?.tx?.receiverId).toBe(VAULT);
    expect(JSON.stringify(remove?.tx)).toContain('"remove_agent"');
    expect(remove?.confirmTone).toBe("danger");
  });

  it("warns the owner by role when the chain names another owner, and offers no wallet button", async () => {
    await signInAs("acme.near");
    chain({ owner: "someone.near", agents: [AGENT] });
    const page = await html();
    expect(page).toContain("The vault's owner on chain is someone.near, not the account you");
    expect(h.buttons).toEqual([]);
  });

  it("offers no form when the vault's keys cannot be read", async () => {
    await signInAs("acme.near");
    chain({ down: true });
    const page = await html();
    expect(page).toContain("The vault's keys could not be read right now");
    expect(page).not.toContain("Check these keys");
    expect(page).not.toContain("Step 1 of 6");
  });

  it("writes nothing", async () => {
    await signInAs("acme.near");
    const before = (await pg.query("select count(*)::int as n from agent_keys")).rows;
    await html();
    expect((await pg.query("select count(*)::int as n from agent_keys")).rows).toEqual(before);
  });
});
