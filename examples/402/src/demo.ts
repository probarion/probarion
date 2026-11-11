// The demo: one buyer agent, three sellers, three calls, under a mandate of one payment of at most 0.01 USDC.
// A counter below the seller's floor that the agent walks away from, a negotiated sale with its payout, and a
// call within the cap that the mandate refuses, its one payment used.
//
// By default it runs offline, whatever the environment holds: on the SDK's test double chain, served on
// 127.0.0.1, with the MCP server in this process and the SDK's public test keys. Nothing reaches a network and
// nothing real is paid. With `--testnet` (and PROBARION_VAULT_ID, PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY
// set) it runs the same three calls on NEAR testnet, through the MCP server over stdio, and pays real test USDC.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { NETWORKS } from "@probarion/core";
import { buildPort, createServer, formatUsdc } from "@probarion/mcp";
import { envValue, InMemoryLedgerStore, RpcClient, resolveRpcUrls } from "@probarion/sdk";
import { type CallResult, fetchWithMandate, type MandateRow } from "./agent.js";
import { describeCall } from "./describe.js";
import { forecastData } from "./forecast.js";
import { connectMcp, ledgerLine, receiptsPathOf, testnetVault } from "./mcp-stdio.js";
import { chainReader, type RunningPaywall, startPaywall } from "./paywall.js";

type Env = Readonly<Record<string, string | undefined>>;

/** The three sellers, in the order the demo calls them, in USDC smallest units. The floors stay in the paywalls. */
export const DEMO_SELLERS = {
  premium: { path: "/premium", listUnits: "50000", floorUnits: "30000" },
  forecast: { path: "/forecast", listUnits: "12000", floorUnits: "9000" },
  basic: { path: "/basic", listUnits: "10000", floorUnits: "10000" },
} as const;

/** The demo must finish within this, offline or on testnet. */
export const DEMO_LIMIT_MS = 120_000;

/** The keys that make a testnet run. Offline they are not read, only named when they are set. */
const TESTNET_KEYS = ["PROBARION_VAULT_ID", "PROBARION_AGENT_KEY", "PROBARION_LEDGER_KEY"] as const;

/** How the refusal of call 3 is named: by Probarion's rules, or by the contract when the rules' read lags. */
const USES_REFUSALS: ReadonlySet<string> = new Set(["mandate.uses_exhausted", "UsesExhausted"]);

export class DemoUsageError extends Error {}

/** True for the arguments `--testnet` (pnpm may pass a `--` before it), false for none; else a usage error. */
export function testnetFlag(args: readonly string[]): boolean {
  const given = args.filter((a) => a !== "--");
  if (given.length === 0) return false;
  if (given.length === 1 && given[0] === "--testnet") return true;
  throw new DemoUsageError(
    `Usage: pnpm --filter @probarion/example-402 run demo [--testnet]. Unknown arguments: ${given.join(" ")}`,
  );
}

export interface DemoIo {
  env: Env;
  out: (line: string) => void;
  /** Run on NEAR testnet (`run demo --testnet`). Otherwise the demo runs offline, whatever `env` holds. */
  testnet?: boolean;
  /** Milliseconds, for the elapsed-time line. Default performance.now. */
  clock?: () => number;
}

export interface DemoSummary {
  mode: "offline" | "testnet";
  results: CallResult[];
  /**
   * True when the three calls ended as the demo expects (a walk-away from a 409 below_floor, a paid and
   * checked sale with its payout, a refusal for the mandate's uses that the contract's dry run shares) within
   * the time limit.
   */
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
  intro: string[];
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
    intro: [
      "Probarion 402 demo, offline: the SDK's test double chain on 127.0.0.1 and its public test keys. No network, nothing real is paid.",
    ],
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
    intro: [
      `Probarion 402 demo on NEAR testnet: vault ${vault}, paid in test USDC.`,
      ledgerLine(env, vault),
    ],
    close: () => client.close(),
  };
}

type Mode = { mode: "offline"; unused: string[] } | { mode: "testnet"; vault: string };

/**
 * Offline unless `--testnet` was asked for; offline, the testnet keys and RECEIPTS_PATH are not read, only
 * named when set. On testnet all three keys must be set, with a .testnet vault.
 */
