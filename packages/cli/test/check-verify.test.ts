// `probarion check`, `probarion verify` and `probarion ledger export` (plan 03 Task 16). TEST DOUBLES only: the
// fake chain over JSON-RPC on loopback and the fake NEAR AI. Nothing here talks to a real network (R20).
//
// verify exits 0 when every check passes, 1 when any check fails (a fail always wins), 2 when nothing fails but a
// check is unproven, and 64 on a usage error. check exits 0 when the vault would accept, 1 when it would refuse,
// and 64 on a usage error.
import { copyFile, link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeNonce,
  extractReportDataFromQuote,
  isNearTxHash,
  KNOWN_VAULT_CODE_HASHES,
  type MandateView,
  NETWORKS,
  type ProposalRequestInputs,
  type Snapshot,
  type SpendView,
  sha256Hex,
  ZERO_HEX32,
} from "@probarion/core";
import {
  FileLedgerStore,
  hashInvoice,
  NearAiProposer,
  NearApiJsSender,
  type OnlineAttestationVerifier,
  Probarion,
  type ProbarionDeps,
  type ProbarionOptions,
  type SpendOutcome,
} from "@probarion/sdk";
import {
  createFakeNearAi,
  createScenarioChain,
  FAKE_NEARAI_BASE_URL,
  FakeChain,
  type FakeRpcServer,
  SCENARIO_APPROVER,
  SCENARIO_BASE_ADDRESS,
  SCENARIO_NEAR_PAYEE,
  SCENARIO_PURPOSE_BASE,
  SCENARIO_PURPOSE_NEAR,
  SCENARIO_VAULT,
  startFakeRpcServer,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliIo } from "../src/io.js";
import { runCli } from "../src/program.js";
import { CLOCK_HINT } from "../src/report.js";
import { NOW, tempDir, testIo } from "./helpers.js";

const FIXTURE = fileURLToPath(
  new URL("../../core/test/fixtures/valid-snapshot.json", import.meta.url),
);
const CHECK_NAMES = [
  "ledger-signatures",
  "hash-links",
  "anchors",
  "spends-have-decisions",
  "attestations",
  "vault-locked",
  "intents-keys",
  "burn-memos",
  "factory-version",
];
/** Built at run time so that no secret-shaped literal sits in the source (gitleaks). */
const NEARAI_KEY = ["test", "double", "nearai", "key"].join("-");

let server: FakeRpcServer;
let dir: string;
const extraServers: FakeRpcServer[] = [];

beforeEach(async () => {
  server = await startFakeRpcServer(createScenarioChain());
  dir = await tempDir();
});

afterEach(async () => {
  await server.close();
  for (const s of extraServers.splice(0)) await s.close();
});

async function cli(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
  more: Partial<CliIo> = {},
) {
  const { io, state } = testIo(dir, env);
  const code = await runCli(argv, { ...io, ...more });
  return { code, out: state.out, err: state.err };
}

const defaultLedger = () => join(dir, ".probarion", "ledger.jsonl");

/** The agent's side: a TEST DOUBLE vault the SDK pays from, writing its ledger where the CLI looks for it. */
function agentSdk(
  opts: {
    deps?: Partial<ProbarionDeps>;
    ledgerPath?: string;
    model?: ProbarionOptions["model"];
  } = {},
): Probarion {
  return new Probarion(
    {
      network: "testnet",
      vault: SCENARIO_VAULT,
      agentKey: TEST_KEYS.agent.secretKey,
      ledgerKey: TEST_KEYS.ledger.secretKey,
      rpcUrls: [server.url],
      model: opts.model ?? null,
      ledger: new FileLedgerStore(opts.ledgerPath ?? defaultLedger()),
    },
    {
      now: () => NOW,
      archivalRpc: null,
      burnTxHints: new Map(),
      evidenceDir: join(dir, "no-evidence-here"),
      logger: { warn: () => {} },
      ...opts.deps,
    },
  );
}

function invoice(
  text: string,
  ref: string,
  amount: string,
  purpose: string,
  hint: { near_account: string } | { chain: "base"; address: string },
  poRef: string,
) {
  return {
    text,
    ref,
    facts: {
      invoice_hash: sha256Hex(text),
      amount,
      po_ref: poRef,
      purpose_hash: purpose,
      payee_hint: hint,
    },
  };
}

const payNear = (pb: Probarion): Promise<SpendOutcome> =>
  pb.process(
    invoice(
      "Invoice INV-1 for PO-1001",
      "INV-1",
      "25000000",
      SCENARIO_PURPOSE_NEAR,
      { near_account: SCENARIO_NEAR_PAYEE },
      "PO-1001",
    ),
  );

const payBase = (pb: Probarion): Promise<SpendOutcome> =>
  pb.process(
    invoice(
      "Invoice B-1 for PO-2002",
      "B-1",
      "25000000",
      SCENARIO_PURPOSE_BASE,
      { chain: "base", address: SCENARIO_BASE_ADDRESS },
      "PO-2002",
    ),
  );

/** 60 USDC is above the Base mandate's approval_above (50): the vault holds it for an approver. */
const holdBase = (pb: Probarion): Promise<SpendOutcome> =>
  pb.process(
    invoice(
      "Invoice B-9 for PO-2002",
      "B-9",
      "60000000",
      SCENARIO_PURPOSE_BASE,
      { chain: "base", address: SCENARIO_BASE_ADDRESS },
      "PO-2002",
    ),
  );

/** The approver pays the held spend out; its burn is in this tx, which the agent's ledger never records. */
async function approveHeld(spendId: number): Promise<string> {
  const approver = new NearApiJsSender({
    accountId: SCENARIO_APPROVER,
    secretKey: TEST_KEYS.approver.secretKey,
    rpcUrl: server.url,
  });
  const approved = await approver.functionCall({
    receiverId: SCENARIO_VAULT,
    methodName: "approve",
    args: { spend_id: spendId },
    gas: 200_000_000_000_000n,
    deposit: 1n,
  });
  expect(approved.ok).toBe(true);
  return approved.txHash ?? "";
}

function spendTxHash(chain: FakeChain): string {
  const hash = [...chain.txs.keys()].find((h) => {
    const t = chain.txs.get(h)?.transaction as {
      actions?: { FunctionCall?: { method_name?: string } }[];
    };
    return t.actions?.[0]?.FunctionCall?.method_name === "spend";
  });
  if (hash === undefined) throw new Error("no spend tx");
  return hash;
}

async function fixtureSnapshot(): Promise<Snapshot> {
  return JSON.parse(await readFile(FIXTURE, "utf8")) as Snapshot;
}

const live = () => ["--rpc", server.url, "verify", "--vault", SCENARIO_VAULT];

