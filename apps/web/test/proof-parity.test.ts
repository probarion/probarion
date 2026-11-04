// R5 parity: what /proof shows is what `probarion verify --offline snapshot.json` reports on the file the page
// lets you download. The bytes come from the snapshot route's own response; they are parsed back, checked by core,
// and verified by the CLI itself (its `--offline` input checks included), in-process and with no network.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEd25519Signer,
  type LedgerEntry,
  runChecks,
  type VerifyReport,
} from "@probarion/core";
import { InMemoryLedgerStore } from "@probarion/sdk";
import { createScenarioChain, SCENARIO_VAULT, TEST_KEYS } from "@probarion/sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli } from "@/lib/proof/cli";
import { evidenceFor } from "@/lib/proof/evidence";
import { makeProofReader } from "@/lib/proof/reader";
import { clearProofCache, loadProof, type ProofDeps, type ProofOk } from "@/lib/proof/service";
import { snapshotFileName, snapshotResponse } from "@/lib/proof/snapshot-file";
import { headline } from "@/lib/proof/view";
import { runBuiltCli, shownArgs } from "./fixtures/cli-bin";
import { appendBody } from "./fixtures/ledger";
import { noServiceDb, type ProofState, proofSnapshot, publicDbFor } from "./fixtures/proof";
import { type ChainRpc, startChainRpc } from "./fixtures/rpc";

// A computed path, so the web typecheck does not pull the CLI's sources into its own program.
const CLI_PROGRAM = fileURLToPath(new URL("../../../packages/cli/src/program.ts", import.meta.url));

interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  now(): Date;
  setExitCode(code: number): void;
}

