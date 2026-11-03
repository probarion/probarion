import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createScenarioChain,
  type FakeRpcServer,
  SCENARIO_CODE_HASH,
  startFakeRpcServer,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { shellSplit, tempDir, testIo } from "./helpers.js";
import { PRINTERS, VAULT } from "./printers.js";

// Feeds every printed command to the real near-cli-rs, in a form that cannot send anything: the
// trailing `sign-with-keychain send` is swapped for `sign-later ... display`, which builds the
// unsigned transaction offline (given a signer key, a nonce and a block hash) and prints it. That
// proves the whole command parses, value strings like '30.0 Tgas' and '0.05 NEAR' included, and that
// the transaction near-cli-rs builds carries the receiver, method, gas and deposit we meant.
// Skipped when `near` is not on PATH (CI's TypeScript job does not install it).

const run = promisify(execFile);
const nearInstalled = await run("near", ["--version"], { timeout: 30_000 }).then(
  () => true,
  () => false,
);

const KEYCHAIN_SEND = " sign-with-keychain send";
const OFFLINE = ` sign-later --signer-public-key ${TEST_KEYS.approver.publicKey} --nonce 1 --block-hash ${SCENARIO_CODE_HASH} display`;
const SIGNERS = { owner: "owner.testnet", approver: "cfo.testnet" } as const;

let server: FakeRpcServer;
let dir: string;

beforeEach(async () => {
  server = await startFakeRpcServer(createScenarioChain());
  dir = await tempDir();
});

afterEach(async () => {
  await server.close();
});

async function printedCommand(argv: readonly string[], signAs: string): Promise<string> {
  const { io, state } = testIo(dir, { PROBARION_VAULT_ID: VAULT });
  const code = await runCli(
    ["--network", "testnet", "--rpc", server.url, ...argv, "--sign-as", signAs],
    io,
  );
  expect(state.err).toBe("");
  expect(code).toBe(0);
  const line = state.out.split("\n").find((l) => l.startsWith("near contract call-function"));
  if (line === undefined) throw new Error(`no command printed:\n${state.out}`);
  return line;
}

/** near-cli-rs prints the decoded transaction on stderr and the hash and base64 on stdout. */
async function near(line: string): Promise<{ stdout: string; stderr: string; all: string }> {
  const words = shellSplit(line);
  expect(words[0]).toBe("near");
  const { stdout, stderr } = await run("near", words.slice(1), { cwd: dir, timeout: 60_000 });
  return {
    stdout,
    stderr,
    all: `${stderr}
${stdout}`,
  };
}

describe.skipIf(!nearInstalled)("near-cli-rs parses the printed commands (offline)", () => {
  it.each(PRINTERS)(
    "$method: the command parses and builds the intended unsigned transaction",
    async ({ method, contract, argv, signer, deposit, tgas }) => {
      const signAs = SIGNERS[signer];
      const line = await printedCommand(argv, signAs);
      expect(line.endsWith(KEYCHAIN_SEND)).toBe(true);
      const { all: stdout } = await near(line.slice(0, -KEYCHAIN_SEND.length) + OFFLINE);
      expect(stdout).toMatch(new RegExp(`signer_id:\\s+${signAs.replaceAll(".", "\\.")}\\b`));
      expect(stdout).toMatch(new RegExp(`receiver_id:\\s+${contract.replaceAll(".", "\\.")}\\b`));
      expect(stdout).toMatch(new RegExp(`method name:\\s+${method}\\b`));
      expect(stdout).toMatch(new RegExp(`gas:\\s+${tgas.toFixed(1).replace(".", "\\.")} Tgas`));
      expect(stdout).toMatch(new RegExp(`deposit:\\s+${deposit.replace(".", "\\.")}\\b`));
      expect(stdout).toContain("Unsigned transaction (serialized as base64):");
    },
  );

  it("the Ledger hint names a command near-cli-rs accepts", async () => {
    const line = await printedCommand(["vault", "freeze"], SIGNERS.owner);
    const hint = "`sign-with-ledger usb send`";
    const { io, state } = testIo(dir, { PROBARION_VAULT_ID: VAULT });
    await runCli(["vault", "freeze"], io);
    expect(state.out).toContain(hint);
    // `--help` on the last subcommand proves the chain `sign-with-ledger usb send` resolves,
    // without asking a device for anything.
    const { stdout } = await near(
      `${line.slice(0, -KEYCHAIN_SEND.length)} sign-with-ledger usb send --help`,
    );
    expect(stdout).toContain("sign-with-ledger usb send");
  });

  it("the old hint was wrong: `sign-with-ledger send` is not accepted", async () => {
    const line = await printedCommand(["vault", "freeze"], SIGNERS.owner);
    await expect(
      near(`${line.slice(0, -KEYCHAIN_SEND.length)} sign-with-ledger send`),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("unrecognized subcommand 'send'") });
  });
});
