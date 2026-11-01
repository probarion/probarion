import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@probarion/core";
import {
  createScenarioChain,
  type FakeRpcServer,
  startFakeRpcServer,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { tempDir, testIo } from "./helpers.js";

let server: FakeRpcServer;
let dir: string;

beforeEach(async () => {
  server = await startFakeRpcServer(createScenarioChain());
  dir = await tempDir();
});

afterEach(async () => {
  await server.close();
});

async function args(file: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, file), "utf8"));
}

const VAULT = "acme.vaults.probarion.testnet";

describe("owner-only commands print transactions and never sign", () => {
  it("vault create reads min_deposit from the factory and prints create_vault", async () => {
    const { io, state } = testIo(dir);
    const code = await runCli(
      [
        "--network",
        "testnet",
        "--rpc",
        server.url,
        "vault",
        "create",
        "--name",
        "acme",
        "--approvers",
        "cfo.testnet,ops.testnet",
        "--sign-as",
        "owner.testnet",
        "--out-dir",
        "tx",
      ],
      io,
    );
    expect(state.err).toBe("");
    expect(code).toBe(0);
    expect(state.out).toContain("OWNER SIGNS");
    expect(state.out).toContain(
      "near contract call-function as-transaction vaults.probarion.testnet create_vault file-args ./tx/create_vault.args.json prepaid-gas '300.0 Tgas' attached-deposit '5 NEAR' sign-as owner.testnet network-config testnet sign-with-keychain send",
    );
    expect(await args("tx/create_vault.args.json")).toEqual({
      name: "acme",
      approvers: ["cfo.testnet", "ops.testnet"],
      daily_backstop: "500000000",
      held_ttl_ns: "259200000000000",
    });
    expect(server.chain.txs.size).toBe(0);
  });

  it("vault create rejects a bad name", async () => {
    const { io, state } = testIo(dir);
    expect(
      await runCli(
        [
          "--rpc",
          server.url,
          "vault",
          "create",
          "--name",
          "A!",
          "--approvers",
          "cfo.testnet",
          "--deposit",
          "5",
        ],
        io,
      ),
    ).toBe(1);
    expect(state.err).toContain("--name");
  });

  it("mandate create builds MandateInput with converted amounts and a hashed purpose file", async () => {
    await writeFile(join(dir, "po.pdf"), "PO-2002 contractor agreement");
    const { io, state } = testIo(dir);
    const code = await runCli(
      [
        "--network",
        "testnet",
        "mandate",
        "create",
        "--vault",
        VAULT,
        "--payee",
        "base:0x1111111111111111111111111111111111111111",
        "--max-per",
        "100",
        "--max-total",
        "1000",
        "--uses",
        "10",
        "--expires",
        "2026-12-31",
        "--approval-above",
        "100",
        "--agent-pk",
        TEST_KEYS.agent.publicKey,
        "--purpose",
        "po.pdf",
        "--label",
        "Base contractor",
      ],
      io,
    );
    expect(state.err).toBe("");
    expect(code).toBe(0);
    expect(state.out).toContain(`${VAULT} create_mandate file-args ./create_mandate.args.json`);
    expect(state.out).toContain("attached-deposit '0.1 NEAR'");
    expect(await args("create_mandate.args.json")).toEqual({
      input: {
        payee: {
          type: "intents",
          chain: "base",
          address: "0x1111111111111111111111111111111111111111",
          asset: "base-usdc.probarion.testnet",
        },
        purpose_hash: sha256Hex("PO-2002 contractor agreement"),
        max_per_payment: "100000000",
        max_total: "1000000000",
        max_uses: 10,
        expires_at_ns: "1798761599999000000",
        approval_above: "100000000",
        agent_pk: TEST_KEYS.agent.publicKey,
        label: "Base contractor",
      },
    });
  });

  const MANDATE_BASE: Record<string, string> = {
    "--vault": VAULT,
    "--payee": "near:vendor.testnet",
    "--max-per": "100",
    "--max-total": "1000",
    "--uses": "10",
    "--expires": "2026-12-31",
    "--approval-above": "100",
    "--agent-pk": TEST_KEYS.agent.publicKey,
    "--purpose": "ab".repeat(32),
    "--label": "x",
  };

  it.each([
    ["a past expiry", ["--expires", "2026-01-01"]],
    ["a calendar-invalid expiry", ["--expires", "2026-02-31"]],
    ["a bad agent key", ["--agent-pk", "ed25519:nope"]],
    ["a per-payment cap above the total", ["--max-per", "2000"]],
    ["a zero per-payment cap", ["--max-per", "0"]],
    ["a zero use count", ["--uses", "0"]],
    ["a missing purpose", ["--purpose", "missing.pdf"]],
    ["a label over 64 bytes", ["--label", "é".repeat(33)]],
    ["the vault itself as the NEAR payee", ["--payee", `near:${VAULT}`]],
    ["a deposit that is not a plain decimal", ["--deposit", "1e3"]],
    ["a shell metacharacter in --sign-as", ["--sign-as", "x; echo pwned"]],
  ])("mandate create rejects %s", async (_name, override) => {
    const base = { ...MANDATE_BASE };
    base[override[0] ?? ""] = override[1] ?? "";
    const { io, state } = testIo(dir);
    expect(await runCli(["mandate", "create", ...Object.entries(base).flat()], io)).toBe(1);
    expect(state.out).toBe("");
  });

  it("mandate create keeps a 64-byte label and says when no spend can ever be held", async () => {
    const { io, state } = testIo(dir);
    const argv = Object.entries({ ...MANDATE_BASE, "--label": "é".repeat(32) }).flat();
    expect(await runCli(["mandate", "create", ...argv], io)).toBe(0);
    expect(state.out).toContain("no spend is ever held for an approver");
    const lower = testIo(dir);
    const withHold = Object.entries({ ...MANDATE_BASE, "--approval-above": "99.5" }).flat();
    expect(await runCli(["mandate", "create", ...withHold], lower.io)).toBe(0);
    expect(lower.state.out).not.toContain("no spend is ever held");
  });

  it("agent add and ledger set-key print add_agent and set_ledger_key", async () => {
    const { io, state } = testIo(dir);
    expect(
      await runCli(
        ["agent", "add", "--vault", VAULT, "--pk", TEST_KEYS.agent.publicKey, "--allowance", "1"],
        io,
      ),
    ).toBe(0);
    expect(state.out).toContain(
      "add_agent file-args ./add_agent.args.json prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR'",
    );
    expect(await args("add_agent.args.json")).toEqual({
      public_key: TEST_KEYS.agent.publicKey,
      allowance: `1${"0".repeat(24)}`,
      label: "agent",
    });
    expect(
      await runCli(["ledger", "set-key", "--vault", VAULT, "--pk", TEST_KEYS.ledger.publicKey], io),
    ).toBe(0);
    expect(await args("set_ledger_key.args.json")).toEqual({
      public_key: TEST_KEYS.ledger.publicKey,
      allowance: "250000000000000000000000",
    });
    expect(state.out).toContain(
      "set_ledger_key file-args ./set_ledger_key.args.json prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR'",
    );
    expect(server.chain.txs.size).toBe(0);
  });

  it.each([
    [["agent", "add", "--pk", TEST_KEYS.agent.publicKey, "--allowance", "0"], "--allowance"],
    [["agent", "add", "--pk", TEST_KEYS.agent.publicKey, "--label", "é".repeat(33)], "--label"],
    [["ledger", "set-key", "--pk", TEST_KEYS.ledger.publicKey, "--allowance", "0"], "--allowance"],
    [["agent", "add", "--pk", "ed25519:nope"], "--pk"],
    [["vault", "withdraw", "--amount", "0"], "--amount"],
    [["vault", "withdraw-intents", "--token", "base", "--amount", "0"], "--amount"],
    [["vault", "withdraw-intents", "--token", "Base USDC", "--amount", "1"], "--token"],
    [["mandate", "revoke", "--mandate", "0"], "--mandate"],
    [["spend", "approve", "--spend", "0"], "--spend"],
    [["spend", "reject", "--spend", "1.5"], "--spend"],
  ] as const)("%j is refused before anything is printed (names %s)", async (argv, flag) => {
    const { io, state } = testIo(dir, { PROBARION_VAULT_ID: VAULT });
    expect(await runCli(argv, io)).toBe(1);
    expect(state.err).toContain(flag);
    expect(state.out).toBe("");
  });

  it.each([
    [
      ["agent", "remove", "--pk", TEST_KEYS.agent.publicKey],
      "remove_agent",
      { public_key: TEST_KEYS.agent.publicKey },
      "1 yoctoNEAR",
    ],
    [["mandate", "revoke", "--mandate", "2"], "revoke_mandate", { mandate_id: 2 }, "1 yoctoNEAR"],
    [["spend", "approve", "--spend", "3"], "approve", { spend_id: 3 }, "1 yoctoNEAR"],
    [["spend", "reject", "--spend", "3"], "reject", { spend_id: 3 }, "1 yoctoNEAR"],
    [["vault", "unfreeze"], "unfreeze", {}, "1 yoctoNEAR"],
    [["vault", "freeze"], "freeze", {}, "0 NEAR"],
    [["vault", "withdraw", "--amount", "12.5"], "withdraw", { amount: "12500000" }, "1 yoctoNEAR"],
    [
      ["vault", "withdraw-intents", "--token", "base", "--amount", "3"],
      "withdraw_intents",
      { token: "base-usdc.probarion.testnet", amount: "3000000" },
      "1 yoctoNEAR",
    ],
    [
      ["vault", "withdraw-intents", "--token", "solana", "--amount", "0.5"],
      "withdraw_intents",
      { token: "sol-usdc.probarion.testnet", amount: "500000" },
      "1 yoctoNEAR",
    ],
    [
      ["vault", "withdraw-intents", "--token", "base-other.testnet", "--amount", "1"],
      "withdraw_intents",
      { token: "base-other.testnet", amount: "1000000" },
      "1 yoctoNEAR",
    ],
  ] as const)(
    "%j prints %s with deposit %s (one-yocto rule)",
    async (argv, method, expected, deposit) => {
      const { io, state } = testIo(dir, { PROBARION_VAULT_ID: VAULT });
      expect(await runCli(["--network", "testnet", "--rpc", server.url, ...argv], io)).toBe(0);
      expect(state.out).toContain(`${VAULT} ${method} file-args ./${method}.args.json`);
      expect(state.out).toContain(`attached-deposit '${deposit}'`);
      expect(await args(`${method}.args.json`)).toEqual(expected);
      // A printer never touches the network: the RPC server saw nothing, so nothing was sent.
      expect(server.methods).toEqual([]);
      expect(server.chain.txs.size).toBe(0);
    },
  );

  it("names the approver as the signer of approve and reject, the owner for the rest", async () => {
    const { io, state } = testIo(dir, { PROBARION_VAULT_ID: VAULT });
    expect(await runCli(["spend", "approve", "--spend", "1"], io)).toBe(0);
    expect(state.out).toContain("APPROVER SIGNS");
    expect(state.out).toContain("sign-as <approver-account-id>");
    const reject = testIo(dir, { PROBARION_VAULT_ID: VAULT });
    expect(
      await runCli(["spend", "reject", "--spend", "1", "--sign-as", "cfo.testnet"], reject.io),
    ).toBe(0);
    expect(reject.state.out).toContain("APPROVER SIGNS");
    expect(reject.state.out).toContain("sign-as cfo.testnet network-config");
    const revoke = testIo(dir, { PROBARION_VAULT_ID: VAULT });
    expect(await runCli(["mandate", "revoke", "--mandate", "1"], revoke.io)).toBe(0);
    expect(revoke.state.out).toContain("OWNER SIGNS");
    expect(revoke.state.out).toContain("sign-as <owner-account-id>");
  });

  it("reads the vault from PROBARION_VAULT_ID and fails clearly without it", async () => {
    const withEnv = testIo(dir, { PROBARION_VAULT_ID: VAULT });
    expect(await runCli(["agent", "add", "--pk", TEST_KEYS.agent.publicKey], withEnv.io)).toBe(0);
    const without = testIo(dir);
    expect(await runCli(["agent", "add", "--pk", TEST_KEYS.agent.publicKey], without.io)).toBe(1);
    expect(without.state.err).toContain("PROBARION_VAULT_ID");
  });

  it("lists every command group in --help", async () => {
    const { io, state } = testIo(dir);
    expect(await runCli(["--help"], io)).toBe(0);
    for (const group of ["vault", "mandate", "agent", "ledger", "spend"]) {
      expect(state.out).toMatch(new RegExp(`^\\s+${group}\\b`, "m"));
    }
  });

  it("reports the version", async () => {
    const { io, state } = testIo(dir);
    expect(await runCli(["--version"], io)).toBe(0);
    expect(state.out.trim()).toBe("0.1.0");
  });
});
