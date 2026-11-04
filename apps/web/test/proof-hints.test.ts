// The "To prove it" commands under an unproven burn really prove it. Each scenario makes a burn the page cannot
// prove, on the SDK's fake chain over loopback JSON-RPC: the page shows the hint; the test follows it as a visitor
// would (ledger.jsonl downloaded from the page's ledger route, the placeholder filled in) and runs the exact command
// shown, through the built CLI as a child process (the repository folder is this checkout). Only --rpc is added, to
// point the CLI at the fake node instead of the network's default. Loopback only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, type VerifyReport } from "@probarion/core";
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
import type { Db } from "@/lib/db/port";
import { cli } from "@/lib/proof/cli";
import { ledgerResponse } from "@/lib/proof/ledger-file";
import { makeProofReader } from "@/lib/proof/reader";
import { clearProofCache, loadLedger, loadProof, type ProofOk } from "@/lib/proof/service";
import { headline, unprovenRows } from "@/lib/proof/view";
import { runBuiltCli, shownArgs } from "./fixtures/cli-bin";
import { noServiceDb, publicDbFor } from "./fixtures/proof";
import { type ChainRpc, startChainRpc } from "./fixtures/rpc";

const NOW = new Date(Number(SCENARIO_NOW / 1_000_000n));
const none = { preLedgerDecisionHashes: [], burnTxHints: new Map() };

// Child processes of the built CLI: give them room on a slow machine.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Runs a displayed command (its `<…>` placeholders filled) through the built CLI, with `extra` flags after its first
 * word (`verify`), in a fresh folder holding `files`. Either form of the command works (`npx probarion` or the
 * repository's bin), so these tests hold whichever way CLI_ON_NPM is set. The child gets no NEAR_ or PROBARION_
 * variable of this machine, and `archivalEnv` as its default archival RPC, so it reaches nothing past loopback.
 */
async function runShown(
  command: string,
  extra: readonly string[],
  files: Record<string, string>,
  archivalEnv: string,
): Promise<{ code: number; report: VerifyReport | null; err: string }> {
  const [verb, ...rest] = shownArgs(command);
  expect(verb).toBe("verify");
  const dir = mkdtempSync(join(tmpdir(), "probarion-proof-hint-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const env: Record<string, string | undefined> = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/^(NEAR_|PROBARION_)/i.test(k)),
    );
    env.NEAR_ARCHIVAL_RPC_URLS = archivalEnv;
    const r = await runBuiltCli(["verify", ...extra, ...rest, "--json"], { cwd: dir, env });
    let report: VerifyReport | null = null;
    try {
      report = JSON.parse(r.stdout) as VerifyReport;
    } catch {
      report = null;
    }
    return { code: r.code, report, err: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ledger.jsonl as the page's ledger route serves it for `publicDb`'s vault. */
async function downloadedLedger(publicDb: Db): Promise<string> {
  const r = await loadLedger(
    { network: "testnet", publicDb, serviceDb: noServiceDb, sessionAccount: null },
    SCENARIO_VAULT,
  );
  if (r.status !== "ok") throw new Error(`the ledger route gave ${r.status}`);
  return ledgerResponse(r).text();
}

/** A loopback JSON-RPC proxy to `target` that answers every `tx` call with 503: a node that cannot read txs now. */
async function noTxProxy(target: string): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if ((JSON.parse(body) as { method?: string }).method === "tx") {
        res.writeHead(503).end("busy");
        return;
      }
      const answer = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      res.writeHead(answer.status, { "content-type": "application/json" }).end(await answer.text());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
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

describe("the unproven-burn hints, run as shown through the built CLI", () => {
  let node: ChainRpc;
  let proxy: { url: string; close(): Promise<void> };
  let store: InMemoryLedgerStore;
  let agent: Probarion;
  beforeEach(async () => {
    clearProofCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    node = await startChainRpc(createScenarioChain());
    proxy = await noTxProxy(node.server.url);
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
    await proxy.close();
    await node.close();
  });

  /** The vault's public ledger, as the database serves it to /proof. */
  const publicDb = async () => publicDbFor(SCENARIO_VAULT, "testnet", await store.all());

  /** The page's result for the scenario vault, read with `rpc` (the page's own RPC client). */
  async function pageResult(rpc: RpcClient): Promise<ProofOk> {
    const r = await loadProof(
      {
        network: "testnet",
        publicDb: await publicDb(),
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
      cli(
        `verify --network testnet --vault ${SCENARIO_VAULT} --ledger ledger.jsonl --burn-tx 1=<tx hash>`,
      ),
    );

    const files = { "ledger.jsonl": await downloadedLedger(await publicDb()) };
    const shown = (row?.hint ?? "").replace("<tx hash>", approvedTx);
    const followed = await runShown(shown, ["--rpc", node.server.url], files, proxy.url);
    expect(followed.err).not.toMatch(/^error:/m);
    expect(followed.code).toBe(0);
    expect(followed.report?.ok).toBe(true);

    // Without --ledger, the CLI verifies the chain against an empty ledger and fails.
    const withoutLedger = shown.replace(" --ledger ledger.jsonl", "");
    expect(withoutLedger).not.toContain("ledger.jsonl");
    expect((await runShown(withoutLedger, ["--rpc", node.server.url], {}, proxy.url)).code).toBe(1);
  });

  it("tx_unavailable: only the archival RPC the hint asks for can read the tx, and then it exits 0", async () => {
    const paid = await agent.process(invoice("Invoice B-1 for PO-2002", "B-1", "25000000"));
    expect(paid.status).toBe("burned");

    // The page's node cannot answer `tx` right now, so the burn is unavailable, not failed.
    const r = await pageResult(
      new RpcClient({ urls: [proxy.url], maxRounds: 1, sleep: async () => {} }),
    );
    expect(headline(r.report)).toBe("unproven");
    expect(r.report.unproven).toEqual([{ check: "h", spend_id: 1, reason: "tx_unavailable" }]);
    const [row] = unprovenRows(r.report, "testnet", SCENARIO_VAULT);
    expect(row?.hint).toBe(
      cli(
        `verify --network testnet --vault ${SCENARIO_VAULT} --ledger ledger.jsonl --archival-rpc <archival RPC URLs>`,
      ),
    );

    // The visitor's regular RPC (the proxy) still cannot read `tx`, and neither can the default archival RPC.
    const files = { "ledger.jsonl": await downloadedLedger(await publicDb()) };
    const asIs = await runShown(
      (row?.hint ?? "").replace(" --archival-rpc <archival RPC URLs>", ""),
      ["--rpc", proxy.url],
      files,
      proxy.url,
    );
    expect(asIs.code).toBe(2);
    const shown = (row?.hint ?? "").replace("<archival RPC URLs>", node.server.url);
    const followed = await runShown(shown, ["--rpc", proxy.url], files, proxy.url);
    expect(followed.err).not.toMatch(/^error:/m);
    expect(followed.code).toBe(0);
    expect(followed.report?.ok).toBe(true);
  });
});
