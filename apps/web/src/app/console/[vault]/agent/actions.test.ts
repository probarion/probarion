import type { PGlite } from "@electric-sql/pglite";
import { formatPublicKey, formatSignature } from "@probarion/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import type { VaultReader } from "@/lib/near/reader";
import { freshDb, seedTenant } from "../../../../../test/db/harness";
import { silenceLogs } from "../../../../../test/db/keys-helpers";
import { pgliteDb } from "../../../../../test/db/pglite-db";
import { fakeReader, vaultConfig } from "../../../../../test/fixtures/reader";
import { transportError } from "../../../../../test/fixtures/rpc";

// The Agent (MCP) tab's two wallet calls, end to end over PGlite: owner only (the membership row, then the chain's
// owner), the key parsed again and checked against the chain as it is at click time, the transaction built for the
// member's own vault, and a pasted secret refused before anything is read, logged or returned. Neither action writes.

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  db: null as unknown as Db,
  reader: null as unknown as VaultReader,
  /** Every vault id the chain was asked about. */
  asked: [] as string[],
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
vi.mock("@/lib/near/server", () => ({ getReader: () => h.reader }));

import { KEY_ERRORS } from "@/lib/agent/connect";
import { keyAllowances } from "@/lib/config";
import { generateKey } from "@/lib/keys/service";
import { prepareAddAgentAction, prepareSetLedgerKeyAction } from "./actions";

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
const VAULT = "acme.vaults.probarion.near";
const OTHER = "other.vaults.probarion.near";
const HOSTED_VAULT = "hosted.vaults.probarion.near";

const pk = (n: number) => formatPublicKey(new Uint8Array(32).fill(n));
const AGENT = pk(11);
const LEDGER = pk(12);
const UNUSED = pk(13);
const SECRET = formatSignature(new Uint8Array(64).fill(9));
const SECRET_BODY = SECRET.slice("ed25519:".length);

let pg: PGlite;
let hostedTenant: string;
const logs = silenceLogs();

/** The vault as the chain shows it: its config, its agent keys and its anchors. Every read is recorded. */
function chain(
  over: {
    owner?: string;
    ledgerKey?: string | null;
    agents?: string[];
    anchoredBy?: string | null;
    down?: boolean;
  } = {},
) {
  const seen =
    <T>(run: () => T) =>
    async (vault: string) => {
      h.asked.push(vault);
      if (over.down) throw transportError();
      return run();
    };
  h.reader = fakeReader({
    getConfig: seen(() =>
      vaultConfig({ owner: over.owner ?? "acme.near", ledger_key: over.ledgerKey ?? null }),
    ),
    listAgents: seen(() =>
      (over.agents ?? []).map((public_key) => ({ public_key, label: "mcp", added_at_ns: "1" })),
    ),
    listAnchors: seen(() =>
      over.anchoredBy ? [{ seq: 0, root: "r", ledger_key: over.anchoredBy, at_ns: "1" }] : [],
    ) as unknown as VaultReader["listAnchors"],
  });
}

async function signInAs(account: string) {
  h.jar.set(
    SESSION_COOKIE,
    await createSessionToken(await deriveSubkey(MASTER, "session"), account, "mainnet"),
  );
}
const rows = async () =>
  (await pg.query<{ n: number }>("select count(*)::int as n from agent_keys")).rows[0]?.n;

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
  await seedTenant(pg, { vault: OTHER, owner: "mallory.near" });
  // HOSTED_VAULT runs hosted Payables: it has an active ledger key the console made.
  hostedTenant = await seedTenant(pg, { vault: HOSTED_VAULT, owner: "acme.near" });
  const { id } = await generateKey(h.db, MASTER, {
    tenantId: hostedTenant,
    purpose: "ledger",
    label: "ledger",
    createdBy: "acme.near",
  });
  await h.db.rpc("agent_key_set_status", {
    tenant_id: hostedTenant,
    id,
    from: "pending",
    status: "active",
  });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(() => {
  h.jar.clear();
  h.asked.length = 0;
  chain();
});

