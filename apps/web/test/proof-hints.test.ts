// The "To prove it" commands under an unproven burn really prove it. Each scenario makes a burn the page cannot
// prove, on the SDK's fake chain over loopback JSON-RPC: the page shows the hint; the test follows it as a visitor
// would (the snapshot's ledger saved as ledger.jsonl, the placeholder filled in) and runs it through the real CLI,
// in-process. Only --rpc is added, to point the CLI at the fake node instead of the network's default. No network.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Snapshot, sha256Hex, type VerifyReport } from "@probarion/core";
import {
  InMemoryLedgerStore,
  NearApiJsSender,
  Probarion,
  RpcClient,
  type SpendOutcome,
} from "@probarion/sdk";
import {
  createScenarioChain,
  SCENARIO_APPROVER,
  SCENARIO_BASE_ADDRESS,
  SCENARIO_NOW,
  SCENARIO_PURPOSE_BASE,
  SCENARIO_VAULT,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProofReader } from "@/lib/proof/reader";
import { clearProofCache, loadProof, type ProofOk } from "@/lib/proof/service";
import { snapshotFileText } from "@/lib/proof/snapshot-file";
import { headline, unprovenRows } from "@/lib/proof/view";
import { noServiceDb, publicDbFor } from "./fixtures/proof";
import { type ChainRpc, startChainRpc } from "./fixtures/rpc";

// A computed path, so the web typecheck does not pull the CLI's sources into its own program.
const CLI_PROGRAM = fileURLToPath(new URL("../../../packages/cli/src/program.ts", import.meta.url));
const NOW = new Date(Number(SCENARIO_NOW / 1_000_000n));
const none = { preLedgerDecisionHashes: [], burnTxHints: new Map() };

interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  now(): Date;
  setExitCode(code: number): void;
}