function pickMode(io: DemoIo): Mode {
  if (io.testnet !== true) {
    const unused = [...TESTNET_KEYS, "RECEIPTS_PATH"].filter(
      (n) => envValue(io.env, n) !== undefined,
    );
    return { mode: "offline", unused };
  }
  const missing = TESTNET_KEYS.filter((n) => envValue(io.env, n) === undefined);
  if (missing.length > 0) {
    throw new DemoUsageError(
      `--testnet needs PROBARION_VAULT_ID, PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY. Missing: ${missing.join(", ")}.`,
    );
  }
  const vault = testnetVault(io.env);
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
  const picked = pickMode(io);
  const stage =
    picked.mode === "offline" ? await offlineStage() : await testnetStage(io.env, picked.vault);
  const testDouble = stage.mode === "offline";
  // Offline, the receipts always go to a new temp folder: a test double line never joins a testnet file.
  const receiptsPath = testDouble
    ? join(tmpdir(), `probarion-402-demo-${process.pid}-${Date.now()}`, "receipts.jsonl")
    : receiptsPathOf(io.env);
  const paywalls: RunningPaywall[] = [];
  try {
    const reader = chainReader(stage.rpc, "testnet");
    for (const s of [DEMO_SELLERS.premium, DEMO_SELLERS.forecast, DEMO_SELLERS.basic]) {
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
    const [premium, forecast, basic] = paywalls as [RunningPaywall, RunningPaywall, RunningPaywall];
    const { client, spendRequests } = counting(stage.client);

    for (const line of stage.intro) io.out(line);
    if (picked.mode === "offline" && picked.unused.length > 0) {
      io.out(
        `${picked.unused.join(", ")} ${picked.unused.length === 1 ? "is" : "are"} set and not used: this run is offline, and its receipts go to a temp folder. Add --testnet to run on testnet.`,
      );
    }
    if (!testDouble) io.out(`Receipts: ${receiptsPath}`);
    const listed = (await stage.client.callTool({ name: "list_mandates", arguments: {} })) as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    const listedText = listed.content?.[0]?.text ?? "";
    if (listed.isError === true) throw new Error(`list_mandates: ${listedText}`);
    for (const line of mandateLines(JSON.parse(listedText), stage.payee)) io.out(line);
    io.out(
      `Sellers (paid at near:${stage.payee}): GET /premium lists at ${formatUsdc(DEMO_SELLERS.premium.listUnits)} USDC, GET /forecast at ${formatUsdc(DEMO_SELLERS.forecast.listUnits)}, GET /basic at ${formatUsdc(DEMO_SELLERS.basic.listUnits)}. Each has a floor it does not send.`,
    );

    const payeeBefore = await usdcOf(stage.rpc, stage.payee);
    const vaultBefore = await usdcOf(stage.rpc, stage.vault);
    const opts = { receiptsPath, testDouble };
    const results: CallResult[] = [];
    // The walk-away comes first, under the live mandate: after the sale the mandate has no payment left, and
    // the agent does not counter under a mandate that cannot pay.
    const steps: [string, RunningPaywall][] = [
      ["1. A counter below the seller's floor", premium],
      ["2. A negotiated sale", forecast],
      ["3. A call the mandate refuses", basic],
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
    const [away, sale, refusal] = results;
    // On testnet an RPC node of the pool may answer from a block before the payment: read again a few times.
    const expected = sale?.kind === "paid" ? BigInt(sale.deal.priceUnits) : 0n;
    let payout = (await usdcOf(stage.rpc, stage.payee)) - payeeBefore;
    for (let n = 0; stage.mode === "testnet" && payout < expected && n < 5; n++) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      payout = (await usdcOf(stage.rpc, stage.payee)) - payeeBefore;
    }
    const spent = vaultBefore - (await usdcOf(stage.rpc, stage.vault));

    const asExpected =
      away?.kind === "walked_away" &&
      away.answer.status === 409 &&
      away.answer.reason === "below_floor" &&
      sale?.kind === "paid" &&
      sale.status === 200 &&
      sale.deal.countered &&
      sale.deal.counteredQuoteId !== null &&
      sale.dataCheck?.ok === true &&
      refusal?.kind === "refused" &&
      (refusal.spend.status === "refused_by_code" ||
        refusal.spend.status === "refused_by_contract") &&
      USES_REFUSALS.has(refusal.spend.code ?? "") &&
      refusal.contract.ok === false &&
      refusal.contract.code === "UsesExhausted" &&
      spendRequests() === 2 &&
      payout === BigInt(sale.deal.priceUnits);

    io.out("");
    io.out(
      `request_spend was called ${spendRequests()} times: for calls 2 and 3, and not for the walk-away.`,
    );
    io.out(
      `Payout: near:${stage.payee} got ${formatUsdc(payout.toString())} USDC; the vault paid ${formatUsdc(spent.toString())} USDC in all.`,
    );
    io.out(
      asExpected ? "All three calls ended as expected." : "NOT as expected: read the lines above.",
    );
    const elapsedMs = clock() - started;
    const inTime = elapsedMs < DEMO_LIMIT_MS;
    io.out(
      `Demo finished in ${(elapsedMs / 1000).toFixed(1)} s (limit ${DEMO_LIMIT_MS / 1000} s)${inTime ? "" : ": over the limit, so NOT as expected"}.`,
    );
    return {
      mode: stage.mode,
      results,
      ok: asExpected && inTime,
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
