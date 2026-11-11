// `probarion-mcp demo` end to end: the real server in a child process over stdio, against the SDK's fake
// chain on loopback, with the public ledger served from a file the SDK wrote. One payment is made through
// the SDK first, so the vault has a paid spend and a signed, anchored ledger; then the demo runs read-only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileLedgerStore } from "@probarion/sdk";
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
import { DEMO_HELP, demoServerEnv, ledgerUrl, runDemo } from "../src/demo.js";
import { VERSION } from "../src/main.js";
import { buildPort } from "../src/probarion-port.js";

const NOW = new Date(Number(SCENARIO_NOW / 1_000_000n));
/** The scenario's mandates expire at 2027-01-01T00:00:00Z. */
const AFTER_EXPIRY_NS = 1_798_761_600_000_000_000n + 1n;

// The server runs from its TypeScript source through tsx, with the same no-network guard as these tests.
const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const NO_NETWORK = new URL("./setup/no-network.ts", import.meta.url).href;
const SERVER = { command: process.execPath, args: ["--import", TSX, "--import", NO_NETWORK, BIN] };

let rpc: FakeRpcServer;
let chainNow: bigint;
beforeEach(async () => {
  chainNow = SCENARIO_NOW;
  rpc = await startFakeRpcServer(createScenarioChain({ nowNs: () => chainNow }));
});
afterEach(async () => {
  await rpc.close();
});

/** Pays 25 USDC under mandate 1 through the SDK with the test keys; returns the ledger file it wrote. */
async function payOnce(): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "probarion-mcp-demo-test-")), "ledger.jsonl");
  const cfg: McpConfig = {
    network: "testnet",
    vault: SCENARIO_VAULT,
    agentKey: TEST_KEYS.agent.secretKey,
    ledgerKey: TEST_KEYS.ledger.secretKey,
    rpcUrls: [rpc.url],
    archivalRpcUrls: null,
    agentPublicKey: TEST_KEYS.agent.publicKey,
    ledgerPublicKey: TEST_KEYS.ledger.publicKey,
    keysSource: "env",
    ledgerPath: path,
    readOnly: false,
  };
  const port = buildPort(
    cfg,
    {
      now: () => NOW,
      logger: { warn: () => undefined },
      onlineVerifier: null,
      archivalRpc: null,
      burnTxHints: new Map(),
    },
    new FileLedgerStore(path),
  );
  const out = await port.requestSpend({
    mandateId: 1,
    amount: "25000000",
    invoiceHash: "c".repeat(64),
    ref: "vendor:INV-1",
    proposal: {
      action: "pay",
      mandate_id: 1,
      amount: "25000000",
      payee_hint: null,
      reasoning: "mcp: design retainer per PO-1001",
      confidence: 1,
    },
  });
  expect(out.status).toBe("paid");
  return readFileSync(path, "utf8");
}

function sink() {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      text += chunk.toString("utf8");
      done();
    },
  });
  return { stream, text: () => text };
}

/**
 * Runs the demo on the scenario's vault (the default is the live demo vault) with both keys in its
 * environment, to show they never reach the server.
 */
async function demo(opts: {
  ledger: string | number;
  now?: Date;
  args?: string[];
  /** The RPC the server is given. Default: the fake chain. */
  rpcUrl?: string;
}) {
  const out = sink();
  const err = sink();
  const fetched: string[] = [];
  const code = await runDemo(opts.args ?? ["--vault", SCENARIO_VAULT], {
    env: {
      NEAR_RPC_URLS: opts.rpcUrl ?? rpc.url,
      NEAR_ARCHIVAL_RPC_URLS: opts.rpcUrl ?? rpc.url,
      PROBARION_AGENT_KEY: TEST_KEYS.agent.secretKey,
      PROBARION_LEDGER_KEY: TEST_KEYS.ledger.secretKey,
    },
    out: out.stream,
    err: err.stream,
    server: SERVER,
    now: () => opts.now ?? NOW,
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      fetched.push(String(input));
      return typeof opts.ledger === "string"
        ? new Response(opts.ledger, { status: 200 })
        : new Response("unavailable", { status: opts.ledger });
    }) as typeof fetch,
  });
  return { code, out: out.text(), err: err.text(), fetched };
}