/** Runs `argv` through the real CLI in a fresh folder holding `files`. */
async function cli(
  argv: readonly string[],
  files: Record<string, string>,
): Promise<{ code: number; report: VerifyReport | null; err: string }> {
  const { runCli } = (await import(/* @vite-ignore */ CLI_PROGRAM)) as {
    runCli(argv: readonly string[], io: CliIo): Promise<number>;
  };
  const dir = mkdtempSync(join(tmpdir(), "probarion-proof-hint-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    let out = "";
    let err = "";
    const code = await runCli(argv, {
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
      env: {},
      cwd: dir,
      now: () => NOW,
      setExitCode: () => {},
    });
    let report: VerifyReport | null = null;
    try {
      report = JSON.parse(out) as VerifyReport;
    } catch {
      report = null;
    }
    return { code, report, err };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What the page tells the visitor to save first: the downloaded snapshot's ledger, one entry per line. */
function ledgerJsonl(downloaded: string): string {
  const s = JSON.parse(downloaded) as Snapshot;
  return s.ledger.map((e) => `${JSON.stringify(e)}\n`).join("");
}

/** The hint as argv, with its placeholder filled in and --rpc pointed at the fake node. */
function argvOf(hint: string, fill: Record<string, string>, rpcUrl: string): string[] {
  let command = hint;
  for (const [placeholder, value] of Object.entries(fill))
    command = command.replace(placeholder, value);
  expect(command).not.toMatch(/[<>]/);
  const words = command.split(" ");
  expect(words.slice(0, 3)).toEqual(["npx", "probarion", "verify"]);
  return ["verify", "--rpc", rpcUrl, ...words.slice(3), "--json"];
}

function invoice(text: string, ref: string, amount: string) {
  return {
    text,
    ref,
    facts: {
      invoice_hash: sha256Hex(text),
      amount,
      po_ref: "PO-2002",
      purpose_hash: SCENARIO_PURPOSE_BASE,
      payee_hint: { chain: "base" as const, address: SCENARIO_BASE_ADDRESS },
    },
  };
}

describe("the unproven-burn hints, followed through the real CLI", () => {
  let node: ChainRpc;
  let store: InMemoryLedgerStore;
  let agent: Probarion;
  beforeEach(async () => {
    clearProofCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    node = await startChainRpc(createScenarioChain());
    store = new InMemoryLedgerStore();
    agent = new Probarion(
      {
        network: "testnet",
        vault: SCENARIO_VAULT,
        agentKey: TEST_KEYS.agent.secretKey,
        ledgerKey: TEST_KEYS.ledger.secretKey,
        model: null,
        ledger: store,
      },
      {
        rpc: node.rpc,
        archivalRpc: null,
        preLedgerDecisionHashes: [],
        burnTxHints: new Map(),
        onlineVerifier: null,
        txIndex: null,
        env: {},
        now: () => NOW,
        logger: { warn: () => {} },
      },
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await node.close();
  });

  /** The page's result for the scenario vault, read with `rpc` (the page's own RPC client). */
  async function pageResult(rpc: RpcClient): Promise<ProofOk> {
    const ledger = await store.all();
    const r = await loadProof(
      {
        network: "testnet",
        publicDb: publicDbFor(SCENARIO_VAULT, "testnet", ledger),
        serviceDb: noServiceDb,
        sessionAccount: null,
        makeReader: (vault, s) =>
          makeProofReader({
            network: "testnet",
            vault,
            store: s,
            rpc,
            archivalRpcUrls: [],
            evidence: none,
          }),
      },
      SCENARIO_VAULT,
    );
    if (r.status !== "ok") throw new Error(`the page gave ${r.status}`);
    return r;
  }

  it("approver_tx: --ledger ledger.jsonl --burn-tx <spend>=<the approver's tx> exits 0, and without --ledger it fails", async () => {
    const held: SpendOutcome = await agent.process(
      invoice("Invoice B-9 for PO-2002", "B-9", "60000000"),
    );
    expect(held).toMatchObject({ status: "held", spendId: 1 });
    const approver = new NearApiJsSender({
      accountId: SCENARIO_APPROVER,
      secretKey: TEST_KEYS.approver.secretKey,
      rpcUrl: node.server.url,
    });
    const approved = await approver.functionCall({
      receiverId: SCENARIO_VAULT,
      methodName: "approve",
      args: { spend_id: 1 },
      gas: 200_000_000_000_000n,
      deposit: 1n,
    });
    expect(approved.ok).toBe(true);
    const approvedTx = approved.txHash ?? "";

    const r = await pageResult(node.rpc);
    expect(headline(r.report)).toBe("unproven");
    expect(r.report.unproven).toEqual([{ check: "h", spend_id: 1, reason: "approver_tx" }]);
    const [row] = unprovenRows(r.report, "testnet", SCENARIO_VAULT);
    expect(row?.hint).toBe(
      `npx probarion verify --network testnet --vault ${SCENARIO_VAULT} --ledger ledger.jsonl --burn-tx 1=<tx hash>`,
    );

    const files = { "ledger.jsonl": ledgerJsonl(snapshotFileText(r.snapshot)) };
    const argv = argvOf(row?.hint ?? "", { "<tx hash>": approvedTx }, node.server.url);
    const followed = await cli(argv, files);
    expect(followed.err).not.toMatch(/^error:/m);
    expect(followed.code).toBe(0);
    expect(followed.report?.ok).toBe(true);

    // The old hint, without --ledger, verifies the chain against an empty ledger and fails.
    const withoutLedger = argv.filter((w, i) => w !== "--ledger" && argv[i - 1] !== "--ledger");
    expect(withoutLedger).not.toContain("ledger.jsonl");
    expect((await cli(withoutLedger, {})).code).toBe(1);
  });

  it("tx_unavailable: --ledger ledger.jsonl --archival-rpc <urls> exits 0 once the tx can be read", async () => {
    const paid = await agent.process(invoice("Invoice B-1 for PO-2002", "B-1", "25000000"));
    expect(paid.status).toBe("burned");

    // The page's node cannot answer `tx` right now, so the burn is unavailable, not failed.
    const flaky = new RpcClient({
      urls: [node.server.url],
      maxRounds: 1,
      sleep: async () => {},
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method?: string };
        if (body.method === "tx") return new Response("busy", { status: 503 });
        return fetch(input, init);
      }) as typeof fetch,
    });
    const r = await pageResult(flaky);
    expect(headline(r.report)).toBe("unproven");
    expect(r.report.unproven).toEqual([{ check: "h", spend_id: 1, reason: "tx_unavailable" }]);
    const [row] = unprovenRows(r.report, "testnet", SCENARIO_VAULT);
    expect(row?.hint).toBe(
      `npx probarion verify --network testnet --vault ${SCENARIO_VAULT} --ledger ledger.jsonl --archival-rpc <archival RPC URLs>`,
    );

    const files = { "ledger.jsonl": ledgerJsonl(snapshotFileText(r.snapshot)) };
    const argv = argvOf(
      row?.hint ?? "",
      { "<archival RPC URLs>": node.server.url },
      node.server.url,
    );
    const followed = await cli(argv, files);
    expect(followed.err).not.toMatch(/^error:/m);
    expect(followed.code).toBe(0);
    expect(followed.report?.ok).toBe(true);
  });
});