describe("who may prepare the two calls", () => {
  it("answers 401 signed out, and 403 for an approver, a viewer and a stranger, before any chain read", async () => {
    expect(await prepareAddAgentAction(VAULT, AGENT, "mcp")).toMatchObject({ status: 401 });
    for (const who of ["cfo.near", "viewer.near", "mallory.near"]) {
      await signInAs(who);
      expect(await prepareAddAgentAction(VAULT, AGENT, "mcp"), who).toMatchObject({
        status: 403,
      });
      expect(await prepareSetLedgerKeyAction(VAULT, LEDGER, null), who).toMatchObject({
        status: 403,
      });
    }
    // Another owner's vault is as closed as one that does not exist.
    await signInAs("acme.near");
    expect(await prepareAddAgentAction(OTHER, AGENT, "mcp")).toMatchObject({ status: 403 });
    expect(await prepareAddAgentAction("nope.vaults.probarion.near", AGENT, "mcp")).toMatchObject({
      status: 403,
    });
    expect(h.asked).toEqual([]);
  });

  it("refuses the owner by role when the chain names another owner", async () => {
    await signInAs("acme.near");
    chain({ owner: "someone.near" });
    const add = await prepareAddAgentAction(VAULT, AGENT, "mcp");
    const set = await prepareSetLedgerKeyAction(VAULT, LEDGER, null);
    for (const r of [add, set]) {
      expect(r).toMatchObject({ status: 403 });
      expect((r as { error: string }).error).toMatch(/owner on chain is not the account/);
    }
  });
});

describe("prepareAddAgentAction", () => {
  beforeEach(async () => {
    await signInAs("acme.near");
  });

  it("returns add_agent for the member's own vault: the pasted key, the label, spend() only and the tenant's allowance", async () => {
    const before = await rows();
    const tx = await prepareAddAgentAction(VAULT, `  ${AGENT} `, "mcp-claude");
    expect(tx).toMatchObject({ receiverId: VAULT });
    const json = JSON.stringify(tx);
    expect(json).toContain('"add_agent"');
    expect(json).toContain(AGENT);
    expect(json).toContain("mcp-claude");
    expect(json).toContain(keyAllowances("external").agentAllowanceYocto);
    // It read this vault's chain, and wrote nothing.
    expect(new Set(h.asked)).toEqual(new Set([VAULT]));
    expect(await rows()).toBe(before);
    expect(logs.lines.some((l) => l.includes("agent.add_prepared"))).toBe(true);
  });

  it("refuses a pasted secret before any read, and never logs or returns any of it", async () => {
    const r = await prepareAddAgentAction(VAULT, SECRET, "mcp");
    expect(r).toEqual({ error: KEY_ERRORS.secret });
    const r2 = await prepareSetLedgerKeyAction(VAULT, SECRET, null);
    expect(r2).toEqual({ error: KEY_ERRORS.secret });
    expect(h.asked).toEqual([]);
    const everything = [JSON.stringify(r), JSON.stringify(r2), ...logs.lines].join("\n");
    expect(everything).not.toContain(SECRET_BODY);
    expect(everything).not.toContain(SECRET_BODY.slice(20, 50));
  });

  it("refuses a key as the label, before any read: a label is public on the vault", async () => {
    // What a field cut at 64 characters keeps of a pasted secret: enough to narrow its seed to a couple of candidates.
    for (const label of [SECRET.slice(0, 64), SECRET, AGENT]) {
      const r = await prepareAddAgentAction(VAULT, AGENT, label);
      expect(r).toEqual({ error: KEY_ERRORS.labelIsKey });
    }
    expect(h.asked).toEqual([]);
    const everything = logs.lines.join("\n");
    expect(everything).not.toContain(SECRET_BODY.slice(0, 40));
    expect(everything).not.toContain(SECRET_BODY.slice(20, 50));
  });

  it("refuses what is not a public key, and a label over 64 bytes", async () => {
    expect(await prepareAddAgentAction(VAULT, "hello", "mcp")).toEqual({
      error: KEY_ERRORS.notPublic,
    });
    expect(await prepareAddAgentAction(VAULT, AGENT, "x".repeat(65))).toMatchObject({
      error: expect.any(String),
    });
    expect(h.asked).toEqual([]);
  });

  it("says when the key is already on the vault, and refuses the vault's ledger key or a 17th key", async () => {
    chain({ agents: [AGENT] });
    expect(await prepareAddAgentAction(VAULT, AGENT, "mcp")).toEqual({ error: KEY_ERRORS.onVault });
    chain({ ledgerKey: AGENT });
    expect(await prepareAddAgentAction(VAULT, AGENT, "mcp")).toEqual({
      error: KEY_ERRORS.agentIsLedger,
    });
    chain({ agents: Array.from({ length: 16 }, (_, i) => pk(100 + i)) });
    expect(await prepareAddAgentAction(VAULT, AGENT, "mcp")).toEqual({ error: KEY_ERRORS.full });
  });

  it("still adds the agent key to a vault whose ledger hosted Payables keeps", async () => {
    expect(await prepareAddAgentAction(HOSTED_VAULT, AGENT, "mcp")).toMatchObject({
      receiverId: HOSTED_VAULT,
    });
  });

  it("refuses a key Probarion made for hosted Payables", async () => {
    const hosted = (
      await pg.query<{ public_key: string }>(
        "select public_key from agent_keys where tenant_id = $1",
        [hostedTenant],
      )
    ).rows[0]?.public_key;
    expect(hosted).toBeDefined();
    expect(await prepareAddAgentAction(HOSTED_VAULT, hosted ?? "", "mcp")).toEqual({
      error: KEY_ERRORS.hosted,
    });
  });

  it("prepares nothing when the chain cannot be read", async () => {
    chain({ down: true });
    expect(await prepareAddAgentAction(VAULT, AGENT, "mcp")).toMatchObject({
      error: expect.stringMatching(/cannot be read right now/),
    });
  });
});