/** `probarion verify --offline <file> --json` on these exact bytes: its exit code and its report. */
async function cliOffline(
  bytes: string,
): Promise<{ code: number; report: VerifyReport; err: string }> {
  const { runCli } = (await import(/* @vite-ignore */ CLI_PROGRAM)) as {
    runCli(argv: readonly string[], io: CliIo): Promise<number>;
  };
  const dir = mkdtempSync(join(tmpdir(), "probarion-proof-parity-"));
  try {
    const file = join(dir, "snapshot.json");
    writeFileSync(file, bytes);
    let out = "";
    let err = "";
    const code = await runCli(["verify", "--offline", file, "--json"], {
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
      env: {},
      cwd: dir,
      now: () => new Date("2026-11-09T00:00:00.000Z"),
      setExitCode: () => {},
    });
    return { code, report: JSON.parse(out) as VerifyReport, err };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const verdicts = (r: VerifyReport) => r.checks.map((c) => ({ id: c.id, status: c.status }));

/** The page's report against the downloaded file, three ways: core on the parsed bytes, and the CLI itself. */
async function expectParity(r: ProofOk): Promise<string> {
  const res = snapshotResponse(r);
  const bytes = await res.text();
  // Serialised the way the CLI writes --snapshot.
  expect(bytes).toBe(`${JSON.stringify(r.snapshot, null, 2)}\n`);
  const again = await runChecks(JSON.parse(bytes));
  expect(verdicts(again)).toEqual(verdicts(r.report));
  expect(again.ok).toBe(r.report.ok);
  expect(again.unproven).toEqual(r.report.unproven);

  const cli = await cliOffline(bytes);
  expect(cli.err).not.toMatch(/^error:/m);
  expect(verdicts(cli.report)).toEqual(verdicts(r.report));
  expect(cli.report.ok).toBe(r.report.ok);
  expect(cli.report.unproven).toEqual(r.report.unproven);
  // verify's exit codes: 0 every check passes, 1 a check fails, 2 nothing fails but something is unproven.
  expect(cli.code).toBe({ ok: 0, failed: 1, unproven: 2 }[headline(r.report)]);
  return headline(r.report);
}

const noService = noServiceDb;

describe("snapshot.json parity with probarion verify --offline", () => {
  beforeEach(() => clearProofCache());

  describe("a snapshot the read-only Probarion gathers from a (fake) testnet node", () => {
    let node: ChainRpc;
    let ledger: LedgerEntry[];
    beforeEach(async () => {
      const chain = createScenarioChain();
      const store = new InMemoryLedgerStore();
      const entry = await store.append(
        appendBody(SCENARIO_VAULT),
        createEd25519Signer(TEST_KEYS.ledger.secretKey),
      );
      ledger = [entry];
      node = await startChainRpc(chain);
    });
    afterEach(async () => {
      await node.close();
    });

    const deps = (): ProofDeps => ({
      network: "testnet",
      publicDb: publicDbFor(SCENARIO_VAULT, "testnet", ledger),
      serviceDb: noService,
      sessionAccount: null,
      makeReader: (vault, store) =>
        makeProofReader({
          network: "testnet",
          vault,
          store,
          rpc: node.rpc,
          archivalRpcUrls: [],
          evidence: evidenceFor({}, "testnet", vault),
        }),
    });

    it("agrees check by check when every check passes", async () => {
      node.chain.anchors.push({
        seq: 1,
        root: ledger[0]?.link ?? "",
        count: 1,
        at_ns: "1793760000000000000",
        ledger_key: TEST_KEYS.ledger.publicKey,
      });
      const r = await loadProof(deps(), SCENARIO_VAULT);
      expect(r.status).toBe("ok");
      if (r.status !== "ok") return;
      expect(r.snapshot.network).toBe("testnet");
      expect(r.snapshot.ledger).toEqual(ledger);
      expect(await expectParity(r)).toBe("ok");
    });

    it("agrees check by check when a check fails (no anchor on chain)", async () => {
      const r = await loadProof(deps(), SCENARIO_VAULT);
      expect(r.status).toBe("ok");
      if (r.status !== "ok") return;
      expect(r.report.checks.find((c) => c.id === "c")?.status).toBe("fail");
      expect(await expectParity(r)).toBe("failed");
    });
  });

  it("agrees in every headline state, on both networks", async () => {
    for (const network of ["mainnet", "testnet"] as const) {
      for (const state of ["ok", "unproven", "failed"] as ProofState[]) {
        clearProofCache();
        const snapshot = await proofSnapshot(state, { network });
        const d: ProofDeps = {
          network,
          publicDb: publicDbFor(snapshot.vault, network, snapshot.ledger),
          serviceDb: noService,
          sessionAccount: null,
          makeReader: () => ({ snapshot: async () => structuredClone(snapshot) }),
        };
        const r = await loadProof(d, snapshot.vault);
        expect(r.status).toBe("ok");
        if (r.status !== "ok") continue;
        expect(await expectParity(r), `${network} ${state}`).toBe(state);
      }
    }
  });

  it("serves a file the CLI's --offline input checks accept: v 1, an account id, a network, an ISO taken_at", async () => {
    const snapshot = await proofSnapshot("ok");
    const r: ProofOk = {
      status: "ok",
      vault: snapshot.vault,
      network: "mainnet",
      kind: "team",
      audience: "public",
      snapshot,
      report: await runChecks(snapshot),
    };
    const parsed = JSON.parse(await snapshotResponse(r).text()) as Record<string, unknown>;
    expect(parsed.v).toBe(1);
    expect(parsed.vault).toBe(snapshot.vault);
    expect(parsed.network).toBe("mainnet");
    expect(parsed.taken_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Array.isArray(parsed.pre_ledger_decision_hashes)).toBe(true);
  });
});

// Child processes of the built CLI: give them room on a slow machine.
vi.setConfig({ testTimeout: 60_000 });

/**
 * The page's own command, `cli("verify --offline <file>")` in either form, run through the built CLI as a child
 * process, in a folder that holds the downloaded file under its served name. Offline: no RPC, no network.
 */
async function runPageCommand(vault: string, bytes: string): Promise<number> {
  const args = shownArgs(cli(`verify --offline ${snapshotFileName(vault)}`));
  expect(args).toEqual(["verify", "--offline", snapshotFileName(vault)]);
  const dir = mkdtempSync(join(tmpdir(), "probarion-proof-bin-"));
  try {
    writeFileSync(join(dir, snapshotFileName(vault)), bytes);
    return (await runBuiltCli(args, { cwd: dir })).code;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the command the page shows, run through the built CLI", () => {
  beforeEach(() => clearProofCache());

  it("exits 0 on an ok snapshot, 2 on an unproven one and 1 on a failed one, as the headline says", async () => {
    for (const state of ["ok", "unproven", "failed"] as ProofState[]) {
      clearProofCache();
      const snapshot = await proofSnapshot(state, { network: "testnet" });
      const r = await loadProof(
        {
          network: "testnet",
          publicDb: publicDbFor(snapshot.vault, "testnet", snapshot.ledger),
          serviceDb: noServiceDb,
          sessionAccount: null,
          makeReader: () => ({ snapshot: async () => structuredClone(snapshot) }),
        },
        snapshot.vault,
      );
      if (r.status !== "ok") throw new Error(r.status);
      const bytes = await snapshotResponse(r).text();
      expect(await runPageCommand(r.vault, bytes), state).toBe(
        { ok: 0, unproven: 2, failed: 1 }[state],
      );
    }
  });
});
