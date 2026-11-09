// The whole example on the SDK's fake chain: the agent pays 20 calls through the MCP tools under a mandate of
// 20 uses, and the 21st is refused by Probarion's rules (and the contract's dry run agrees). Nothing here
// touches a real network.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildPort, createServer } from "@probarion/mcp";
import { InMemoryLedgerStore, RpcClient } from "@probarion/sdk";
import {
  createScenarioChain,
  type FakeRpcServer,
  SCENARIO_NEAR_PAYEE,
  SCENARIO_NOW,
  SCENARIO_VAULT,
  startFakeRpcServer,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CallResult, fetchWithMandate } from "../src/agent.js";
import { chainReader, startPaywall } from "../src/paywall.js";

const NOW = new Date(Number(SCENARIO_NOW / 1_000_000n));

let rpc: FakeRpcServer;
let cleanup: (() => Promise<void>)[] = [];

beforeEach(async () => {
  const chain = createScenarioChain();
  const m = chain.mandates[0];
  if (m === undefined) throw new Error("the scenario has no mandate 1");
  // Mandate 1 as the owner would sign it for pay-per-call: 0.01 USDC a call, 20 calls, nothing held.
  Object.assign(m, {
    max_per_payment: "10000",
    max_total: "200000",
    max_uses: 20,
    approval_above: "10000",
    label: "TEST DOUBLE forecast API, pay per call",
  });
  chain.ftBalances[chain.config.usdc] = { [SCENARIO_VAULT]: "1000000" };
  rpc = await startFakeRpcServer(chain);
});
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
  await rpc.close();
});

async function agentTools(): Promise<Client> {
  const port = buildPort(
    {
      network: "testnet",
      vault: SCENARIO_VAULT,
      agentKey: TEST_KEYS.agent.secretKey,
      ledgerKey: TEST_KEYS.ledger.secretKey,
      rpcUrls: [rpc.url],
      archivalRpcUrls: null,
      agentPublicKey: TEST_KEYS.agent.publicKey,
      ledgerPath: join(tmpdir(), "probarion-402-unused", "ledger.jsonl"),
      readOnly: false,
    },
    {
      now: () => NOW,
      logger: { warn: () => {} },
      onlineVerifier: null,
      archivalRpc: null,
      burnTxHints: new Map(),
    },
    new InMemoryLedgerStore(),
  );
  const server = createServer(port, {
    vault: SCENARIO_VAULT,
    network: "testnet",
    version: "0.0.0-test",
    readOnly: false,
    agentPublicKey: TEST_KEYS.agent.publicKey,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probarion-402-test", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function paywall(payee = SCENARIO_NEAR_PAYEE) {
  const p = await startPaywall({
    network: "testnet",
    payee,
    priceUnits: "10000",
    path: "/forecast",
    data: (call) => ({ call, forecast_c: [31, 30, 29] }),
    reader: chainReader(new RpcClient({ urls: [rpc.url] }), "testnet"),
  });
  cleanup.push(p.close);
  return p;
}

const spendTxs = () =>
  [...rpc.chain.txs.values()].filter(
    (o) =>
      (o.transaction as { actions?: { FunctionCall?: { method_name?: string } }[] }).actions?.[0]
        ?.FunctionCall?.method_name === "spend",
  ).length;

describe("pay per call under a mandate of 20 uses", () => {
  it("pays and serves 20 calls, then refuses the 21st by code, and the contract agrees", async () => {
    const tools = await agentTools();
    const p = await paywall();
    const results: CallResult[] = [];
    for (let n = 0; n < 21; n++) results.push(await fetchWithMandate(p.url, tools));

    const paid = results.slice(0, 20);
    for (const [i, r] of paid.entries()) {
      expect(r).toMatchObject({ kind: "paid", status: 200, body: { data: { call: i + 1 } } });
    }
    expect(paid.map((r) => (r.kind === "paid" ? r.spend.spend_id : null))).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(results[20]).toMatchObject({
      kind: "refused",
      priceUsdc: "0.01",
      spend: { status: "refused_by_code", code: "mandate.uses_exhausted", tx_hash: null },
      contract: { ok: false, code: "UsesExhausted" },
    });

    expect(p.served()).toBe(20);
    expect(spendTxs()).toBe(20);
    const m = rpc.chain.mandates[0];
    expect(m).toMatchObject({ uses: 20, spent: "200000", reserved: "0" });
    expect(rpc.chain.ftBalances[rpc.chain.config.usdc]).toMatchObject({
      [SCENARIO_VAULT]: "800000",
      [SCENARIO_NEAR_PAYEE]: "200000",
    });
  }, 120_000);

  it("pays nothing when the 402 names a payee that no mandate pays", async () => {
    const tools = await agentTools();
    const p = await paywall("attacker.testnet");
    expect(await fetchWithMandate(p.url, tools)).toEqual({
      kind: "no_mandate",
      payee: "attacker.testnet",
    });
    expect(spendTxs()).toBe(0);
  });

  it("a paid spend cannot be shown again for a second call", async () => {
    const tools = await agentTools();
    const p = await paywall();
    const first = await fetchWithMandate(p.url, tools);
    expect(first).toMatchObject({ kind: "paid", status: 200 });
    const offer = (await (await fetch(p.url)).json()) as { quote: string; redeem_token: string };
    const id = /id: (\S+)/.exec(offer.quote)?.[1] ?? "";
    const replay = await fetch(p.url, {
      headers: {
        "x-probarion-quote": id,
        "x-probarion-redeem": offer.redeem_token,
        "x-probarion-vault": SCENARIO_VAULT,
        "x-probarion-spend": "1",
      },
    });
    expect(replay.status).toBe(402);
    expect(((await replay.json()) as { reason: string }).reason).toBe(
      "spend_does_not_pay_this_quote",
    );
    expect(p.served()).toBe(1);
  });
});
