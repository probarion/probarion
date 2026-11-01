import { readFile } from "node:fs/promises";
import { createScenarioChain, startFakeRpcServer, TEST_KEYS } from "@probarion/sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER_CALLS } from "../src/commands/owner-calls.js";
import { runCli } from "../src/program.js";
import { tempDir, testIo } from "./helpers.js";

// R8/R9: every printer's gas and deposit is pinned to docs/runbooks/testnet.md section 5 (and, for
// create_vault, docs/runbooks/factory.md). A printer that under-gases an owner's exit fails here.

const VAULT = "acme.vaults.probarion.testnet";
const PK = TEST_KEYS.agent.publicKey;

interface Pin {
  method: string;
  argv: readonly string[];
  /** What near-cli-rs is told to attach: `'<deposit>'`. */
  deposit: string;
  /** Teragas, printed with one decimal: `'<tgas> Tgas'`. */
  tgas: number;
}

// The values below are written out by hand on purpose: this table is the CLI's contract. The second
// describe block checks it against the runbook, so neither can drift alone.
const PINS: readonly Pin[] = [
  {
    method: "create_vault",
    argv: ["vault", "create", "--name", "acme", "--approvers", "cfo.testnet"],
    deposit: "5 NEAR",
    tgas: 300,
  },
  { method: "add_agent", argv: ["agent", "add", "--pk", PK], deposit: "1 yoctoNEAR", tgas: 30 },
  {
    method: "remove_agent",
    argv: ["agent", "remove", "--pk", PK],
    deposit: "1 yoctoNEAR",
    tgas: 30,
  },
  {
    method: "set_ledger_key",
    argv: ["ledger", "set-key", "--pk", PK],
    deposit: "1 yoctoNEAR",
    tgas: 30,
  },
  {
    method: "revoke_mandate",
    argv: ["mandate", "revoke", "--mandate", "1"],
    deposit: "1 yoctoNEAR",
    tgas: 30,
  },
  { method: "unfreeze", argv: ["vault", "unfreeze"], deposit: "1 yoctoNEAR", tgas: 30 },
  { method: "reject", argv: ["spend", "reject", "--spend", "1"], deposit: "1 yoctoNEAR", tgas: 30 },
  { method: "freeze", argv: ["vault", "freeze"], deposit: "0 NEAR", tgas: 30 },
  {
    method: "create_mandate",
    argv: [
      "mandate",
      "create",
      "--payee",
      "near:vendor.testnet",
      "--max-per",
      "1",
      "--max-total",
      "2",
      "--uses",
      "2",
      "--expires",
      "2026-12-31",
      "--approval-above",
      "1",
      "--agent-pk",
      PK,
      "--purpose",
      "ab".repeat(32),
      "--label",
      "x",
    ],
    deposit: "0.1 NEAR",
    tgas: 100,
  },
  {
    method: "approve",
    argv: ["spend", "approve", "--spend", "1"],
    deposit: "1 yoctoNEAR",
    tgas: 150,
  },
  {
    method: "withdraw",
    argv: ["vault", "withdraw", "--amount", "1"],
    deposit: "1 yoctoNEAR",
    tgas: 100,
  },
  {
    method: "withdraw_intents",
    argv: ["vault", "withdraw-intents", "--token", "base", "--amount", "1"],
    deposit: "1 yoctoNEAR",
    tgas: 150,
  },
];

// Methods in the runbook table that the CLI does not print: the agent and the ledger key sign them.
const NOT_PRINTED = new Set(["spend", "anchor"]);

let server: Awaited<ReturnType<typeof startFakeRpcServer>>;
let dir: string;

beforeEach(async () => {
  server = await startFakeRpcServer(createScenarioChain());
  dir = await tempDir();
});

afterEach(async () => {
  await server.close();
});

