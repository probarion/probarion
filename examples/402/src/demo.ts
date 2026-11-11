// The demo: one buyer agent, two sellers, three calls. A negotiated sale with its payout, a counter below the
// seller's floor that the agent walks away from, and a call the mandate refuses.
//
// Offline (no vault or keys in the environment) it runs on the SDK's test double chain, served on 127.0.0.1,
// with the MCP server in this process and the SDK's public test keys: nothing reaches a network, nothing real
// is paid. With PROBARION_VAULT_ID, PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY set it runs the same three
// calls on NEAR testnet, through the MCP server over stdio, and pays real test USDC.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { NETWORKS } from "@probarion/core";
import { buildPort, createServer, formatUsdc } from "@probarion/mcp";
import { envValue, InMemoryLedgerStore, RpcClient, resolveRpcUrls } from "@probarion/sdk";
import { type CallResult, fetchWithMandate, type MandateRow } from "./agent.js";
import { describeCall } from "./describe.js";
import { forecastData } from "./forecast.js";
import { connectMcp, testnetVault } from "./mcp-stdio.js";
import { chainReader, type RunningPaywall, startPaywall } from "./paywall.js";

type Env = Readonly<Record<string, string | undefined>>;

/** The two sellers, in USDC smallest units. The floors stay in the paywalls. */
export const DEMO_SELLERS = {
  forecast: { path: "/forecast", listUnits: "12000", floorUnits: "9000" },
  premium: { path: "/premium", listUnits: "50000", floorUnits: "30000" },
} as const;

/** The demo must finish within this, offline or on testnet. */
export const DEMO_LIMIT_MS = 120_000;

export class DemoUsageError extends Error {}

export interface DemoIo {
  env: Env;
  out: (line: string) => void;
  /** Milliseconds, for the elapsed-time line. Default performance.now. */
  clock?: () => number;
  /** Where the receipt lines go. Default RECEIPTS_PATH, else a new temp folder offline and receipts.jsonl on testnet. */
  receiptsPath?: string;
}

export interface DemoSummary {
  mode: "offline" | "testnet";
  results: CallResult[];
  /** True when the three calls ended as the demo expects: paid and checked, walked away, refused. */
  ok: boolean;
  /** How many times the agent called request_spend. */
  spendRequests: number;
  /** What the seller's USDC balance grew by, in smallest units. */
  payoutUnits: string;
  receiptsPath: string;
  elapsedMs: number;
}

/** Where the demo runs: the agent's MCP client, an RPC to read the chain, and the seller's account. */
interface Stage {
  mode: "offline" | "testnet";
  client: Client;
  rpc: RpcClient;
  vault: string;
  payee: string;
  intro: string;
  close(): Promise<void>;
}

