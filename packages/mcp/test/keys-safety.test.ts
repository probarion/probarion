// No secret key in anything init, status or the server's start prints: each output is searched for the secrets
// themselves and for anything shaped like a secret key. The commands also run once as the real binary.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createScenarioChain,
  type FakeRpcServer,
  SCENARIO_VAULT,
  startFakeRpcServer,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/cli.js";
import { runInit } from "../src/init.js";
import { parseKeysFile } from "../src/keys-file.js";
import { main } from "../src/main.js";
import { runStatus } from "../src/status.js";
import { AGENT, capture, expectNoSecret, keysFileText, LEDGER, tempDir } from "./keys-helpers.js";

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const NO_NETWORK = new URL("./setup/no-network.ts", import.meta.url).href;

let rpc: FakeRpcServer;
beforeEach(async () => {
  const chain = createScenarioChain();
  chain.ftBalances[chain.config.usdc] = { [SCENARIO_VAULT]: "5000000" };
  rpc = await startFakeRpcServer(chain);
});
afterEach(async () => {
  await rpc.close();
});

const SCENARIO_SECRETS = [TEST_KEYS.agent.secretKey, TEST_KEYS.ledger.secretKey];

/** A home whose default keys file for the scenario vault holds the scenario's keys. */
function scenarioHome(): string {
  const home = tempDir("probarion-safety-home-");
  mkdirSync(join(home, ".probarion", SCENARIO_VAULT), { recursive: true });
  writeFileSync(
    join(home, ".probarion", SCENARIO_VAULT, "keys.json"),
    keysFileText(SCENARIO_VAULT, "testnet", {}, TEST_KEYS.agent, TEST_KEYS.ledger),
    { mode: 0o600 },
  );
  return home;
}

/**
 * Runs the binary from its source, with the same no-network guard as these tests. Not spawnSync: the fake RPC
 * server answers from this process, which must keep running while the child asks it.
 */