/** A loopback URL where nothing listens: a port the OS handed out, closed again before it is used. */
async function deadRpcUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** The step headers and their results, the transcript's fixed frame. */
const frame = (out: string): string[] =>
  out.split("\n").filter((l) => /^(Step \d of 6\.| {2}result:|Done:)/.test(l));

/** Every transaction the fake chain has run, as method names. */
const sent = (): string[] =>
  [...rpc.chain.txs.values()].map(
    (o) =>
      (o.transaction as { actions: { FunctionCall: { method_name: string } }[] }).actions[0]
        ?.FunctionCall.method_name ?? "?",
  );

describe("probarion-mcp demo", () => {
  it("walks the six steps read-only, with the expected answers, and sends nothing", async () => {
    const ledger = await payOnce();
    const before = sent();
    const mark = rpc.methods.length;
    const r = await demo({ ledger });
    expect(r.err).toBe("");
    expect(r.fetched).toEqual([ledgerUrl(SCENARIO_VAULT)]);
    expect(frame(r.out)).toEqual([
      "Step 1 of 6. tools/list: the five tools and the fields each one takes",
      "  result: as expected. No tool takes an address",
      "Step 2 of 6. list_mandates: the caps the owner signed, read live from the vault contract",
      "  result: as expected. read_only true, 2 mandates",
      "Step 3 of 6. check_spend on mandate 1: the contract's dry run of spend, a view call with no transaction",
      "  result: as expected. The contract answered as the mandate's caps, uses and expiry say",
      'Step 4 of 6. request_spend with an injected "to" field, as a prompt injection would add it',
      "  result: as expected. The schema refused the field. This server is read-only as well, so request_spend could not pay anyway",
      "Step 5 of 6. get_spend_status: a paid spend, read from the vault contract",
      "  result: as expected. A paid spend is final: the vault paid the mandate's payee",
      "Step 6 of 6. verify: Probarion's verifier on the vault's public ledger and the chain",
      "  result: as expected. The ledger and the chain agree",
      "Done: 6 steps, 6 as expected. Nothing was signed or sent.",
    ]);
    expect(r.out).toContain(
      `probarion-mcp ${VERSION} demo: vault ${SCENARIO_VAULT} on NEAR testnet`,
    );
    // The fields of each tool, and the caps that the dry runs are taken from (not hard-coded amounts).
    expect(r.out).toContain(
      "  request_spend    mandate_id, amount, invoice_hash, ref, reasoning\n",
    );
    expect(r.out).toContain(
      "    per payment  100.00 USDC, held for an approver above 50.00 USDC\n",
    );
    expect(r.out).toContain("    uses         1 of 10 used, 9 left\n");
    expect(r.out).toContain(
      "  50.00 USDC (at the approval threshold): expect ok, not held\n    -> ok: true, would_hold: false. As expected.\n",
    );
    expect(r.out).toContain(
      "  100.00 USDC (the per-payment cap): expect ok, held for an approver\n    -> ok: true, would_hold: true. As expected.\n",
    );
    expect(r.out).toContain(
      "  101.00 USDC (1.00 USDC over the per-payment cap): expect OverPerPayment\n    -> ok: false, code: OverPerPayment. As expected.\n",
    );
    expect(r.out).toMatch(/ {2}-> refused: .*Input validation error.*Unrecognized key: "to"/);
    expect(r.out).toMatch(
      /\n {2}spend 1: paid, 25\.00 USDC to NEAR account vendor\.testnet, mandate 1, ref vendor:INV-1, /,
    );
    expect(r.out).toContain(`  ledger: 2 entries from ${ledgerUrl(SCENARIO_VAULT)}\n`);
    expect(r.out).toMatch(/\n {2}a ledger-signatures +pass /);
    expect(r.out).toContain("  -> ok: true, 2 entries, 1 anchors\n");
    expect(r.code).toBe(0);
    // Read-only: the keys in the demo's environment never reached the server, and no transaction ran.
    expect(sent()).toEqual(before);
    expect(rpc.methods.slice(mark)).not.toContain("send_tx");
    expect(rpc.methods.slice(mark)).not.toContain("broadcast_tx_commit");
    expect(rpc.methods.slice(mark)).toContain("query");
  });

  it("says so and exits 0 when the mandates' uses are exhausted", async () => {
    const ledger = await payOnce();
    for (const m of rpc.chain.mandates) {
      m.uses = m.max_uses;
      m.status = "exhausted";
      // No amount the mandate allows is above this threshold, so the held dry run has nothing to try.
      m.approval_above = m.max_per_payment;
    }
    const r = await demo({ ledger });
    expect(r.out).toContain(
      "  result: note. No mandate can pay now (mandate 1: exhausted, 10 of 10 uses used). The dry runs below show the contract refusing, which is what a mandate is for\n",
    );
    expect(r.out).toContain(
      "  100.00 USDC (the per-payment cap): expect UsesExhausted\n    -> ok: false, code: UsesExhausted. As expected.\n",
    );
    // A mandate that can pay nothing has no "most it pays now": the amount is named by the cap it comes from.
    expect(r.out).not.toContain("the most this mandate pays now");
    expect(r.out).toContain(
      "  (one dry run skipped: no amount the mandate allows is above its approval threshold)\n",
    );
    expect(r.out).toContain(
      "expect OverPerPayment\n    -> ok: false, code: OverPerPayment. As expected.",
    );
    expect(r.out).toContain(
      "  result: note. The contract answered as the mandate's caps, uses and expiry say; 1 dry run skipped, as said above\n",
    );
    expect(r.out).toContain("Done: 6 steps, 4 as expected, 2 notes. Nothing was signed or sent.");
    expect(r.code).toBe(0);
  });

  it("says so and exits 0 when the mandates have expired", async () => {
    const ledger = await payOnce();
    chainNow = AFTER_EXPIRY_NS;
    const r = await demo({ ledger, now: new Date(Number(AFTER_EXPIRY_NS / 1_000_000n)) });
    expect(r.out).toContain(
      "No mandate can pay now (mandate 1: expired on 2027-01-01T00:00:00.000Z).",
    );
    expect(r.out.match(/-> ok: false, code: MandateExpired\. As expected\./g)).toHaveLength(3);
    expect(r.out).toContain("Done: 6 steps, 5 as expected, 1 note. Nothing was signed or sent.");
    expect(r.code).toBe(0);
  });

  it("skips verify with the reason when the public ledger cannot be downloaded", async () => {
    await payOnce();
    const r = await demo({ ledger: 503 });
    expect(r.out).toContain(
      `  ledger: could not download ${ledgerUrl(SCENARIO_VAULT)} (HTTP 503)\n`,
    );
    expect(r.out).toContain("  result: skipped. verify needs the vault's ledger; it was not run\n");
    expect(r.out).toContain("Done: 6 steps, 5 as expected, 1 skipped. Nothing was signed or sent.");
    expect(r.code).toBe(0);
  });

  it("names a refusal for the whole vault and exits 0 when the owner has frozen it", async () => {
    const ledger = await payOnce();
    rpc.chain.config.frozen = true;
    const r = await demo({ ledger });
    // list_mandates shows no vault-wide state, so the mandate looks able to pay; the contract refuses all three.
    expect(r.out).toContain("  result: as expected. read_only true, 2 mandates\n");
    expect(
      r.out.match(
        /-> ok: false, code: Frozen: the vault's owner has frozen it, so the contract refuses every spend\./g,
      ),
    ).toHaveLength(3);
    expect(r.out).toContain(
      "  result: note. The contract answered Frozen, a refusal for the whole vault\n",
    );
    expect(r.out).toContain("Done: 6 steps, 5 as expected, 1 note. Nothing was signed or sent.");
    expect(r.out).not.toContain("server log:");
    expect(r.code).toBe(0);
  });

  it("marks the steps that need the chain as failed, shows the server log and exits 1 when the RPC does not answer", async () => {
    const ledger = await payOnce();
    const r = await demo({ ledger, rpcUrl: await deadRpcUrl() });
    expect(frame(r.out)).toEqual([
      "Step 1 of 6. tools/list: the five tools and the fields each one takes",
      "  result: as expected. No tool takes an address",
      "Step 2 of 6. list_mandates: the caps the owner signed, read live from the vault contract",
      expect.stringMatching(/^ {2}result: failed\. list_mandates answered: \S/),
      "Step 3 of 6. check_spend: the contract's dry run of spend, a view call with no transaction",
      "  result: skipped. No mandate to dry-run",
      'Step 4 of 6. request_spend with an injected "to" field, as a prompt injection would add it',
      "  result: as expected. The schema refused the field. This server is read-only as well, so request_spend could not pay anyway",
      "Step 5 of 6. get_spend_status: a paid spend, read from the vault contract",
      "  result: failed. get_spend_status did not answer",
      "Step 6 of 6. verify: Probarion's verifier on the vault's public ledger and the chain",
      expect.stringMatching(/^ {2}result: failed\. verify answered: \S/),
      "Done: 6 steps, 2 as expected, 1 skipped, 3 failed. Nothing was signed or sent.",
    ]);
    expect(r.out).toMatch(/\nserver log:\n\S/);
    expect(r.code).toBe(1);
  });

  it("refuses a mainnet vault or an unknown argument before it starts anything", async () => {
    const mainnet = await demo({ ledger: 404, args: ["--vault", "acme.vaults.probarion.near"] });
    expect(mainnet.code).toBe(2);
    expect(mainnet.err).toContain("the demo runs on NEAR testnet only");
    expect(mainnet.fetched).toEqual([]);
    const unknown = await demo({ ledger: 404, args: ["--key", "x"] });
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown argument "--key"');
    const help = await demo({ ledger: 404, args: ["--help"] });
    expect(help.code).toBe(0);
    expect(help.out).toBe(DEMO_HELP);
    expect(rpc.methods).toEqual([]);
  });

  it("gives the server no key, whatever the demo's own environment holds", () => {
    const env = demoServerEnv(
      {
        PROBARION_AGENT_KEY: TEST_KEYS.agent.secretKey,
        PROBARION_LEDGER_KEY: TEST_KEYS.ledger.secretKey,
        NEAR_RPC_URLS: "https://rpc.example",
        NEAR_NETWORK: "mainnet",
      },
      "demo.vaults.probarion.testnet",
      "/tmp/ledger.jsonl",
    );
    expect(env).toMatchObject({
      NEAR_NETWORK: "testnet",
      PROBARION_VAULT_ID: "demo.vaults.probarion.testnet",
      PROBARION_LEDGER_PATH: "/tmp/ledger.jsonl",
      NEAR_RPC_URLS: "https://rpc.example",
    });
    expect(Object.keys(env)).not.toContain("PROBARION_AGENT_KEY");
    expect(Object.keys(env)).not.toContain("PROBARION_LEDGER_KEY");
    expect(JSON.stringify(env)).not.toContain(TEST_KEYS.agent.secretKey);
  });
});

describe("probarion-mcp arguments", () => {
  const bin = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", TSX, BIN, ...args], { encoding: "utf8" });

  it("prints the version and the help, and refuses an unknown argument with exit code 2", () => {
    const version = bin("--version");
    expect(version.status).toBe(0);
    expect(version.stdout).toBe(`${VERSION}\n`);
    const help = bin("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("probarion-mcp demo [--vault <id>]");
    expect(help.stdout).toContain("Unaudited beta");
    const unknown = bin("--bogus");
    expect(unknown.status).toBe(2);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain('unknown argument "--bogus"');
  });
});