/** The test double stage: one mandate for the seller, 0.01 USDC a payment, one payment. */
async function offlineStage(): Promise<Stage> {
  // Loaded only offline: the test double chain and the in-process MCP transport are not needed on testnet.
  const [{ InMemoryTransport }, testing] = await Promise.all([
    import("@modelcontextprotocol/sdk/inMemory.js"),
    import("@probarion/sdk/testing"),
  ]);
  const chain = testing.createScenarioChain();
  const m = chain.mandates[0];
  if (m === undefined) throw new Error("the test double scenario has no mandate 1");
  Object.assign(m, {
    max_per_payment: "10000",
    max_total: "10000",
    max_uses: 1,
    approval_above: "10000",
    expires_at_ns: "4102444800000000000",
    label: "TEST DOUBLE 402 demo: 0.01 a payment, 1 payment",
  });
  chain.ftBalances[chain.config.usdc] = { [testing.SCENARIO_VAULT]: "1000000" };
  const rpcServer = await testing.startFakeRpcServer(chain);
  const scenarioNow = new Date(Number(testing.SCENARIO_NOW / 1_000_000n));
  const port = buildPort(
    {
      network: "testnet",
      vault: testing.SCENARIO_VAULT,
      agentKey: testing.TEST_KEYS.agent.secretKey,
      ledgerKey: testing.TEST_KEYS.ledger.secretKey,
      rpcUrls: [rpcServer.url],
      archivalRpcUrls: null,
      agentPublicKey: testing.TEST_KEYS.agent.publicKey,
      ledgerPath: join(tmpdir(), "probarion-402-demo-unused", "ledger.jsonl"),
      readOnly: false,
    },
    {
      now: () => scenarioNow,
      logger: { warn: () => {} },
      onlineVerifier: null,
      archivalRpc: null,
      burnTxHints: new Map(),
    },
    new InMemoryLedgerStore(),
  );
  const server = createServer(port, {
    vault: testing.SCENARIO_VAULT,
    network: "testnet",
    version: "0.0.0-demo",
    readOnly: false,
    agentPublicKey: testing.TEST_KEYS.agent.publicKey,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probarion-402-demo", version: "0.1.0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    mode: "offline",
    client,
    rpc: new RpcClient({ urls: [rpcServer.url] }),
    vault: testing.SCENARIO_VAULT,
    payee: testing.SCENARIO_NEAR_PAYEE,
    intro:
      "Probarion 402 demo, offline: the SDK's test double chain on 127.0.0.1 and its public test keys. No network, nothing real is paid.",
    close: async () => {
      await client.close();
      await server.close();
      await rpcServer.close();
    },
  };
}

async function testnetStage(env: Env, vault: string): Promise<Stage> {
  const client = await connectMcp(env, "probarion-402-demo");
  return {
    mode: "testnet",
    client,
    rpc: new RpcClient({ urls: resolveRpcUrls("testnet", undefined, env) }),
    vault,
    payee: envValue(env, "PAYWALL_PAYEE") ?? "probarion-payee.testnet",
    intro: `Probarion 402 demo on NEAR testnet: vault ${vault}, paid in test USDC.`,
    close: () => client.close(),
  };
}

/** Offline when none of the three is set, testnet when all are; anything else is a usage error. */
function pickMode(env: Env): { mode: "offline" } | { mode: "testnet"; vault: string } {
  const names = ["PROBARION_VAULT_ID", "PROBARION_AGENT_KEY", "PROBARION_LEDGER_KEY"] as const;
  const set = names.filter((n) => envValue(env, n) !== undefined);
  if (set.length === 0) return { mode: "offline" };
  if (set.length < names.length) {
    const missing = names.filter((n) => !set.includes(n)).join(", ");
    throw new DemoUsageError(
      `Set PROBARION_VAULT_ID, PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY together to run on testnet, or none of them to run offline. Missing: ${missing}.`,
    );
  }
  const vault = testnetVault(env);
  if (vault === null) {
    throw new DemoUsageError(
      "The demo runs on testnet only: set PROBARION_VAULT_ID to a .testnet vault.",
    );
  }
  return { mode: "testnet", vault };
}

/** Counts the agent's request_spend calls, to show that walking away asked for none. */
function counting(client: Client): { client: Client; spendRequests: () => number } {
  let n = 0;
  const wrapped = {
    callTool: (params: { name: string }, ...rest: unknown[]) => {
      if (params.name === "request_spend") n += 1;
      return (client.callTool as (...a: unknown[]) => unknown)(params, ...rest);
    },
  } as unknown as Client;
  return { client: wrapped, spendRequests: () => n };
}

async function usdcOf(rpc: RpcClient, account: string): Promise<bigint> {
  return BigInt(
    await rpc.viewFunction<string>(NETWORKS.testnet.usdc, "ft_balance_of", { account_id: account }),
  );
}

function mandateLines(listed: Record<string, unknown>, payee: string): string[] {
  const rows = (listed.mandates as (MandateRow & { max_uses?: number })[]).filter(
    (m) => m.payee_detail.type === "near" && m.payee_detail.account_id === payee,
  );
  if (rows.length === 0) return [`No mandate of this vault pays near:${payee}.`];
  return rows.map(
    (m) =>
      `Mandate ${m.id} (${m.status}) pays near:${payee} at most ${m.max_per_payment_usdc} USDC a payment, ${m.uses_left} of ${m.max_uses ?? "?"} payments left.`,
  );
}

export async function runDemo(io: DemoIo): Promise<DemoSummary> {
  const clock = io.clock ?? (() => performance.now());
  const started = clock();
  const picked = pickMode(io.env);
  const stage =
    picked.mode === "offline" ? await offlineStage() : await testnetStage(io.env, picked.vault);
  const testDouble = stage.mode === "offline";
  const receiptsPath =
    io.receiptsPath ??
    envValue(io.env, "RECEIPTS_PATH") ??
    (testDouble
      ? join(tmpdir(), `probarion-402-demo-${process.pid}-${Date.now()}`, "receipts.jsonl")
      : "receipts.jsonl");
  const paywalls: RunningPaywall[] = [];
  try {
    const reader = chainReader(stage.rpc, "testnet");
    for (const s of [DEMO_SELLERS.forecast, DEMO_SELLERS.premium]) {
      paywalls.push(
        await startPaywall({
          network: "testnet",
          payee: stage.payee,
          priceUnits: s.listUnits,
          floorUnits: s.floorUnits,
          path: s.path,
          data: forecastData,
          reader,
        }),
      );
    }
    const [forecast, premium] = paywalls as [RunningPaywall, RunningPaywall];
    const { client, spendRequests } = counting(stage.client);

    io.out(stage.intro);
    const listed = (await stage.client.callTool({ name: "list_mandates", arguments: {} })) as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    const listedText = listed.content?.[0]?.text ?? "";
    if (listed.isError === true) throw new Error(`list_mandates: ${listedText}`);
    for (const line of mandateLines(JSON.parse(listedText), stage.payee)) io.out(line);
    io.out(
      `Sellers (paid at near:${stage.payee}): GET /forecast lists at ${formatUsdc(DEMO_SELLERS.forecast.listUnits)} USDC, GET /premium at ${formatUsdc(DEMO_SELLERS.premium.listUnits)}. Each has a floor it does not send.`,
    );

    const payeeBefore = await usdcOf(stage.rpc, stage.payee);
    const vaultBefore = await usdcOf(stage.rpc, stage.vault);
    const opts = { receiptsPath, testDouble };
    const results: CallResult[] = [];
    const steps: [string, RunningPaywall][] = [
      ["1. A negotiated sale", forecast],
      ["2. A counter below the seller's floor", premium],
      ["3. A call the mandate refuses", forecast],
    ];
    for (const [n, [title, paywall]] of steps.entries()) {
      io.out("");
      io.out(title);
      const r = await fetchWithMandate(paywall.url, client, opts);
      results.push(r);
      io.out(describeCall(`#${n + 1}`, r, { testDouble }));
      if (r.kind === "paid" && r.receipt !== null) {
        io.out(`   Receipt, appended to ${receiptsPath}:`);
        io.out(`   ${JSON.stringify(r.receipt)}`);
      }
    }
    const [sale, away, refusal] = results;
    // On testnet an RPC node of the pool may answer from a block before the payment: read again a few times.
    const expected = sale?.kind === "paid" ? BigInt(sale.deal.priceUnits) : 0n;
    let payout = (await usdcOf(stage.rpc, stage.payee)) - payeeBefore;
    for (let n = 0; stage.mode === "testnet" && payout < expected && n < 5; n++) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      payout = (await usdcOf(stage.rpc, stage.payee)) - payeeBefore;
    }
    const spent = vaultBefore - (await usdcOf(stage.rpc, stage.vault));

    const ok =
      sale?.kind === "paid" &&
      sale.status === 200 &&
      sale.deal.countered &&
      sale.deal.counteredQuoteId !== null &&
      sale.dataCheck?.ok === true &&
      away?.kind === "walked_away" &&
      refusal?.kind === "refused" &&
      spendRequests() === 2 &&
      payout === BigInt(sale.deal.priceUnits);

    io.out("");
    io.out(
      `request_spend was called ${spendRequests()} times: for calls 1 and 3, and not for the walk-away.`,
    );
    io.out(
      `Payout: near:${stage.payee} got ${formatUsdc(payout.toString())} USDC; the vault paid ${formatUsdc(spent.toString())} USDC in all.`,
    );
    io.out(ok ? "All three calls ended as expected." : "NOT as expected: read the lines above.");
    const elapsedMs = clock() - started;
    io.out(
      `Demo finished in ${(elapsedMs / 1000).toFixed(1)} s (limit ${DEMO_LIMIT_MS / 1000} s).`,
    );
    return {
      mode: stage.mode,
      results,
      ok: ok && elapsedMs < DEMO_LIMIT_MS,
      spendRequests: spendRequests(),
      payoutUnits: payout.toString(),
      receiptsPath,
      elapsedMs,
    };
  } finally {
    for (const p of paywalls) await p.close();
    await stage.close();
  }
}