function bin(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX, "--import", NO_NETWORK, BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("no secret key in what init, status or the server prints", () => {
  it("init: created, found again, and refused", async () => {
    const home = tempDir("probarion-safety-home-");
    const outputs: string[] = [];
    for (let i = 0; i < 2; i++) {
      const out = capture();
      const err = capture();
      await runInit(["--vault", SCENARIO_VAULT], {
        env: {},
        home,
        cwd: home,
        out: out.stream,
        err: err.stream,
        platform: "win32",
      });
      outputs.push(out.text(), err.text());
    }
    const path = join(home, ".probarion", SCENARIO_VAULT, "keys.json");
    const parsed = parseKeysFile(readFileSync(path, "utf8"), path, {
      vault: SCENARIO_VAULT,
      network: "testnet",
    });
    if (!parsed.ok) throw new Error("the keys file did not parse");
    // A file for another vault at the path given: refused, and its secrets are not echoed either.
    const other = join(home, "other.json");
    writeFileSync(other, keysFileText("other.vaults.probarion.testnet", "testnet"));
    const out = capture();
    const err = capture();
    await runInit(["--vault", SCENARIO_VAULT, "--keys-file", other], {
      env: {},
      home,
      cwd: home,
      out: out.stream,
      err: err.stream,
    });
    outputs.push(out.text(), err.text());
    for (const text of outputs) {
      expectNoSecret(text, [
        parsed.keys.agentKey,
        parsed.keys.ledgerKey,
        AGENT.secretKey,
        LEDGER.secretKey,
      ]);
    }
  });

  it("status: ready, not ready, and an error that quotes a secret-shaped string", async () => {
    const outputs: string[] = [];
    const run = async (opts: Partial<Parameters<typeof runStatus>[1]> = {}) => {
      const out = capture();
      const err = capture();
      await runStatus([], {
        env: { PROBARION_VAULT_ID: SCENARIO_VAULT, NEAR_RPC_URLS: rpc.url },
        home: scenarioHome(),
        out: out.stream,
        err: err.stream,
        now: () => new Date("2026-11-11T00:00:00Z"),
        ...opts,
      });
      outputs.push(out.text(), err.text());
    };
    await run();
    await run({
      env: {
        PROBARION_VAULT_ID: SCENARIO_VAULT,
        NEAR_RPC_URLS: rpc.url,
        PROBARION_AGENT_KEY: TEST_KEYS.agent.secretKey,
        PROBARION_LEDGER_KEY: TEST_KEYS.ledger.secretKey,
      },
      home: tempDir("probarion-safety-empty-"),
    });
    await run({
      chain: () => ({
        listAgents: async () => {
          throw new Error(`node said: bad key ${TEST_KEYS.agent.secretKey}`);
        },
        getConfig: async () => ({ ...rpc.chain.config, ledger_key: null }),
        accessKey: async () => null,
        listMandates: async () => [],
        tokenBalance: async () => "0",
        latestAnchor: async () => null,
      }),
    });
    // A config error with secrets in the environment and in a bad keys file.
    await run({
      env: { PROBARION_VAULT_ID: SCENARIO_VAULT, PROBARION_AGENT_KEY: TEST_KEYS.agent.secretKey },
    });
    for (const text of outputs) expectNoSecret(text, SCENARIO_SECRETS);
    expect(outputs.join("\n")).toContain("ed25519:[redacted]");
  });

  it("a secret key passed as an argument, alone or as NAME=secret, is not echoed by any command", async () => {
    const home = scenarioHome();
    const outputs: string[] = [];
    for (const secret of SCENARIO_SECRETS) {
      for (const word of [
        secret,
        secret.slice("ed25519:".length),
        `PROBARION_AGENT_KEY=${secret}`,
        `--pk=${secret}`,
      ]) {
        for (const args of [
          ["init", "--vault", SCENARIO_VAULT, word],
          ["init", word],
          ["status", word],
          ["demo", word],
          [word],
        ]) {
          const out = capture();
          const err = capture();
          const code = await runCommand(args, {
            env: { PROBARION_VAULT_ID: SCENARIO_VAULT, NEAR_RPC_URLS: rpc.url },
            home,
            cwd: home,
            out: out.stream,
            err: err.stream,
          });
          expect(code, args[0]).toBe(2);
          expect(err.text(), args[0]).toContain("unknown argument");
          outputs.push(out.text(), err.text());
        }
      }
    }
    for (const text of outputs) expectNoSecret(text, SCENARIO_SECRETS);
  });

  it("the server's start line names the keys source, never a key", async () => {
    const lines: string[] = [];
    for (const [env, home, want] of [
      [{}, scenarioHome(), "keys from the keys file"],
      [
        {
          PROBARION_AGENT_KEY: TEST_KEYS.agent.secretKey,
          PROBARION_LEDGER_KEY: TEST_KEYS.ledger.secretKey,
        },
        tempDir("probarion-safety-empty-"),
        "keys from PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY",
      ],
      [{}, tempDir("probarion-safety-empty-"), "(read-only: no keys set)"],
    ] as const) {
      const stdout = new PassThrough();
      const stderr = capture();
      let out = "";
      stdout.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      const server = await main({
        env: { PROBARION_VAULT_ID: SCENARIO_VAULT, NEAR_RPC_URLS: rpc.url, ...env },
        home,
        stdin: new PassThrough(),
        stdout,
        stderr: stderr.stream,
      });
      expect(server).not.toBe(2);
      expect(stderr.text()).toContain(want);
      lines.push(stderr.text(), out);
      if (server !== 2) await server.close();
    }
    for (const text of lines) expectNoSecret(text, SCENARIO_SECRETS);
  });

  it("as the real binary: init, then status and a refused config, print no secret", async () => {
    const home = tempDir("probarion-safety-bin-");
    const env = { HOME: home, USERPROFILE: home, NEAR_RPC_URLS: rpc.url };
    const init = await bin(["init", "--vault", SCENARIO_VAULT], env);
    expect(init.code, init.err).toBe(0);
    const path = join(home, ".probarion", SCENARIO_VAULT, "keys.json");
    const parsed = parseKeysFile(readFileSync(path, "utf8"), path, {
      vault: SCENARIO_VAULT,
      network: "testnet",
    });
    if (!parsed.ok) throw new Error("the keys file did not parse");
    expect(init.out).toContain(parsed.keys.agentPublicKey);
    // The new keys are not the vault's yet: status is not ready, and exits 1.
    const status = await bin(["status"], { ...env, PROBARION_VAULT_ID: SCENARIO_VAULT });
    expect(status.code, status.err).toBe(1);
    expect(status.out).toMatch(/not yet +agent key/);
    const refused = await bin(["status"], {
      ...env,
      PROBARION_VAULT_ID: SCENARIO_VAULT,
      PROBARION_AGENT_KEY: TEST_KEYS.agent.secretKey,
    });
    expect(refused.code).toBe(2);
    for (const text of [init.out, init.err, status.out, status.err, refused.out, refused.err]) {
      expectNoSecret(text, [parsed.keys.agentKey, parsed.keys.ledgerKey, ...SCENARIO_SECRETS]);
    }
  });

  it("only keys-file.ts, config.ts and the SDK port touch a secret key field", () => {
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    const allowed = new Set(["keys-file.ts", "config.ts", "probarion-port.ts"]);
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      if (allowed.has(f)) continue;
      const text = readFileSync(join(dir, f), "utf8");
      expect(/\b(secretKey|secret_key|agentKey|ledgerKey)\b/.test(text), f).toBe(false);
    }
  });
});