describe("prepareSetLedgerKeyAction", () => {
  beforeEach(async () => {
    await signInAs("acme.near");
  });

  it("returns set_ledger_key for the member's own vault, anchor() only, with the tenant's allowance", async () => {
    const before = await rows();
    const tx = await prepareSetLedgerKeyAction(VAULT, LEDGER, null);
    expect(tx).toMatchObject({ receiverId: VAULT });
    const json = JSON.stringify(tx);
    expect(json).toContain('"set_ledger_key"');
    expect(json).toContain(LEDGER);
    expect(json).toContain(keyAllowances("external").ledgerAllowanceYocto);
    expect(await rows()).toBe(before);
  });

  it("replaces an unused ledger key only when the page asked about that very key", async () => {
    chain({ ledgerKey: UNUSED });
    expect(await prepareSetLedgerKeyAction(VAULT, LEDGER, null)).toMatchObject({
      error: expect.stringMatching(/changed since this page loaded/),
    });
    expect(await prepareSetLedgerKeyAction(VAULT, LEDGER, pk(99))).toMatchObject({
      error: expect.stringMatching(/changed since this page loaded/),
    });
    expect(await prepareSetLedgerKeyAction(VAULT, LEDGER, UNUSED)).toMatchObject({
      receiverId: VAULT,
    });
    // And a confirm for a replacement is refused when there is nothing to replace any more.
    chain();
    expect(await prepareSetLedgerKeyAction(VAULT, LEDGER, UNUSED)).toMatchObject({
      error: expect.stringMatching(/changed since this page loaded/),
    });
  });

  it("withholds the ledger key from a vault anchored by another key, or whose ledger hosted Payables keeps", async () => {
    chain({ ledgerKey: UNUSED, anchoredBy: UNUSED });
    expect(await prepareSetLedgerKeyAction(VAULT, LEDGER, UNUSED)).toMatchObject({
      error: expect.stringMatching(/fork its history/),
    });
    chain();
    expect(await prepareSetLedgerKeyAction(HOSTED_VAULT, LEDGER, null)).toMatchObject({
      error: expect.stringMatching(/hosted Payables/),
    });
  });

  it("says when the key already is the vault's, and refuses one that is an agent key", async () => {
    chain({ ledgerKey: LEDGER });
    expect(await prepareSetLedgerKeyAction(VAULT, LEDGER, null)).toEqual({
      error: "This key is already the vault's ledger key.",
    });
    chain({ agents: [LEDGER] });
    expect(await prepareSetLedgerKeyAction(VAULT, LEDGER, null)).toEqual({
      error: KEY_ERRORS.ledgerIsAgent,
    });
  });
});
