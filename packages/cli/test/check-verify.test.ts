// `probarion check`, `probarion verify` and `probarion ledger export` (plan 03 Task 16). TEST DOUBLES only: the
// fake chain over JSON-RPC on loopback and the fake NEAR AI. Nothing here talks to a real network (R20).
//
// verify exits 0 when every check passes, 1 when any check fails (a fail always wins), 2 when nothing fails but a
// check is unproven, and 64 on a usage error. check exits 0 when the vault would accept, 1 when it would refuse,
// and 64 on a usage error.
import { link, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractReportDataFromQuote,
  isNearTxHash,
  KNOWN_VAULT_CODE_HASHES,
  type MandateView,
  NETWORKS,
  type Snapshot,
  type SpendView,
  sha256Hex,
  ZERO_HEX32,
} from "@probarion/core";
import {
  FileLedgerStore,
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
      "unproven: spend 2 (tx_unavailable): re-run, or add --archival-rpc (when the snapshot is taken: probarion verify --vault x.vaults.probarion.testnet --snapshot <file>)",
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

  it("writes the snapshot it verified with --snapshot", async () => {
    const r = await cli(["verify", "--offline", FIXTURE, "--snapshot", "copy.json"]);
    expect(r.code).toBe(0);
    const copy = JSON.parse(await readFile(join(dir, "copy.json"), "utf8")) as Snapshot;
    expect(copy).toEqual(await fixtureSnapshot());
    const empty = await cli(["verify", "--offline", FIXTURE, "--snapshot", " "]);
    expect(empty.code).toBe(64);
    expect(empty.err).toContain("--snapshot needs a file");
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
    expect(online.out).toContain(
      "O1: DCAP-genuine TDX quote bound to this request; measurement not pinned (O1b deferred)",
    );
    expect(online.out).not.toMatch(/verified TEE|TEE verified|attested model verified/i);

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
