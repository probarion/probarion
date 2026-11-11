// The tools end to end over the real SDK: Probarion against the SDK's fake chain over JSON-RPC. Every spend
// below is decided by decide(), checked by the fake contract and written to a signed ledger.
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEntry } from "@probarion/core";
import { InMemoryLedgerStore, type ProbarionDeps } from "@probarion/sdk";
import {
  createScenarioChain,
  type FakeRpcServer,
  SCENARIO_NOW,
  SCENARIO_VAULT,
  startFakeRpcServer,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpConfig } from "../src/config.js";
import { buildPort } from "../src/probarion-port.js";
import { connect, isError, jsonOf, textOf } from "./helpers.js";

const NOW = new Date(Number(SCENARIO_NOW / 1_000_000n));
const INVOICE = "c".repeat(64);

let server: FakeRpcServer;
let warnings: string[];

beforeEach(async () => {
  server = await startFakeRpcServer(createScenarioChain());
  warnings = [];
});
afterEach(async () => {
  await server.close();
});

function cfg(over: Partial<McpConfig> = {}): McpConfig {
  return {
    network: "testnet",
    vault: SCENARIO_VAULT,
    agentKey: TEST_KEYS.agent.secretKey,
    ledgerKey: TEST_KEYS.ledger.secretKey,
    rpcUrls: [server.url],
    archivalRpcUrls: null,
    agentPublicKey: TEST_KEYS.agent.publicKey,
    ledgerPublicKey: TEST_KEYS.ledger.publicKey,
    keysSource: "env",
    ledgerPath: join(tmpdir(), "probarion-mcp-unused", "ledger.jsonl"),
    readOnly: false,
    ...over,
  };
}

const deps = (): ProbarionDeps => ({
  now: () => NOW,
  logger: { warn: (m) => warnings.push(m) },
  onlineVerifier: null,
  evidenceDir: join(tmpdir(), "probarion-no-evidence-here"),
  archivalRpc: null,
  burnTxHints: new Map(),
});

async function open(ledger = new InMemoryLedgerStore(), over: Partial<McpConfig> = {}) {
  const c = cfg(over);
  const port = buildPort(c, deps(), ledger);
  return {
    ledger,
    ...(await connect(port, {
      vault: c.vault,
      network: c.network,
      readOnly: c.readOnly,
      agentPublicKey: c.agentPublicKey,
    })),
  };
}

function spendTxCount(): number {
  let n = 0;
  for (const outcome of server.chain.txs.values()) {
    const tx = outcome.transaction as { actions?: { FunctionCall?: { method_name?: string } }[] };
    if (tx.actions?.[0]?.FunctionCall?.method_name === "spend") n += 1;
  }
  return n;
}

const pay = (over: Record<string, unknown> = {}) => ({
  name: "request_spend",
  arguments: {
    mandate_id: 1,
    amount: "25",
    invoice_hash: INVOICE,
    ref: "vendor:INV-1",
    reasoning: "Design retainer for November per PO-1001",
    ...over,
  },
});