describe("probarion check", () => {
  beforeEach(async () => {
    await writeFile(join(dir, "invoice.pdf"), "invoice bytes");
  });

  const args = (...more: string[]) => [
    "--rpc",
    server.url,
    "check",
    "--vault",
    SCENARIO_VAULT,
    "--mandate",
    "1",
    "--invoice",
    "invoice.pdf",
    "--ref",
    "INV-1",
    ...more,
  ];

  it("exits 0 and prints OK when the vault would accept the spend", async () => {
    const r = await cli(args("--amount", "25"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK: the vault would accept this spend.");
    expect(r.out).toContain(sha256Hex("invoice bytes"));
    expect(r.out).toContain(TEST_KEYS.agent.publicKey);
    expect(server.methods).toContain("query");
    expect(server.methods).not.toContain("send_tx");
    expect(server.methods).not.toContain("broadcast_tx_commit");
  });

  it("exits 0 and says the vault would hold a spend above approval_above", async () => {
    const r = await cli(args("--amount", "60"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK: the vault would accept this spend and hold it for an approver.");
  });

  it("exits 1 with the vault code when the vault would refuse", async () => {
    const r = await cli(args("--amount", "101"), {
      PROBARION_AGENT_KEY: TEST_KEYS.agent.secretKey,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("REFUSED: PROBARION:OverPerPayment");
    expect(r.out).not.toContain(TEST_KEYS.agent.secretKey);
  });

  it("exits 1 (REFUSED: PROBARION:NotAgent) when --agent-pk is not an agent key of the vault", async () => {
    const r = await cli(args("--amount", "25", "--agent-pk", TEST_KEYS.other.publicKey));
    expect(r.code).toBe(1);
    expect(r.out).toContain("REFUSED: PROBARION:NotAgent");
  });

  it("prints the request, the signer and the verdict as JSON (exit 0 and exit 1)", async () => {
    const ok = await cli(args("--amount", "25", "--json"));
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toEqual({
      request: {
        mandate_id: 1,
        amount: "25000000",
        invoice_hash: sha256Hex("invoice bytes"),
        ref: "INV-1",
        decision_hash: ZERO_HEX32,
      },
      signer_pk: TEST_KEYS.agent.publicKey,
      verdict: { ok: true, code: null, would_hold: false },
    });
    const refused = await cli(args("--amount", "101", "--json"));
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({
      verdict: { ok: false, code: "OverPerPayment", would_hold: false },
    });
  });

  it("treats an empty PROBARION_AGENT_KEY as unset (R12) and asks as the mandate's agent", async () => {
    const r = await cli(args("--amount", "25"), { PROBARION_AGENT_KEY: "  " });
    expect(r.code).toBe(0);
    expect(r.out).toContain(TEST_KEYS.agent.publicKey);
  });

  it.each([
    ["a ref longer than 64 bytes", ["--amount", "25", "--ref", "r".repeat(65)], "--ref"],
    ["an empty ref", ["--amount", "25", "--ref", ""], "--ref"],
    ["mandate 0 (ids start at 1)", ["--amount", "25", "--mandate", "0"], "--mandate"],
    ["a mandate that is not a number", ["--amount", "25", "--mandate", "one"], "--mandate"],
    ["an amount that is not a number", ["--amount", "abc"], "amount"],
    ["an amount with 7 decimals", ["--amount", "1.0000001"], "amount"],
    [
      "an --agent-pk that is not a key",
      ["--amount", "25", "--agent-pk", "ed25519:nope"],
      "--agent-pk",
    ],
    ["an unknown option", ["--amount", "25", "--bogus"], "--bogus"],
  ])("exits 64 on a usage error, before any RPC call: %s", async (_name, more, named) => {
    const r = await cli(args(...more));
    expect(r.code).toBe(64);
    expect(r.err).toContain(named);
    expect(r.out).toBe("");
    expect(server.methods).toEqual([]);
  });

  it("exits 64 when a required option is missing, before any RPC call", async () => {
    const r = await cli([
      "--rpc",
      server.url,
      "check",
      "--vault",
      SCENARIO_VAULT,
      "--mandate",
      "1",
    ]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("required option");
    expect(server.methods).toEqual([]);
  });

  it("exits 64 for a PROBARION_AGENT_KEY that is not a secret key, and never prints it", async () => {
    const junk = "ed25519:NOT-A-REAL-SECRET-VALUE";
    const r = await cli(args("--amount", "25"), { PROBARION_AGENT_KEY: junk });
    expect(r.code).toBe(64);
    expect(r.err).toContain("PROBARION_AGENT_KEY");
    expect(r.err + r.out).not.toContain("NOT-A-REAL-SECRET-VALUE");
    expect(server.methods).toEqual([]);
  });

  it("exits 64 for an --invoice that is not UTF-8 text, before any RPC call", async () => {
    await writeFile(
      join(dir, "scan.pdf"),
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00]),
    );
    const r = await cli([...args("--amount", "25"), "--invoice", "scan.pdf"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain(
      "--invoice scan.pdf is not UTF-8 text: pass the extracted invoice text",
    );
    expect(r.out).toBe("");
    expect(server.methods).toEqual([]);
  });

  it("hashes the invoice as the SDK does (hashInvoice), a UTF-8 BOM included", async () => {
    const text = "﻿Invoice INV-9 for PO-1001";
    await writeFile(join(dir, "bom.txt"), text);
    const r = await cli([...args("--amount", "25", "--json"), "--invoice", "bom.txt"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).request.invoice_hash).toBe(hashInvoice(text));
  });

  it("exits 1 when the invoice file cannot be read, before any RPC call", async () => {
    const r = await cli([...args("--amount", "25"), "--invoice", "missing.pdf"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--invoice missing.pdf");
    expect(server.methods).toEqual([]);
  });

  it("exits 1 when the mandate does not exist and no agent key says who would sign", async () => {
    const r = await cli([...args("--amount", "25"), "--mandate", "9"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`mandate 9 does not exist on ${SCENARIO_VAULT}`);
  });

  it("lists its exit codes 0, 1 and 64 in --help", async () => {
    const r = await cli(["check", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Exit codes:/);
    expect(r.out).toMatch(/^ {2}0 {3}the vault would accept/m);
    expect(r.out).toMatch(/^ {2}1 {3}the vault would refuse/m);
    expect(r.out).toMatch(/^ {2}64 {2}usage error/m);
  });
});

describe("probarion verify --offline", () => {
  it("exits 0 for the valid TEST FIXTURE snapshot, with no network", async () => {
    const r = await cli(["verify", "--offline", FIXTURE]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Probarion verify: x.vaults.probarion.testnet (testnet)");
    expect(r.out).toContain("entries 5, anchors 3");
    expect(r.out).toContain(
      "\nsnapshot taken 2026-11-05T12:00:00.000Z: its chain data is the file's and was not read from the chain again\n",
    );
    expect(r.out).toContain(
      "quote not verified offline (run --online for O1; re-take the snapshot live with --online)",
    );
    expect(r.out).not.toMatch(/^online/m);
    for (const name of CHECK_NAMES)
      expect(r.out).toMatch(new RegExp(`^[a-i] {2}${name} +PASS `, "m"));
    expect(r.out).toContain("9 passed, 0 failed, 0 unproven");
    expect(r.out).toMatch(/\nRESULT: PASS\n$/);
    expect(server.methods).toEqual([]);
  });

  it("exits 1 and names the first broken seq for a tampered snapshot", async () => {
    const snapshot = await fixtureSnapshot();
    const entry = snapshot.ledger[2];
    if (entry === undefined) throw new Error("fixture too short");
    entry.body.amount = "1";
    await writeFile(join(dir, "tampered.json"), JSON.stringify(snapshot));
    const r = await cli(["verify", "--offline", "tampered.json"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^a {2}ledger-signatures +FAIL .*\[first broken seq 2\]$/m);
    expect(r.out).toContain("RESULT: FAIL (first broken seq 2)");
  });

  it("prints the report as JSON (exit 0)", async () => {
    const r = await cli(["verify", "--offline", FIXTURE, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, entries: 5, anchors: 3, unproven: [] });
  });

  it("exits 2 with an UNPROVEN row, the spend, the reason and a hint when a burn tx could not be read", async () => {
    const snapshot = await fixtureSnapshot();
    const burn = snapshot.chain.burns[0];
    if (burn === undefined) throw new Error("fixture has no burn");
    burn.status = "unavailable";
    await writeFile(join(dir, "unavailable.json"), JSON.stringify(snapshot));
    const r = await cli(["verify", "--offline", "unavailable.json"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/^h {2}burn-memos +UNPROVEN /m);
    expect(r.out).not.toMatch(/^h {2}burn-memos +(PASS|FAIL) /m);
    expect(r.out).toContain(
      "unproven: spend 2 (tx_unavailable): re-run, or add --archival-rpc (when the snapshot is taken: probarion verify --network testnet --vault x.vaults.probarion.testnet --snapshot <file>)",
    );
    expect(r.out).toContain("8 passed, 0 failed, 1 unproven");
    expect(r.out).toMatch(/\nRESULT: UNPROVEN/);
    const json = await cli(["verify", "--offline", "unavailable.json", "--json"]);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out)).toMatchObject({
      ok: false,
      unproven: [{ check: "h", spend_id: 2, reason: "tx_unavailable" }],
    });
  });

  it("exits 1 when one check fails and another is unproven: a fail always wins", async () => {
    const snapshot = await fixtureSnapshot();
    const burn = snapshot.chain.burns[0];
    const entry = snapshot.ledger[0];
    if (burn === undefined || entry === undefined) throw new Error("fixture too short");
    burn.status = "unavailable";
    entry.body.amount = "1";
    await writeFile(join(dir, "both.json"), JSON.stringify(snapshot));
    const r = await cli(["verify", "--offline", "both.json"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^h {2}burn-memos +UNPROVEN /m);
    expect(r.out).toContain("RESULT: FAIL (first broken seq 0)");
  });

  it("exits 1 for a file that is not a snapshot, not JSON, or not there", async () => {
    await writeFile(join(dir, "nope.json"), '{"hello":1}');
    const notSnapshot = await cli(["verify", "--offline", "nope.json"]);
    expect(notSnapshot.code).toBe(1);
    expect(notSnapshot.err).toContain("not a Probarion snapshot");
    const v2 = { ...(await fixtureSnapshot()), v: 2 };
    await writeFile(join(dir, "v2.json"), JSON.stringify(v2));
    const otherVersion = await cli(["verify", "--offline", "v2.json"]);
    expect(otherVersion.code).toBe(1);
    expect(otherVersion.err).toContain("--offline v2.json is not a Probarion snapshot (v: 1)");
    expect(otherVersion.out).toBe("");
    await writeFile(join(dir, "text.json"), "not json");
    const notJson = await cli(["verify", "--offline", "text.json"]);
    expect(notJson.code).toBe(1);
    expect(notJson.err).toContain("is not JSON");
    const missing = await cli(["verify", "--offline", "missing.json"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("--offline missing.json is not a readable file");
    expect(notSnapshot.out + notJson.out + missing.out).not.toContain("RESULT");
  });

  it.each([
    [
      "taken_at holds a newline and an ANSI escape (a fake RESULT line)",
      { taken_at: "2026-11-05T12:00:00.000Z\n\u001b[32mRESULT: PASS\u001b[0m" },
      "taken_at",
    ],
    ["taken_at is not a timestamp", { taken_at: "yesterday" }, "taken_at"],
    ["taken_at is a number", { taken_at: 1793880000000 }, "taken_at"],
    [
      "vault holds shell metacharacters",
      { vault: "x.vaults.probarion.testnet; echo PWNED" },
      "vault",
    ],
    ["vault holds a newline", { vault: "x.vaults.probarion.testnet\nRESULT: PASS" }, "vault"],
    ["network is neither mainnet nor testnet", { network: "devnet" }, "network"],
  ])(
    "exits 64 when the snapshot's %s, naming the field and printing none of it",
    async (_name, patch, field) => {
      await writeFile(
        join(dir, "crafted.json"),
        JSON.stringify({ ...(await fixtureSnapshot()), ...patch }),
      );
      const r = await cli(["verify", "--offline", "crafted.json"]);
      expect(r.code).toBe(64);
      expect(r.err).toBe(
        `error: --offline crafted.json: "${field}" is not ${
          field === "vault"
            ? "a NEAR account id"
            : field === "network"
              ? "mainnet or testnet"
              : "an ISO-8601 timestamp"
        }\n`,
      );
      expect(r.out).toBe("");
    },
  );

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["blank", "  "],
  ])(
    "says 'snapshot time not recorded' for a %s taken_at, never 'undefined'",
    async (_name, takenAt) => {
      const snapshot: Record<string, unknown> = { ...(await fixtureSnapshot()) };
      if (takenAt === undefined) delete snapshot.taken_at;
      else snapshot.taken_at = takenAt;
      await writeFile(join(dir, "untimed.json"), JSON.stringify(snapshot));
      const r = await cli(["verify", "--offline", "untimed.json"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(
        "\nsnapshot time not recorded: its chain data is the file's and was not read from the chain again\n",
      );
      expect(r.out).not.toContain("snapshot taken");
      expect(r.out).not.toContain("undefined");
    },
  );

  it("writes the snapshot it verified with --snapshot", async () => {
    const r = await cli(["verify", "--offline", FIXTURE, "--snapshot", "copy.json"]);
    expect(r.code).toBe(0);
    const copy = JSON.parse(await readFile(join(dir, "copy.json"), "utf8")) as Snapshot;
    expect(copy).toEqual(await fixtureSnapshot());
    const empty = await cli(["verify", "--offline", FIXTURE, "--snapshot", " "]);
    expect(empty.code).toBe(64);
    expect(empty.err).toContain("--snapshot needs a file");
  });

  it("exits 64 when --snapshot names a file that exists (the --offline input too), and leaves it alone", async () => {
    await writeFile(join(dir, "taken.json"), "keep me\n");
    const taken = await cli(["verify", "--offline", FIXTURE, "--snapshot", "taken.json"]);
    expect(taken.code).toBe(64);
    expect(taken.err).toContain("--snapshot taken.json already exists: choose a new file");
    expect(taken.out).toBe("");
    expect(await readFile(join(dir, "taken.json"), "utf8")).toBe("keep me\n");
    await writeFile(join(dir, "input.json"), await readFile(FIXTURE, "utf8"));
    const before = await readFile(join(dir, "input.json"), "utf8");
    const self = await cli(["verify", "--offline", "input.json", "--snapshot", "input.json"]);
    expect(self.code).toBe(64);
    expect(await readFile(join(dir, "input.json"), "utf8")).toBe(before);
  });

  it.each([
    ["the default ledger", {}, ".probarion/ledger.jsonl"],
    ["the default ledger, spelled another way", {}, "./.probarion/../.probarion/ledger.jsonl"],
    [
      "the ledger PROBARION_LEDGER_PATH names",
      { PROBARION_LEDGER_PATH: "custom.jsonl" },
      "custom.jsonl",
    ],
  ])(
    "exits 64 when --offline --snapshot names %s, whether it exists or not",
    async (_name, env, out) => {
      const r = await cli(["verify", "--offline", FIXTURE, "--snapshot", out], env);
      expect(r.code).toBe(64);
      expect(r.err).toContain("--snapshot must be a different file from the ledger");
      await mkdir(join(dir, ".probarion"), { recursive: true });
      await writeFile(join(dir, ".probarion", "ledger.jsonl"), "ledger line\n");
      await writeFile(join(dir, "custom.jsonl"), "custom ledger line\n");
      const again = await cli(["verify", "--offline", FIXTURE, "--snapshot", out], env);
      expect(again.code).toBe(64);
      expect(again.err).toContain("--snapshot must be a different file from the ledger");
      expect(await readFile(join(dir, ".probarion", "ledger.jsonl"), "utf8")).toBe("ledger line\n");
      expect(await readFile(join(dir, "custom.jsonl"), "utf8")).toBe("custom ledger line\n");
    },
  );

  it("exits 64 on Windows when --offline --snapshot names the ledger in other letter case", async () => {
    const r = await cli(
      ["verify", "--offline", FIXTURE, "--snapshot", ".PROBARION/Ledger.JSONL"],
      {},
      { platform: "win32" },
    );
    expect(r.code).toBe(64);
    expect(r.err).toContain("--snapshot must be a different file from the ledger");
  });

  it("exits 64 when --offline --snapshot names a hard link of the ledger", async () => {
    await mkdir(join(dir, ".probarion"), { recursive: true });
    await writeFile(join(dir, ".probarion", "ledger.jsonl"), "ledger line\n");
    await link(join(dir, ".probarion", "ledger.jsonl"), join(dir, "alias.jsonl"));
    const r = await cli(["verify", "--offline", FIXTURE, "--snapshot", "alias.jsonl"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("--snapshot must be a different file from the ledger");
    expect(await readFile(join(dir, ".probarion", "ledger.jsonl"), "utf8")).toBe("ledger line\n");
  });

  it.each([
    ["--online", ["--online"]],
    ["--vault", ["--vault", SCENARIO_VAULT]],
    ["--ledger", ["--ledger", "l.jsonl"]],
    ["--burn-tx", ["--burn-tx", "2=4UViDBu8eHvNMe7WB24hDfDA5un4R5Wmy7ENLWGeRecF"]],
    ["--proof", ["--proof", "proof.json"]],
    ["--archival-rpc", ["--archival-rpc", "http://127.0.0.1:1"]],
    ["--evidence", ["--evidence", "docs/evidence"]],
  ])(
    "exits 64 when --offline is combined with %s, which needs a live vault",
    async (flag, more) => {
      const r = await cli(["verify", "--offline", FIXTURE, ...more]);
      expect(r.code).toBe(64);
      expect(r.err).toContain(flag);
      expect(r.out).toBe("");
    },
  );

  it.each([
    ["--rpc", ["--rpc", "http://127.0.0.1:1"]],
    ["--network", ["--network", "testnet"]],
  ])("exits 64 when --offline is combined with the global %s", async (flag, global) => {
    const r = await cli([...global, "verify", "--offline", FIXTURE]);
    expect(r.code).toBe(64);
    expect(r.err).toContain(flag);
  });
});

describe("probarion verify against a vault", () => {
  it("exits 0 for a vault the SDK just used, and saves the snapshot it verified", async () => {
    expect((await payNear(agentSdk())).status).toBe("paid");
    const sends = () =>
      server.methods.filter((m) => m === "send_tx" || m === "broadcast_tx_commit").length;
    const sentBefore = sends();
    const r = await cli(["--network", "testnet", ...live(), "--snapshot", "snap.json"]);
    expect(r.code).toBe(0);
    expect(sends()).toBe(sentBefore); // verify reads; it never sends a transaction
    expect(r.out).toContain(`Probarion verify: ${SCENARIO_VAULT} (testnet)`);
    expect(r.out).toContain("9 passed, 0 failed, 0 unproven");
    expect(r.out).toContain("RESULT: PASS");
    const saved = JSON.parse(await readFile(join(dir, "snap.json"), "utf8")) as Snapshot;
    expect(saved.ledger).toHaveLength(2);
    expect(saved.vault).toBe(SCENARIO_VAULT);
    // The saved snapshot verifies offline to the same result.
    const again = await cli(["verify", "--offline", "snap.json"]);
    expect(again.code).toBe(0);
  });

  it("exits 2 for an approved held payout (approver_tx), and 0 with the approver's tx from --burn-tx or --proof", async () => {
    expect(await holdBase(agentSdk())).toMatchObject({ status: "held", spendId: 1 });
    const approvedTx = await approveHeld(1);
    expect(server.chain.spends[0]?.status).toBe("burned");

    const unproven = await cli(live());
    expect(unproven.code).toBe(2);
    expect(unproven.out).toMatch(/^h {2}burn-memos +UNPROVEN /m);
    expect(unproven.out).toContain(
      "unproven: spend 1 (approver_tx): supply the burn tx with --burn-tx or --proof\n",
    );
    expect(unproven.out).not.toContain("when the snapshot is taken");
    expect(unproven.out).toContain("8 passed, 0 failed, 1 unproven");
    expect(unproven.out).toContain("RESULT: UNPROVEN");
    const json = await cli([...live(), "--json"]);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out)).toMatchObject({
      ok: false,
      unproven: [{ check: "h", spend_id: 1, reason: "approver_tx" }],
    });

    const withSigner = await cli([...live(), "--burn-tx", `1=${approvedTx}@${SCENARIO_APPROVER}`]);
    expect(withSigner.code).toBe(0);
    expect(withSigner.out).toContain("RESULT: PASS");
    const bare = await cli([...live(), "--burn-tx", `1=${approvedTx}`]);
    expect(bare.code).toBe(0);

    const proof = {
      v: 1,
      txs: {
        approve_held: {
          hash: approvedTx,
          network: "testnet",
          signer_id: SCENARIO_APPROVER,
          receiver_id: SCENARIO_VAULT,
          spend_id: 1,
          expect: "success",
        },
      },
    };
    await writeFile(join(dir, "proof.json"), JSON.stringify(proof));
    const fromProof = await cli([...live(), "--proof", "proof.json"]);
    expect(fromProof.code).toBe(0);
    expect(fromProof.out).toContain("RESULT: PASS");

    // A hinted tx that holds no burn pair (the reservation tx) fails h: exit 1, not 2.
    const wrong = await cli([...live(), "--burn-tx", `1=${spendTxHash(server.chain)}`]);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toMatch(/^h {2}burn-memos +FAIL /m);
    // --burn-tx and --proof merge: a wrong --burn-tx is tried first, the --proof tx still proves the burn.
    const merged = await cli([
      ...live(),
      "--burn-tx",
      `1=${spendTxHash(server.chain)}`,
      "--proof",
      "proof.json",
    ]);
    expect(merged.code).toBe(0);
  });

  it("--online also looks burns up in the tx index: an approver's payout is proven with no hint (exit 0)", async () => {
    await holdBase(agentSdk());
    const approvedTx = await approveHeld(1);
    const asked: string[] = [];
    const online = await cli(
      [...live(), "--online"],
      {},
      {
        verifyDeps: {
          onlineVerifier: null,
          txIndex: {
            accountTxs: async (account) => {
              asked.push(account);
              return [{ hash: approvedTx, isSigner: false }];
            },
          },
        },
      },
    );
    expect(asked).toEqual([SCENARIO_VAULT]);
    expect(online.code).toBe(0);
    expect(online.out).toContain("RESULT: PASS");
    // The same vault without --online: the index is not asked, and the burn stays unproven.
    const offline = await cli(
      live(),
      {},
      {
        verifyDeps: {
          txIndex: { accountTxs: async () => [{ hash: approvedTx, isSigner: false }] },
        },
      },
    );
    expect(offline.code).toBe(2);
  });

  it("never reads docs/mainnet-proof.json implicitly, from the working directory or the process cwd", async () => {
    await holdBase(agentSdk());
    const approvedTx = await approveHeld(1);
    const proof = {
      txs: {
        t: {
          hash: approvedTx,
          network: "testnet",
          signer_id: SCENARIO_APPROVER,
          receiver_id: SCENARIO_VAULT,
          spend_id: 1,
          expect: "success",
        },
      },
    };
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "mainnet-proof.json"), JSON.stringify(proof));
    const before = process.cwd();
    process.chdir(dir);
    try {
      const r = await cli(live());
      expect(r.code).toBe(2);
      expect(r.out).toContain("spend 1 (approver_tx)");
    } finally {
      process.chdir(before);
    }
    expect((await cli([...live(), "--proof", "docs/mainnet-proof.json"])).code).toBe(0);
  });

  it("exits 1 when --proof names a file that is missing or not JSON, and warns when it lists no tx of the vault", async () => {
    await payNear(agentSdk());
    const missing = await cli([...live(), "--proof", "nowhere.json"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("--proof nowhere.json");
    expect(missing.out).toBe("");
    await writeFile(join(dir, "broken.json"), "{ not json");
    const broken = await cli([...live(), "--proof", "broken.json"]);
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("--proof broken.json");
    await writeFile(join(dir, "other.json"), JSON.stringify({ txs: {} }));
    const other = await cli([...live(), "--proof", "other.json"]);
    expect(other.code).toBe(0);
    expect(other.err).toContain(`warning: --proof other.json records no tx of ${SCENARIO_VAULT}`);
  });

  const GOOD_HASH = "4UViDBu8eHvNMe7WB24hDfDA5un4R5Wmy7ENLWGeRecF";
  it.each([
    ["no =", "1"],
    ["no spend id", `=${GOOD_HASH}`],
    ["a spend id that is not a number", `x=${GOOD_HASH}`],
    ["a negative spend id", `-1=${GOOD_HASH}`],
    ["a spend id with a leading zero", `01=${GOOD_HASH}`],
    ["a fractional spend id", `1.5=${GOOD_HASH}`],
    ["a spend id above MAX_SAFE_INTEGER", `9007199254740992=${GOOD_HASH}`],
    ["no hash", "1="],
    ["a hash that is not base58 of 32 bytes", "1=notahash"],
    ["a hash of 31 bytes", "1=1111111111111111111111111111111"],
    ["an empty signer", `1=${GOOD_HASH}@`],
    ["a signer that is not an account id", `1=${GOOD_HASH}@Not An Account`],
    ["two signers", `1=${GOOD_HASH}@a.testnet@b.testnet`],
  ])("exits 64 for a malformed --burn-tx (%s), before any RPC call", async (_name, value) => {
    const r = await cli([...live(), "--burn-tx", value]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("--burn-tx");
    expect(r.out).toBe("");
    expect(server.methods).toEqual([]);
  });

  it("accepts spend ids 0 and MAX_SAFE_INTEGER in --burn-tx (exit 0: no burned spend has them)", async () => {
    await payNear(agentSdk());
    const r = await cli([
      ...live(),
      "--burn-tx",
      `9007199254740991=${GOOD_HASH}`,
      "--burn-tx",
      ` 0 = ${GOOD_HASH}@${SCENARIO_APPROVER}`,
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("RESULT: PASS");
  });

  it.each([
    ["--burn-tx with no value", ["--burn-tx"], "--burn-tx"],
    ["an unknown option", ["--bogus"], "--bogus"],
    ["--vault that is not an account id", ["--vault", "Not A Vault"], "--vault"],
    ["--archival-rpc with no URL", ["--archival-rpc", " , "], "--archival-rpc"],
    ["--snapshot onto the ledger file", ["--snapshot", ".probarion/ledger.jsonl"], "--snapshot"],
    ["--ledger with an empty path", ["--ledger", ""], "--ledger"],
  ])("exits 64 on a usage error (%s), before any RPC call", async (_name, more, named) => {
    const r = await cli([...live(), ...more]);
    expect(r.code).toBe(64);
    expect(r.err).toContain(named);
    expect(server.methods).toEqual([]);
  });

  it("exits 64 when --snapshot names the ledger under another name (a hard link), and leaves the ledger alone", async () => {
    await payNear(agentSdk());
    await link(defaultLedger(), join(dir, "alias.jsonl"));
    const before = await readFile(defaultLedger(), "utf8");
    const r = await cli([...live(), "--snapshot", "alias.jsonl"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("--snapshot must be a different file from the ledger");
    expect(await readFile(defaultLedger(), "utf8")).toBe(before);
  });

  it("exits 64 without --vault or PROBARION_VAULT_ID, and reads PROBARION_VAULT_ID", async () => {
    const none = await cli(["--rpc", server.url, "verify"]);
    expect(none.code).toBe(64);
    expect(none.err).toContain("--vault (or PROBARION_VAULT_ID) is required");
    await payNear(agentSdk());
    const fromEnv = await cli(["--rpc", server.url, "verify"], {
      PROBARION_VAULT_ID: SCENARIO_VAULT,
    });
    expect(fromEnv.code).toBe(0);
  });

  it("exits 2 (tx_unavailable) when the archival RPC cannot be reached, and 0 with --archival-rpc", async () => {
    const archival = await startFakeRpcServer(createScenarioChain());
    extraServers.push(archival);
    expect((await payBase(agentSdk())).status).toBe("burned");
    // The regular node no longer holds the payout tx; only the archival node does.
    for (const [hash, outcome] of server.chain.txs) archival.chain.txs.set(hash, outcome);
    server.chain.txs.clear();
    const closed = await startFakeRpcServer(createScenarioChain());
    const unreachable = closed.url;
    await closed.close();
    const env = { NEAR_ARCHIVAL_RPC_URLS: unreachable };

    const down = await cli(live(), env);
    expect(down.code).toBe(2);
    expect(down.out).toContain("unproven: spend 1 (tx_unavailable): re-run, or add --archival-rpc");
    expect(archival.methods).toEqual([]);

    const up = await cli([...live(), "--archival-rpc", archival.url], env);
    expect(up.code).toBe(0);
    expect(up.out).toContain("RESULT: PASS");
    expect(archival.methods).toContain("tx");
  });

  it("--online adds O1 and O2 to check e and says what O1 proves, and no more (exit 0; exit 1 when O1 refuses)", async () => {
    const fake = createFakeNearAi({
      respond: () =>
        JSON.stringify({
          action: "pay",
          mandate_id: 1,
          amount: "25000000",
          payee_hint: { near_account: SCENARIO_NEAR_PAYEE },
          reasoning: "TEST DOUBLE",
          confidence: 0.9,
        }),
    });
    const pb = agentSdk({
      model: { provider: "near-ai-cloud", apiKey: NEARAI_KEY },
      deps: {
        proposer: new NearAiProposer({
          apiKey: NEARAI_KEY,
          baseUrl: FAKE_NEARAI_BASE_URL,
          fetch: fake.fetch,
          now: () => NOW,
          sleep: async () => {},
        }),
      },
    });
    expect((await payNear(pb)).status).toBe("paid");
    const genuine: OnlineAttestationVerifier = {
      verifyQuote: async (quote) => ({
        reportDataHex: extractReportDataFromQuote(quote) ?? "",
        tcbStatus: "UpToDate",
        debugEnabled: false,
      }),
      verifyGpu: async () => {},
    };

    const offline = await cli(live());
    expect(offline.code).toBe(0);
    expect(offline.out).toContain("quote not verified offline (run --online for O1)");
    expect(offline.out).not.toContain("DCAP-genuine");

    const online = await cli(
      [...live(), "--online"],
      {},
      {
        verifyDeps: { onlineVerifier: genuine, txIndex: null },
      },
    );
    expect(online.code).toBe(0);
    expect(online.out).toContain("online: 1 DCAP-genuine TDX quotes bound to this request");
    // O1 ran on one quote: its legend, phrased as what O1 checks. The fake sends no GPU payload: O2 did not run.
    expect(online.out).toContain(
      "\nonline legend: O1 checks that a TDX quote is DCAP-genuine (Intel DCAP; debug off, an accepted TCB status) and bound to this request; measurement not pinned (O1b deferred)",
    );
    expect(online.out).toContain(
      "\nonline: O2 did not run (no attested decision carries a GPU payload)\n",
    );
    expect(online.out).not.toContain("online legend: O2");
    expect(online.out).not.toMatch(/verified TEE|TEE verified|attested model verified/i);
    // The "did not run" line reaches stderr too (0 GPU payloads); the legend stays in the report.
    expect(online.err).toBe(
      "warning: online: O2 did not run (no attested decision carries a GPU payload)\n",
    );

    const debug: OnlineAttestationVerifier = {
      ...genuine,
      verifyQuote: async (quote) => ({ ...(await genuine.verifyQuote(quote)), debugEnabled: true }),
    };
    const refused = await cli(
      [...live(), "--online"],
      {},
      {
        verifyDeps: { onlineVerifier: debug, txIndex: null },
      },
    );
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/^e {2}attestations +FAIL .*O1 failed at entry 0/m);
    expect(refused.out).toContain("RESULT: FAIL (first broken seq 0)");
    expect(refused.out).not.toContain("online legend");

    const unavailable = await cli(
      [...live(), "--online"],
      {},
      {
        verifyDeps: { onlineVerifier: null, txIndex: null },
      },
    );
    expect(unavailable.code).toBe(0);
    expect(unavailable.out).toContain("online: unavailable");
    expect(unavailable.out).not.toContain("online: 1 DCAP-genuine");
    expect(unavailable.out).toContain(
      "\nonline: O1 and O2 did not run (no online verifier was given)\n",
    );
    expect(unavailable.err).toBe(
      "warning: online: O1 and O2 did not run (no online verifier was given)\n",
    );
    expect(unavailable.out).not.toContain("online legend");
    const json = await cli(
      [...live(), "--online", "--json"],
      {},
      {
        verifyDeps: { onlineVerifier: null, txIndex: null },
      },
    );
    expect(JSON.parse(json.out)).toMatchObject({ ok: true });
    expect(json.err).toContain("online: O1 and O2 did not run (no online verifier was given)");
  });

  it("--online when NVIDIA's token is not yet valid: check e fails (exit 1), and the clock hint goes to stderr, with --json too", async () => {
    const fake = createFakeNearAi({
      respond: () =>
        JSON.stringify({
          action: "pay",
          mandate_id: 1,
          amount: "25000000",
          payee_hint: { near_account: SCENARIO_NEAR_PAYEE },
          reasoning: "TEST DOUBLE",
          confidence: 0.9,
        }),
    });
    const pb = agentSdk({
      model: { provider: "near-ai-cloud", apiKey: NEARAI_KEY },
      deps: {
        proposer: new NearAiProposer({
          apiKey: NEARAI_KEY,
          baseUrl: FAKE_NEARAI_BASE_URL,
          fetch: fake.fetch,
          now: () => NOW,
          sleep: async () => {},
        }),
      },
    });
    expect((await payNear(pb)).status).toBe("paid");
    // The fake sends no GPU payload, so the SDK's not_yet_valid error is thrown at the quote here: the SDK reports a
    // throw from O1 or O2 the same way ("O1/O2 failed at entry N: <message>").
    const early: OnlineAttestationVerifier = {
      verifyQuote: async () => {
        throw new Error(
          "[gpu.jwt_verification_failed] NVIDIA JWT verification failed: not_yet_valid",
        );
      },
      verifyGpu: async () => {},
    };
    const deps = { verifyDeps: { onlineVerifier: early, txIndex: null } };

    const text = await cli([...live(), "--online"], {}, deps);
    expect(text.code).toBe(1);
    expect(text.out).toMatch(
      /^e {2}attestations +FAIL +online: O1\/O2 failed at entry 0: .*not_yet_valid/m,
    );
    expect(text.out).toContain(`\n${CLOCK_HINT}\n`);
    expect(text.out).not.toContain("online legend");
    expect(text.err).toBe(`warning: ${CLOCK_HINT}\n`);

    const json = await cli([...live(), "--online", "--json"], {}, deps);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false });
    expect(json.out).not.toContain("online hint");
    expect(json.err.match(/^warning: online hint: /gm)).toHaveLength(1);
    expect(json.err).toBe(`warning: ${CLOCK_HINT}\n`);
  });

  it("--online on a ledger with no attested decision: O1 and O2 did not run, and no legend (exit 0)", async () => {
    await payNear(agentSdk());
    const genuine: OnlineAttestationVerifier = {
      verifyQuote: async () => {
        throw new Error("no quote should be verified");
      },
      verifyGpu: async () => {},
    };
    const r = await cli(
      [...live(), "--online"],
      {},
      {
        verifyDeps: { onlineVerifier: genuine, txIndex: null },
      },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("online: 0 DCAP-genuine TDX quotes");
    expect(r.out).toContain(
      "\nonline: O1 and O2 did not run (no attested decision in this ledger)\n",
    );
    expect(r.out).not.toContain("online legend");
    expect(r.err).toBe(
      "warning: online: O1 and O2 did not run (no attested decision in this ledger)\n",
    );
  });

  it("--online loads @nearai/inference-sdk itself, from probarion's own optional dependency", async () => {
    await payNear(agentSdk());
    // What this test process can load from packages/cli is what the CLI can load: the same resolution.
    const specifier = "@nearai/inference-sdk";
    const loadable = await import(specifier).then(
      (mod: Record<string, unknown>) =>
        typeof mod.createTdxQuoteVerifier === "function" &&
        typeof mod.createGpuEvidenceVerifier === "function",
      () => false,
    );
    const r = await cli([...live(), "--online"], {}, { verifyDeps: { txIndex: null } });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("online legend");
    if (loadable) {
      expect(r.out).toContain("online: 0 DCAP-genuine TDX quotes");
      expect(r.out).toContain(
        "online: O1 and O2 did not run (no attested decision in this ledger)",
      );
      expect(r.err).not.toContain("could not be loaded");
      expect(r.err).toContain("warning: online: O1 and O2 did not run (no attested decision");
    } else {
      expect(r.out).toContain(
        "online: O1 and O2 did not run (@nearai/inference-sdk could not be loaded",
      );
      expect(r.err).toContain("warning: online: O1 and O2 did not run (@nearai/inference-sdk");
    }
  });

  it("exits 64 when --snapshot names a file that exists, before any RPC call, and leaves it alone", async () => {
    await writeFile(join(dir, "taken.json"), "keep me\n");
    const r = await cli([...live(), "--snapshot", "taken.json"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("--snapshot taken.json already exists: choose a new file");
    expect(server.methods).toEqual([]);
    expect(await readFile(join(dir, "taken.json"), "utf8")).toBe("keep me\n");
  });

  it("reads the ledger from --ledger, else PROBARION_LEDGER_PATH, else .probarion/ledger.jsonl (empty counts as unset)", async () => {
    await payNear(agentSdk({ ledgerPath: join(dir, "custom.jsonl") }));
    const fromEnv = await cli(live(), { PROBARION_LEDGER_PATH: "custom.jsonl" });
    expect(fromEnv.code).toBe(0);
    expect(fromEnv.out).toContain("entries 2,");
    const fromFlag = await cli([...live(), "--ledger", "custom.jsonl"], {
      PROBARION_LEDGER_PATH: "elsewhere.jsonl",
    });
    expect(fromFlag.code).toBe(0);
    expect(fromFlag.out).toContain("entries 2,");
    // R12: an empty value falls back to .probarion/ledger.jsonl, which does not exist here.
    const empty = await cli(live(), { PROBARION_LEDGER_PATH: "" });
    expect(empty.code).toBe(1);
    expect(empty.err).toContain(
      "warning: the ledger file ./.probarion/ledger.jsonl does not exist",
    );
    expect(empty.out).toContain("entries 0,");
  });

  it("warns when the ledger file does not exist, and fails the spends it cannot bind (exit 1)", async () => {
    await payNear(agentSdk());
    const r = await cli([...live(), "--ledger", "missing.jsonl"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("warning: the ledger file ./missing.jsonl does not exist");
    expect(r.out).toMatch(/^d {2}spends-have-decisions +FAIL /m);
  });

  it("exits 1 with an error and no RESULT line when the RPC cannot be reached", async () => {
    const closed = await startFakeRpcServer(createScenarioChain());
    const unreachable = closed.url;
    await closed.close();
    const r = await cli(["--rpc", unreachable, "verify", "--vault", SCENARIO_VAULT]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^error: /m);
    expect(r.out).not.toContain("RESULT");
  });

  it("lists its exit codes 0, 1, 2 and 64 in --help", async () => {
    const r = await cli(["verify", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Exit codes:/);
    expect(r.out).toMatch(/^ {2}0 {3}every check passes/m);
    expect(r.out).toMatch(/^ {2}1 {3}a check fails/m);
    expect(r.out).toMatch(/^ {2}2 {3}no check fails, but at least one is unproven/m);
    expect(r.out).toMatch(/^ {2}64 {2}usage error/m);
    for (const flag of ["--offline", "--snapshot", "--online", "--burn-tx", "--proof"]) {
      expect(r.out).toContain(flag);
    }
    expect(r.out).toContain("--archival-rpc");
    expect(r.out).toContain("--evidence");
    expect(r.out).toContain("--invoice <file>");
    expect(r.out).toContain("--invoices <dir>");
    expect(r.out).toContain("--invoice and --invoices add A8 to check e, live or with --offline");
    expect(r.out).toContain("--system-prompt <file>");
    expect(r.out).toContain("A8 accepts only the standard system prompt (PROPOSAL_SYSTEM_PROMPT)");
  });
});

// ---------- A8 with the invoices the reader holds (--invoice, --invoices) ----------

const CORE_FIXTURES = fileURLToPath(new URL("../../core/test/fixtures/", import.meta.url));
const DEMO_VAULT = fileURLToPath(new URL("../../../docs/evidence/demo-vault/", import.meta.url));
const DEMO_SNAPSHOT = join(DEMO_VAULT, "snapshot-2026-11-12-video.json");
const DEMO_ATTESTED = ["2006", "2007", "2008", "2009", "2010"].map((n) =>
  join(DEMO_VAULT, `invoice-INV-${n}.txt`),
);
const a8Passes = (n: number, seqs: string) =>
  `A8 (request binding and mandate match) passes for ${n} of ${n} attested decisions (seq ${seqs})`;

/** A folder `held` in the test dir with copies of the core fixture's invoice texts and two other files. */
async function heldInvoices(): Promise<void> {
  await mkdir(join(dir, "held"));
  for (const f of ["invoice-a.txt", "invoice-b.txt", "invoice-injected.txt"]) {
    await copyFile(join(CORE_FIXTURES, f), join(dir, "held", f));
  }
  await writeFile(join(dir, "held", "notes.txt"), "TEST: not an invoice of this vault\n");
  await writeFile(
    join(dir, "held", "readme.md"),
    "TEST: not read, the name does not end in .txt\n",
  );
}

/** The model's answer of the fake NEAR AI: pay 25 USDC under mandate 1 to its payee. */
const PAY_NEAR = JSON.stringify({
  action: "pay",
  mandate_id: 1,
  amount: "25000000",
  payee_hint: { near_account: SCENARIO_NEAR_PAYEE },
  reasoning: "TEST DOUBLE",
  confidence: 0.9,
});

function fakeProposer(systemPrompt?: string): NearAiProposer {
  const fake = createFakeNearAi({ respond: () => PAY_NEAR });
  return new NearAiProposer({
    apiKey: NEARAI_KEY,
    baseUrl: FAKE_NEARAI_BASE_URL,
    fetch: fake.fetch,
    now: () => NOW,
    sleep: async () => {},
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  });
}

describe("probarion verify --invoice and --invoices (A8)", () => {
  it("runs A8 offline on the TEST FIXTURE snapshot: both attested decisions pass, and the files A8 does not check are listed (exit 0)", async () => {
    await heldInvoices();
    const r = await cli(["verify", "--offline", FIXTURE, "--invoices", "held"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /^e {2}attestations +PASS .*A8 \(request binding and mandate match\) passes for 2 of 2 attested decisions \(seq 0, 2\)/m,
    );
    expect(r.out).not.toContain("A8 not run");
    expect(r.out).toContain(
      "\ninvoices: 4 files read; A8 checks 2 of them against the attested decisions with their sha256 (check e gives the result): held/invoice-a.txt (seq 0), held/invoice-b.txt (seq 2)\n",
    );
    const notAttested =
      "invoices: 1 file matches only ledger entries that are not attested decisions, so A8 does not check it: held/invoice-injected.txt (seq 4)";
    const unmatched =
      "invoices: 1 file matches no ledger entry (its sha256 is no entry's invoice_hash), so A8 does not check it: held/notes.txt";
    expect(r.out).toContain(`\n${notAttested}\n${unmatched}\n9 passed, 0 failed, 0 unproven\n`);
    expect(r.out).not.toContain("readme.md");
    expect(r.out).toMatch(/\nRESULT: PASS\n$/);
    expect(r.err).toBe(`warning: ${notAttested}\nwarning: ${unmatched}\n`);
    expect(server.methods).toEqual([]);

    // --json: each file by name and sha256, with the entries it matches; no invoice text.
    const json = await cli(["verify", "--offline", FIXTURE, "--invoices", "held", "--json"]);
    expect(json.code).toBe(0);
    const text = (f: string) => readFile(join(CORE_FIXTURES, f), "utf8");
    const hash = async (f: string) => sha256Hex(await text(f));
    expect(JSON.parse(json.out).invoices).toEqual([
      {
        file: "held/invoice-a.txt",
        sha256: await hash("invoice-a.txt"),
        seqs: [0, 1],
        attested_seqs: [0],
      },
      {
        file: "held/invoice-b.txt",
        sha256: await hash("invoice-b.txt"),
        seqs: [2, 3],
        attested_seqs: [2],
      },
      {
        file: "held/invoice-injected.txt",
        sha256: await hash("invoice-injected.txt"),
        seqs: [4],
        attested_seqs: [],
      },
      {
        file: "held/notes.txt",
        sha256: sha256Hex("TEST: not an invoice of this vault\n"),
        seqs: [],
        attested_seqs: [],
      },
    ]);
    for (const f of ["invoice-a.txt", "invoice-b.txt"]) {
      const first = (await text(f)).split("\n")[0] ?? "";
      expect(first.length).toBeGreaterThan(10);
      expect(json.out).not.toContain(first);
      expect(r.out).not.toContain(first);
    }
  });

  it("passes A8 on the demo vault's five attested decisions, with the invoices committed beside its snapshot", async () => {
    const args = DEMO_ATTESTED.flatMap((f) => ["--invoice", f]);
    const r = await cli(["verify", "--offline", DEMO_SNAPSHOT, ...args]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("entries 17, anchors 12");
    expect(r.out).toMatch(/^e {2}attestations +PASS .*5 attested decisions pass A1–A7/m);
    expect(r.out).toContain(a8Passes(5, "10, 11, 12, 13, 15"));
    expect(r.out).toContain("invoices: 5 files read; A8 checks 5 of them");
    expect(r.out).toContain("9 passed, 0 failed, 0 unproven");
    expect(r.err).toBe("");
  });

  it("lists an edited copy of an invoice as matching no ledger entry: A8 does not run for its decision, and the run does not fail (exit 0)", async () => {
    const original = await readFile(join(CORE_FIXTURES, "invoice-a.txt"), "utf8");
    await writeFile(join(dir, "edited.txt"), original.replace("25.00", "52.00"));
    const r = await cli(["verify", "--offline", FIXTURE, "--invoice", "edited.txt"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "A8 (request binding and mandate match) passes for 0 of 2 attested decisions; A8 not run for seq 0 (no invoice text supplied for invoice_hash",
    );
    expect(r.out).toContain(
      "\ninvoices: 1 file read; none is the invoice of an attested decision, so A8 checks none\n",
    );
    expect(r.err).toBe(
      "warning: invoices: 1 file matches no ledger entry (its sha256 is no entry's invoice_hash), so A8 does not check it: edited.txt\n",
    );
  });

  it("runs A8 on a live verify, and writes no invoice text into the --snapshot it saves", async () => {
    const pb = agentSdk({
      model: { provider: "near-ai-cloud", apiKey: NEARAI_KEY },
      deps: { proposer: fakeProposer() },
    });
    expect((await payNear(pb)).status).toBe("paid");
    const text = "Invoice INV-1 for PO-1001";
    await writeFile(join(dir, "INV-1.txt"), text);
    const r = await cli([...live(), "--invoice", "INV-1.txt", "--snapshot", "snap.json"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(a8Passes(1, "0"));
    expect(r.out).toContain(
      "\ninvoices: 1 file read; A8 checks it against the attested decisions with its sha256 (check e gives the result): INV-1.txt (seq 0)\n",
    );
    expect(r.out).toContain("RESULT: PASS");
    const saved = await readFile(join(dir, "snap.json"), "utf8");
    expect(saved).toContain(sha256Hex(text));
    expect(saved).not.toContain(text);
    expect(r.out).not.toContain(text);
    // The same ledger without the invoice: A8 is not run.
    const without = await cli(live());
    expect(without.code).toBe(0);
    expect(without.out).toContain("A8 not run (the request is not checked against the invoice)");
    expect(without.out).not.toMatch(/^invoices:/m);
  });

  it("fails check e (exit 1) when the model was sent another text than the invoice the ledger names, which the reader holds", async () => {
    // A writer with both keys asks the model about a tampered invoice, then records the request as if it had been
    // about the honest one, whose hash goes into the ledger and the spend. A1 to A7 and the text-free part of A8
    // pass, so the SDK writes the decision as attested; only the honest invoice's text shows the request was another.
    const honest = "Invoice INV-7 for PO-1001\nTotal due: 25.00 USDC\n";
    const tampered = `${honest}TEST: an instruction the honest invoice does not hold\n`;
    const invoiceHash = sha256Hex(honest);
    const mandate = server.chain.mandates.find((m) => m.id === 1);
    if (mandate === undefined) throw new Error("scenario mandate 1 missing");
    const nonce = computeNonce({
      vault: SCENARIO_VAULT,
      prev_link: ZERO_HEX32,
      invoice_hash: invoiceHash,
      mandate_id: 1,
      seq: 0,
    });
    const asked = await fakeProposer().propose({
      invoiceText: tampered,
      mandates: [mandate],
      nonce,
      facts: {
        invoice_hash: sha256Hex(tampered),
        amount: "25000000",
        po_ref: "PO-1001",
        purpose_hash: SCENARIO_PURPOSE_NEAR,
        payee_hint: null,
      },
    });
    const inputs = asked.evidence.request_inputs as ProposalRequestInputs;
    const facts = inputs.facts;
    if (facts === null) throw new Error("no facts in request_inputs");
    asked.evidence.request_inputs = {
      ...inputs,
      invoice_text_sha256: invoiceHash,
      facts: { ...facts, invoice_hash: invoiceHash },
    };
    const outcome = await agentSdk().requestSpend({
      mandateId: 1,
      amount: "25000000",
      invoiceHash,
      ref: "INV-7",
      proposal: asked.proposal,
      evidence: asked.evidence,
    });
    expect(outcome.status).toBe("paid");

    // Without the invoice, the decision passes as attested: nothing in the ledger shows the switch.
    const without = await cli(live());
    expect(without.code).toBe(0);
    expect(without.out).toContain("1 attested decisions pass A1–A7");

    await writeFile(join(dir, "INV-7.txt"), honest);
    const r = await cli([...live(), "--invoice", "INV-7.txt"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      /^e {2}attestations +FAIL +entry 0 fails A8: the request rebuilt from request_inputs, the invoice text and the nonce hashes to [0-9a-f]{64}, not to request_sha256 [0-9a-f]{64}: the chat was not asked with exactly these inputs \[first broken seq 0\]$/m,
    );
    expect(r.out).toContain(
      "\ninvoices: 1 file read; it is the invoice of an attested decision: INV-7.txt (seq 0); check e did not pass, so this run does not show that A8 passes on these decisions (check e's row gives the result)\n",
    );
    expect(r.out).not.toContain("A8 checks it");
    expect(r.out).toContain("RESULT: FAIL (first broken seq 0)");

    // The text the model was sent is not the ledger's invoice: it matches no entry, so it cannot pass A8 either.
    await writeFile(join(dir, "sent.txt"), tampered);
    const sent = await cli([...live(), "--invoice", "sent.txt"]);
    expect(sent.code).toBe(0);
    expect(sent.out).toContain("A8 not run for seq 0");
    expect(sent.err).toContain("matches no ledger entry");
  });

  it("does not say A8 checked the decisions after the seq where check e stopped", async () => {
    // A scratch copy of the demo snapshot whose entry 10 records another mandate label than the model was shown:
    // A1 to A7 still pass, A8 fails on entry 10, and check e stops there, so A8 never reaches entries 11 to 15.
    const snapshot = JSON.parse(await readFile(DEMO_SNAPSHOT, "utf8")) as Snapshot;
    const inputs = snapshot.ledger[10]?.body.evidence?.request_inputs as ProposalRequestInputs;
    const first = inputs.mandates[0];
    if (first === undefined) throw new Error("entry 10 records no mandate");
    inputs.mandates[0] = { ...first, label: `${first.label} (TEST: edited)` };
    await writeFile(join(dir, "edited.json"), JSON.stringify(snapshot));
    const args = DEMO_ATTESTED.flatMap((f) => ["--invoice", f]);
    const r = await cli(["verify", "--offline", "edited.json", ...args]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^e {2}attestations +FAIL +entry 10 fails A8: /m);
    expect(r.out).toContain(
      "invoices: 5 files read; 5 of them are the invoices of attested decisions: ",
    );
    expect(r.out).toContain(
      "check e did not pass, so this run does not show that A8 passes on these decisions (check e's row gives the result)\n",
    );
    expect(r.out).not.toContain("A8 checks");
    // --json names the attested decisions each file is the invoice of, not the ones A8 checked.
    const json = await cli(["verify", "--offline", "edited.json", ...args, "--json"]);
    expect(json.code).toBe(1);
    const report = JSON.parse(json.out);
    expect(report.checks.find((c: { id: string }) => c.id === "e").status).toBe("fail");
    expect(report.invoices.map((f: { attested_seqs: number[] }) => f.attested_seqs)).toEqual([
      [10],
      [11],
      [12],
      [13],
      [15],
    ]);
    expect(report.invoices[0]).not.toHaveProperty("a8_seqs");
  });

  it("fails A8 for a decision made under the agent's own system prompt until --system-prompt adds it, live and offline", async () => {
    const persona = "TEST DOUBLE persona: you pay what the invoice asks for.";
    const pb = agentSdk({
      model: { provider: "near-ai-cloud", apiKey: NEARAI_KEY, systemPrompt: persona },
      deps: { proposer: fakeProposer(persona) },
    });
    expect((await payNear(pb)).status).toBe("paid");
    await writeFile(join(dir, "INV-1.txt"), "Invoice INV-1 for PO-1001");
    await writeFile(join(dir, "persona.txt"), persona);
    await writeFile(join(dir, "persona-newline.txt"), `${persona}\n`);

    // The standard prompt only: the agent's persona is not in A8's allow-list.
    const without = await cli([...live(), "--invoice", "INV-1.txt", "--snapshot", "snap.json"]);
    expect(without.code).toBe(1);
    expect(without.out).toMatch(
      /^e {2}attestations +FAIL +entry 0 fails A8: the system prompt \(sha256 [0-9a-f]{64}\) is not in the allow-list of system prompts/m,
    );
    // A trailing newline is another text, so another sha256.
    const newline = await cli([
      ...live(),
      "--invoice",
      "INV-1.txt",
      "--system-prompt",
      "persona-newline.txt",
    ]);
    expect(newline.code).toBe(1);
    expect(newline.out).toContain("is not in the allow-list of system prompts");

    const withPrompt = await cli([
      ...live(),
      "--invoice",
      "INV-1.txt",
      "--system-prompt",
      "persona.txt",
    ]);
    expect(withPrompt.code).toBe(0);
    expect(withPrompt.out).toContain(a8Passes(1, "0"));
    expect(withPrompt.out).not.toContain(persona);

    // Offline, on the snapshot the first run saved: the same.
    const offline = await cli(["verify", "--offline", "snap.json", "--invoice", "INV-1.txt"]);
    expect(offline.code).toBe(1);
    expect(offline.out).toContain("is not in the allow-list of system prompts");
    const offlineWith = await cli([
      "verify",
      "--offline",
      "snap.json",
      "--invoice",
      "INV-1.txt",
      "--system-prompt",
      "persona.txt",
    ]);
    expect(offlineWith.code).toBe(0);
    expect(offlineWith.out).toContain(a8Passes(1, "0"));
    // The standard prompt stays in the list: the demo vault's decisions still pass with a persona added.
    const demo = await cli([
      "verify",
      "--offline",
      DEMO_SNAPSHOT,
      ...DEMO_ATTESTED.flatMap((f) => ["--invoice", f]),
      "--system-prompt",
      "persona.txt",
    ]);
    expect(demo.code).toBe(0);
    expect(demo.out).toContain(a8Passes(5, "10, 11, 12, 13, 15"));
  });

  it("reads a symbolic link in an --invoices folder as the file it points to, and skips one to a folder", async (context) => {
    await heldInvoices();
    await mkdir(join(dir, "linked"));
    // A junction needs no privilege on Windows; it is a link to a folder, so the listing skips it like a subfolder.
    await symlink(join(dir, "held"), join(dir, "linked", "folder.txt"), "junction");
    const onlyFolder = await cli(["verify", "--offline", FIXTURE, "--invoices", "linked"]);
    expect(onlyFolder.code).toBe(64);
    expect(onlyFolder.err).toContain("error: --invoices linked holds no .txt file");
    try {
      await symlink(join(dir, "held", "invoice-a.txt"), join(dir, "linked", "a.txt"), "file");
    } catch {
      // Windows without the privilege to create a file symlink: nothing more to check here.
      context.skip();
    }
    const r = await cli(["verify", "--offline", FIXTURE, "--invoices", "linked"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "\ninvoices: 1 file read; A8 checks it against the attested decisions with its sha256 (check e gives the result): linked/a.txt (seq 0)\n",
    );
  });

  it("exits 64 for an --invoice or --invoices it cannot use, before it reads the snapshot or the chain", async () => {
    await mkdir(join(dir, "empty"));
    await mkdir(join(dir, "no-txt"));
    await writeFile(join(dir, "no-txt", "invoice.md"), "TEST\n");
    await writeFile(join(dir, "latin1.txt"), Buffer.from([0x49, 0x4e, 0x56, 0xe9, 0x0a]));
    await writeFile(join(dir, "held.txt"), "TEST: an invoice text\n");
    await writeFile(join(dir, "prompt.txt"), "TEST: a system prompt\n");
    await writeFile(join(dir, "blank.txt"), "");
    const cases: [string[], string][] = [
      [["--invoice", "missing.txt"], "error: --invoice missing.txt is not a readable file"],
      [["--invoice", "empty"], "error: --invoice empty is not a readable file"],
      [["--invoice", " "], "error: --invoice needs a file"],
      [["--invoices", "missing"], "error: --invoices missing is not a readable directory"],
      [["--invoices", "empty"], "error: --invoices empty holds no .txt file"],
      [["--invoices", "no-txt"], "error: --invoices no-txt holds no .txt file"],
      [["--invoice", "latin1.txt"], "error: --invoice latin1.txt is not UTF-8 text"],
      [
        ["--system-prompt", "prompt.txt"],
        "error: --system-prompt extends the prompts A8 accepts, and A8 runs only with --invoice or --invoices",
      ],
      [
        ["--invoice", "held.txt", "--system-prompt", "missing.txt"],
        "error: --system-prompt missing.txt is not a readable file",
      ],
      [
        ["--invoice", "held.txt", "--system-prompt", "blank.txt"],
        "error: --system-prompt blank.txt is empty",
      ],
      [
        ["--invoice", "held.txt", "--system-prompt", "latin1.txt"],
        "error: --system-prompt latin1.txt is not UTF-8 text: pass the exact text of the prompt",
      ],
      [["--invoice", "held.txt", "--system-prompt", " "], "error: --system-prompt needs a file"],
    ];
    for (const [flags, message] of cases) {
      const offline = await cli(["verify", "--offline", "not-there.json", ...flags]);
      expect(offline.code, flags.join(" ")).toBe(64);
      expect(offline.err, flags.join(" ")).toContain(message);
      expect(offline.out).toBe("");
      const liveRun = await cli([...live(), ...flags]);
      expect(liveRun.code, flags.join(" ")).toBe(64);
      expect(liveRun.err, flags.join(" ")).toContain(message);
    }
    expect(server.methods).toEqual([]);
  });
});

// ---------- mainnet v0: the Day-4 vault whose spends predate the ledger (--evidence) ----------

const V0 = "v0.probarion.near";
const M = NETWORKS.mainnet;
const V0_BASE_ADDRESS = "0x3333333333333333333333333333333333333333";
/** base58(sha256("TEST DOUBLE v0 Base payout tx")): a well-formed NEAR tx hash (the CLI has no base58 dependency). */
const V0BURN = "Fmen8uUKQMUkikUYkLz915J5SUZZoi7AXuHeyaFqPPet";
const RECORD_1 =
  '{"kind":"v0-manual-decision","mandate_id":1,"amount":"2000000","verdict":"allow"}\n';
const RECORD_2 =
  '{"kind":"v0-manual-decision","mandate_id":2,"amount":"2000000","verdict":"allow"}\n';

function v0Mandate(
  over: Partial<MandateView> & Pick<MandateView, "id" | "payee" | "label">,
): MandateView {
  return {
    purpose_hash: sha256Hex(`TEST DOUBLE v0 purpose ${over.id}`),
    max_per_payment: "100000000",
    max_total: "1000000000",
    spent: "0",
    reserved: "0",
    max_uses: 10,
    uses: 0,
    expires_at_ns: "1798761600000000000",
    approval_above: "50000000",
    agent_pk: TEST_KEYS.agent.publicKey,
    status: "active",
    created_at_ns: "1793600000000000000",
    ...over,
  };
}

function v0Spend(id: number, decisionHash: string, status: SpendView["status"]): SpendView {
  return {
    id,
    mandate_id: id,
    amount: "2000000",
    invoice_hash: sha256Hex(`TEST DOUBLE v0 invoice ${id}`),
    ref: `V0-${id}`,
    decision_hash: decisionHash,
    agent_pk: TEST_KEYS.agent.publicKey,
    destination:
      status === "burned"
        ? { type: "intents", chain: "base", address: V0_BASE_ADDRESS, asset: M.allowedAssets.base }
        : { type: "near", account_id: "vendor.near" },
    status,
    created_at_ns: "1793700000000000000",
    held_until_ns: null,
    memo: status === "burned" ? `WITHDRAW_TO:${V0_BASE_ADDRESS}` : null,
  };
}

/** The Day-4 Base payout tx as mainnet logs it: intents.near's mt_burn and the POA token's ft_burn. */
function v0BurnTx(hash: string): Record<string, unknown> {
  const event = (standard: string, name: string, data: unknown) =>
    `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event: name, data })}`;
  const outcome = (id: string, executor: string, logs: string[]) => ({
    id,
    outcome: { logs, receipt_ids: [], executor_id: executor, status: { SuccessValue: "" } },
  });
  return {
    status: { SuccessValue: "" },
    transaction: { hash, signer_id: V0, receiver_id: V0 },
    transaction_outcome: outcome(hash, V0, []),
    receipts_outcome: [
      outcome("r1", V0, []),
      outcome("r2", M.intents, [
        event("nep245", "mt_burn", [
          { owner_id: V0, token_ids: [`nep141:${M.allowedAssets.base}`], amounts: ["2000000"] },
        ]),
      ]),
      outcome("r3", M.allowedAssets.base, [
        event("nep141", "ft_burn", [
          { owner_id: M.intents, amount: "2000000", memo: `WITHDRAW_TO:${V0_BASE_ADDRESS}` },
        ]),
      ]),
    ],
  };
}

describe("probarion verify on mainnet v0 (--evidence)", () => {
  beforeEach(async () => {
    await server.close();
    server = await startFakeRpcServer(
      new FakeChain({
        vaultId: V0,
        codeHash: KNOWN_VAULT_CODE_HASHES[0] as string,
        codeMode: "local",
        burnShape: "mainnet",
        nowNs: () => BigInt(NOW.getTime()) * 1_000_000n,
        config: {
          owner: "owner.near",
          approvers: ["approver.near"],
          usdc: M.usdc,
          intents: M.intents,
          allowed_assets: [M.allowedAssets.base, M.allowedAssets.solana],
          daily_backstop: "500000000",
          held_ttl_ns: "259200000000000",
          frozen: false,
          factory: null,
          version: "0.1.0",
          ledger_key: TEST_KEYS.ledger.publicKey,
        },
        mandates: [
          v0Mandate({
            id: 1,
            payee: { type: "near", account_id: "vendor.near" },
            label: "TEST DOUBLE v0 NEAR",
          }),
          v0Mandate({
            id: 2,
            payee: {
              type: "intents",
              chain: "base",
              address: V0_BASE_ADDRESS,
              asset: M.allowedAssets.base,
            },
            label: "TEST DOUBLE v0 Base",
          }),
        ],
        spends: [
          v0Spend(1, sha256Hex(RECORD_1), "paid"),
          v0Spend(2, sha256Hex(RECORD_2), "burned"),
        ],
        agentKeys: [{ publicKey: TEST_KEYS.agent.publicKey, label: "TEST DOUBLE agent" }],
      }),
    );
    await mkdir(join(dir, "evidence"), { recursive: true });
    await writeFile(join(dir, "evidence", "v0-decision-1.json"), RECORD_1);
    await writeFile(join(dir, "evidence", "v0-decision-2.json"), RECORD_2);
  });

  const v0 = () => ["--network", "mainnet", "--rpc", server.url, "verify", "--vault", V0];

  it("exits 2 with the Day-4 Base payout unproven (pre_ledger_no_tx), and 0 with its tx from --burn-tx", async () => {
    expect(isNearTxHash(V0BURN)).toBe(true);
    const r = await cli([...v0(), "--evidence", "evidence"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/^d {2}spends-have-decisions +PASS /m);
    expect(r.out).toContain(
      "unproven: spend 2 (pre_ledger_no_tx): supply the burn tx with --burn-tx or --proof",
    );
    expect(r.out).toContain("7 passed, 0 failed, 1 unproven, 1 skipped");
    expect(r.out).toMatch(/^i {2}factory-version +SKIP /m);
    server.chain.txs.set(V0BURN, v0BurnTx(V0BURN) as never);
    const proven = await cli([...v0(), "--evidence", "evidence", "--burn-tx", `2=${V0BURN}`]);
    expect(proven.code).toBe(0);
    expect(proven.out).toContain("RESULT: PASS");
  });

  it("exits 1 with a warning when the --evidence directory holds no Day-4 records (check d fails)", async () => {
    const r = await cli(v0());
    expect(r.code).toBe(1);
    expect(r.err).toContain("warning: no v0-decision-*.json in ./docs/evidence");
    expect(r.out).toMatch(/^d {2}spends-have-decisions +FAIL /m);
  });
});

describe("probarion ledger export", () => {
  it("exports the ledger the SDK wrote, entry for entry", async () => {
    await payNear(agentSdk());
    const r = await cli(["ledger", "export", "--out", "export.jsonl"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("exported 2 entries to ./export.jsonl");
    const lines = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
    const exported = await readFile(join(dir, "export.jsonl"), "utf8");
    expect(lines(exported)).toHaveLength(2);
    expect(lines(exported)).toEqual(lines(await readFile(defaultLedger(), "utf8")));
  });

  it("reads the ledger path from PROBARION_LEDGER_PATH, and --ledger over it", async () => {
    await writeFile(join(dir, "custom.jsonl"), "");
    const fromEnv = await cli(["ledger", "export", "--out", "copy.jsonl"], {
      PROBARION_LEDGER_PATH: "custom.jsonl",
    });
    expect(fromEnv.code).toBe(0);
    expect(fromEnv.out).toContain("exported 0 entries");
    const fromFlag = await cli(
      ["ledger", "export", "--ledger", "custom.jsonl", "--out", "c2.jsonl"],
      {
        PROBARION_LEDGER_PATH: "missing.jsonl",
      },
    );
    expect(fromFlag.code).toBe(0);
  });

  it("treats an empty PROBARION_LEDGER_PATH as unset (R12)", async () => {
    await mkdir(join(dir, ".probarion"), { recursive: true });
    await writeFile(defaultLedger(), "");
    const r = await cli(["ledger", "export", "--out", "copy.jsonl"], {
      PROBARION_LEDGER_PATH: " ",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("exported 0 entries");
  });

  it.each([
    ["the same path", [".probarion/ledger.jsonl"]],
    ["another spelling of it", ["./.probarion/../.probarion/ledger.jsonl"]],
  ])("refuses to export a ledger onto itself (%s)", async (_name, [out]) => {
    await payNear(agentSdk());
    const before = await readFile(defaultLedger(), "utf8");
    const r = await cli(["ledger", "export", "--out", out as string]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--out");
    expect(await readFile(defaultLedger(), "utf8")).toBe(before);
  });

  it("refuses to export a ledger onto a hard link of itself, naming the ledger", async () => {
    await payNear(agentSdk());
    await link(defaultLedger(), join(dir, "alias.jsonl"));
    const r = await cli(["ledger", "export", "--out", "alias.jsonl"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--out must be a different file from the ledger");
  });

  it("refuses to overwrite an existing file", async () => {
    await payNear(agentSdk());
    await writeFile(join(dir, "taken.jsonl"), "keep me\n");
    const r = await cli(["ledger", "export", "--out", "taken.jsonl"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("taken.jsonl already exists");
    expect(await readFile(join(dir, "taken.jsonl"), "utf8")).toBe("keep me\n");
  });

  it("exits 1 when the ledger file does not exist", async () => {
    const r = await cli(["ledger", "export", "--out", "copy.jsonl"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("the ledger file ./.probarion/ledger.jsonl does not exist");
  });
});