async function printed(
  argv: readonly string[],
): Promise<{ gas: string; deposit: string; method: string }> {
  const { io, state } = testIo(dir, { PROBARION_VAULT_ID: VAULT });
  const code = await runCli(["--network", "testnet", "--rpc", server.url, ...argv], io);
  expect(state.err).toBe("");
  expect(code).toBe(0);
  const line = state.out.split("\n").find((l) => l.startsWith("near contract call-function"));
  expect(line).toBeDefined();
  const match =
    /^near contract call-function as-transaction \S+ (\S+) file-args \S+ prepaid-gas '([^']+)' attached-deposit '([^']+)' sign-as /.exec(
      line ?? "",
    );
  if (match === null) throw new Error(`unparseable command: ${line}`);
  return { method: match[1] as string, gas: match[2] as string, deposit: match[3] as string };
}

describe("printed gas and deposit match the pinned table", () => {
  it.each(PINS)(
    "$method attaches '$deposit' and $tgas Tgas",
    async ({ method, argv, deposit, tgas }) => {
      const out = await printed(argv);
      expect(out.method).toBe(method);
      expect(out.gas).toBe(`${tgas.toFixed(1)} Tgas`);
      expect(out.deposit).toBe(deposit);
    },
  );

  it("pins every transaction the CLI can print", () => {
    const pinned = new Set(PINS.map((p) => p.method));
    for (const spec of OWNER_CALLS) expect(pinned.has(spec.method), spec.method).toBe(true);
    for (const method of ["create_vault", "create_mandate", "add_agent", "set_ledger_key"]) {
      expect(pinned.has(method), method).toBe(true);
    }
  });
});

async function section5(): Promise<Map<string, { deposit: string; tgas: number }>> {
  const text = await readFile(
    new URL("../../../docs/runbooks/testnet.md", import.meta.url),
    "utf8",
  );
  const start = text.indexOf("## 5. Gas and deposits");
  const end = text.indexOf("\n## 6.", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const rows = new Map<string, { deposit: string; tgas: number }>();
  for (const line of text.slice(start, end).split("\n")) {
    if (!line.startsWith("|") || /^\|[-| ]+\|$/.test(line) || line.startsWith("| Call")) continue;
    const cells = line.slice(1, -1).split("|");
    const methods = [...(cells[0] ?? "").matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string);
    const deposit = /`'([^']+)'`/.exec(cells[2] ?? "")?.[1];
    const tgas = /`'(\d+(?:\.\d+)?) Tgas'`/.exec(cells[3] ?? "")?.[1];
    if (deposit === undefined || tgas === undefined)
      throw new Error(`unparseable runbook row: ${line}`);
    for (const method of methods) rows.set(method, { deposit, tgas: Number(tgas) });
  }
  return rows;
}

describe("the pinned table agrees with docs/runbooks/testnet.md section 5", () => {
  it("lists exactly the methods the CLI prints, plus the two it does not", async () => {
    const rows = await section5();
    const expected = new Set(PINS.map((p) => p.method).filter((m) => m !== "create_vault"));
    for (const method of NOT_PRINTED) expected.add(method);
    expect([...rows.keys()].sort()).toEqual([...expected].sort());
  });

  it("gives the same gas for every printed method", async () => {
    const rows = await section5();
    for (const pin of PINS) {
      if (pin.method === "create_vault") continue;
      expect(rows.get(pin.method)?.tgas, pin.method).toBe(pin.tgas);
    }
  });

  it("gives the same deposit, except create_mandate, where the CLI default is at least the runbook's", async () => {
    const rows = await section5();
    for (const pin of PINS) {
      if (pin.method === "create_vault") continue;
      const runbook = rows.get(pin.method)?.deposit;
      if (pin.method === "create_mandate") {
        expect(runbook, pin.method).toMatch(/NEAR$/);
        expect(Number.parseFloat(pin.deposit)).toBeGreaterThanOrEqual(
          Number.parseFloat(runbook ?? "NaN"),
        );
      } else {
        expect(runbook, pin.method).toBe(pin.deposit);
      }
    }
  });

  it("matches the 300 Tgas that docs/runbooks/factory.md attaches to every create_vault", async () => {
    const text = await readFile(
      new URL("../../../docs/runbooks/factory.md", import.meta.url),
      "utf8",
    );
    const gases = [
      ...text.matchAll(/ create_vault \\\n[^\n]*\n\s*prepaid-gas '([\d.]+) Tgas'/g),
    ].map((m) => m[1]);
    expect(gases.length).toBeGreaterThanOrEqual(3);
    expect(new Set(gases)).toEqual(new Set(["300.0"]));
  });
});