describe("probarion-mcp over the SDK", () => {
  it("lists the vault's mandates and dry-runs a payment with the contract's check_spend", async () => {
    const { client, close } = await open();
    const list = jsonOf(await client.callTool({ name: "list_mandates", arguments: {} }));
    expect((list.mandates as { id: number; payee: string }[]).map((m) => [m.id, m.payee])).toEqual([
      [1, "NEAR account vendor.testnet"],
      [2, expect.stringMatching(/^base address 0x2222/)],
    ]);
    const ok = jsonOf(
      await client.callTool({
        name: "check_spend",
        arguments: { mandate_id: 1, amount: "25", invoice_hash: INVOICE, ref: "r1" },
      }),
    );
    expect(ok).toMatchObject({ ok: true, code: null, would_hold: false, amount_units: "25000000" });
    const over = jsonOf(
      await client.callTool({
        name: "check_spend",
        arguments: { mandate_id: 1, amount: "101", invoice_hash: INVOICE, ref: "r1" },
      }),
    );
    expect(over).toMatchObject({ ok: false, code: "OverPerPayment" });
    expect(spendTxCount()).toBe(0);
    await close();
  });

  it("pays the mandate's payee, writes a signed decision with the MCP reasoning, and reads the spend back", async () => {
    const { client, close, ledger } = await open();
    const out = jsonOf(await client.callTool(pay()));
    expect(out).toMatchObject({ status: "paid", spend_id: 1, code: null, amount_usdc: "25.00" });
    expect(out.explorer).toMatch(/^https:\/\/testnet\.nearblocks\.io\/txns\//);
    expect(spendTxCount()).toBe(1);

    const entries: LedgerEntry[] = await ledger.all();
    const decision = entries.find((e) => e.body.kind === "decision");
    expect(decision?.body).toMatchObject({
      verdict: "allow",
      decided_by: "rules-only",
      mandate_id: 1,
      amount: "25000000",
      proposal: {
        action: "pay",
        payee_hint: null,
        reasoning: "mcp: Design retainer for November per PO-1001",
      },
    });
    expect(server.chain.spends[0]?.destination).toEqual({
      type: "near",
      account_id: "vendor.testnet",
    });
    expect(server.chain.spends[0]?.decision_hash).toBe(decision?.body_hash);

    const status = jsonOf(
      await client.callTool({ name: "get_spend_status", arguments: { spend_id: 1 } }),
    );
    expect(status).toMatchObject({
      spend_id: 1,
      status: "paid",
      ref: "vendor:INV-1",
      destination: "NEAR account vendor.testnet",
    });
    await close();
  });

  it("refuses a second payment of the same ref or invoice by code, and sends nothing", async () => {
    const { client, close } = await open();
    expect(jsonOf(await client.callTool(pay())).status).toBe("paid");
    const sameRef = jsonOf(await client.callTool(pay({ invoice_hash: "d".repeat(64) })));
    const sameInvoice = jsonOf(await client.callTool(pay({ ref: "vendor:INV-1b" })));
    expect(sameRef).toMatchObject({ status: "refused_by_code", spend_id: null, tx_hash: null });
    // The retry under the first ref names the spend that already paid it, so the agent does not pay again.
    expect(sameRef.earlier_spend).toMatchObject({
      spend_id: 1,
      status: "paid",
      ref: "vendor:INV-1",
    });
    expect(sameRef.note).toContain("already has spend 1");
    expect(sameInvoice.earlier_spend).toBeUndefined();
    expect(sameInvoice).toMatchObject({
      status: "refused_by_code",
      code: "invoice.duplicate",
      tx_hash: null,
    });
    expect(spendTxCount()).toBe(1);
    await close();
  });

  it("refuses an amount over the mandate's per-payment cap by code, in the ledger", async () => {
    const { client, close, ledger } = await open();
    const out = jsonOf(await client.callTool(pay({ amount: "100.01" })));
    expect(out).toMatchObject({ status: "refused_by_code", code: "mandate.over_per_payment" });
    expect(spendTxCount()).toBe(0);
    expect((await ledger.all()).map((e) => e.body.verdict)).toEqual(["refuse"]);
    await close();
  });

  it("verify passes on the vault after an MCP payment", async () => {
    const { client, close } = await open();
    await client.callTool(pay());
    const report = jsonOf(await client.callTool({ name: "verify", arguments: {} }));
    expect(report).toMatchObject({ ok: true, vault: SCENARIO_VAULT, entries: 2 });
    await close();
  });

  it("read-only: lists and dry-runs with the mandate's agent key, and refuses to pay", async () => {
    const { client, close } = await open(new InMemoryLedgerStore(), {
      agentKey: null,
      ledgerKey: null,
      readOnly: true,
    });
    const check = jsonOf(
      await client.callTool({
        name: "check_spend",
        arguments: { mandate_id: 1, amount: "25", invoice_hash: INVOICE, ref: "r1" },
      }),
    );
    expect(check).toMatchObject({ ok: true });
    const r = await client.callTool(pay());
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/read-only/);
    expect(spendTxCount()).toBe(0);
    await close();
  });

  it("a second server with its own ledger file is refused before it spends (LEDGER_FORK_RISK)", async () => {
    const first = await open();
    expect(jsonOf(await first.client.callTool(pay())).status).toBe("paid");
    expect(server.chain.anchors.length).toBeGreaterThan(0);
    await first.close();

    const second = await open(new InMemoryLedgerStore());
    const r = await second.client.callTool(
      pay({ ref: "vendor:INV-2", invoice_hash: "e".repeat(64) }),
    );
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(
      /LEDGER_FORK_RISK: anchor 1 covers 2 entries but the local ledger has 0/,
    );
    expect(spendTxCount()).toBe(1);
    await second.close();
  });
});
