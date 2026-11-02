import { readdir, readFile, writeFile } from "node:fs/promises";
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
import { argsFileFor, argsJsonText, printedArgsPath, tempDir, testIo } from "./helpers.js";
import { VAULT } from "./printers.js";

let server: FakeRpcServer;
let dir: string;

beforeEach(async () => {
  server = await startFakeRpcServer(createScenarioChain());
  dir = await tempDir();
});

afterEach(async () => {
  await server.close();
});

/**
 * The printed command names `<method>.<content hash>.args.json`; the file is there under that
 * name and holds exactly the expected arguments. `subdir` is the --out-dir the command ran with.
 */
async function expectArgsFile(
  out: string,
  method: string,
  expected: unknown,
  subdir = "",
): Promise<void> {
  const name = argsFileFor(method, expected);
  const shown = subdir === "" ? `./${name}` : `./${subdir}/${name}`;
  expect(out).toContain(` ${method} file-args ${shown} prepaid-gas `);
  expect(out).toContain(`${method} arguments (${shown}):`);
  expect(await readFile(join(dir, subdir, name), "utf8")).toBe(argsJsonText(expected));
}

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
    const expected = {
      name: "acme",
      approvers: ["cfo.testnet", "ops.testnet"],
      daily_backstop: "500000000",
      held_ttl_ns: "259200000000000",
    };
    expect(state.out).toContain("OWNER SIGNS");
    expect(state.out).toContain(
      `near contract call-function as-transaction vaults.probarion.testnet create_vault file-args ./tx/${argsFileFor("create_vault", expected)} prepaid-gas '300.0 Tgas' attached-deposit '5 NEAR' sign-as owner.testnet network-config testnet sign-with-keychain send`,
    );
    await expectArgsFile(state.out, "create_vault", expected, "tx");
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
    expect(state.out).toContain(`${VAULT} create_mandate file-args ./create_mandate.`);
    expect(state.out).toContain("attached-deposit '0.05 NEAR'");
    await expectArgsFile(state.out, "create_mandate", {
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
    ["a use count above u32", ["--uses", "4294967296"]],
    ["a missing purpose", ["--purpose", "missing.pdf"]],
    ["a label over 64 bytes", ["--label", "é".repeat(33)]],
    ["the vault itself as the NEAR payee", ["--payee", `near:${VAULT}`]],
    ["a deposit that is not a plain decimal", ["--deposit", "1e3"]],
    ["a zero deposit", ["--deposit", "0"]],
    ["a shell metacharacter in --sign-as", ["--sign-as", "x; echo pwned"]],
  ])("mandate create rejects %s", async (_name, override) => {
    const base = { ...MANDATE_BASE };
    base[override[0] ?? ""] = override[1] ?? "";
    const { io, state } = testIo(dir);
    expect(await runCli(["mandate", "create", ...Object.entries(base).flat()], io)).toBe(1);
    expect(state.out).toBe("");
  });

  it("mandate create accepts the largest u32 use count", async () => {
    const { io, state } = testIo(dir);
    const argv = Object.entries({ ...MANDATE_BASE, "--uses": "4294967295" }).flat();
    expect(await runCli(["mandate", "create", ...argv], io)).toBe(0);
    expect(state.out).toContain('"max_uses": 4294967295');
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
    expect(state.out).toMatch(
      /add_agent file-args \S+ prepaid-gas '30\.0 Tgas' attached-deposit '1 yoctoNEAR'/,
    );
    await expectArgsFile(state.out, "add_agent", {
      public_key: TEST_KEYS.agent.publicKey,
      allowance: `1${"0".repeat(24)}`,
      label: "agent",
    });
    expect(
      await runCli(["ledger", "set-key", "--vault", VAULT, "--pk", TEST_KEYS.ledger.publicKey], io),
    ).toBe(0);
    await expectArgsFile(state.out, "set_ledger_key", {
      public_key: TEST_KEYS.ledger.publicKey,
      allowance: "250000000000000000000000",
    });
    expect(state.out).toMatch(
      /set_ledger_key file-args \S+ prepaid-gas '30\.0 Tgas' attached-deposit '1 yoctoNEAR'/,
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
    [["vault", "withdraw-intents", "--token", "base-other.testnet", "--amount", "1"], "--token"],
    [
      ["vault", "withdraw-intents", "--token", "usdc.probarion.testnet", "--amount", "1"],
      "--token",
    ],
    [["mandate", "revoke", "--mandate", "0"], "--mandate"],
    [["mandate", "revoke", "--mandate", "9007199254740992"], "--mandate"],
    [["spend", "approve", "--spend", "0"], "--spend"],
    [["spend", "reject", "--spend", "1.5"], "--spend"],
  ] as const)("%j is refused before anything is printed (names %s)", async (argv, flag) => {
    const { io, state } = testIo(dir, { PROBARION_VAULT_ID: VAULT });
    expect(await runCli(argv, io)).toBe(1);
    expect(state.err).toContain(flag);
    expect(state.out).toBe("");
    expect(await readdir(dir)).toEqual([]);
  });

  it.each([
    [
      ["agent", "remove", "--pk", TEST_KEYS.agent.publicKey],
      "remove_agent",
      { public_key: TEST_KEYS.agent.publicKey },
      "1 yoctoNEAR",
    ],
    [["mandate", "revoke", "--mandate", "2"], "revoke_mandate", { mandate_id: 2 }, "1 yoctoNEAR"],
    [
      ["mandate", "revoke", "--mandate", "9007199254740991"],
      "revoke_mandate",
      { mandate_id: 9007199254740991 },
      "1 yoctoNEAR",
    ],
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
      ["vault", "withdraw-intents", "--token", "base-usdc.probarion.testnet", "--amount", "1"],
      "withdraw_intents",
      { token: "base-usdc.probarion.testnet", amount: "1000000" },
      "1 yoctoNEAR",
    ],
  ] as const)(
    "%j prints %s with deposit %s (one-yocto rule)",
    async (argv, method, expected, deposit) => {
      const { io, state } = testIo(dir, { PROBARION_VAULT_ID: VAULT });
      expect(await runCli(["--network", "testnet", "--rpc", server.url, ...argv], io)).toBe(0);
      expect(state.out).toContain(`${VAULT} ${method} file-args ./${method}.`);
      expect(state.out).toContain(`attached-deposit '${deposit}'`);
      await expectArgsFile(state.out, method, expected);
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

  it("tells the owner which shell to paste into and how to sign with a Ledger", async () => {
    const { io, state } = testIo(dir, { PROBARION_VAULT_ID: VAULT });
    expect(await runCli(["vault", "freeze"], io)).toBe(0);
    expect(state.out).toContain("Run it in bash, zsh or PowerShell (not cmd.exe).");
    // near-cli-rs 0.30.1 rejects `sign-with-ledger send`: the transport word `usb` is required.
    expect(state.out).toContain(
      "replace `sign-with-keychain send` with `sign-with-ledger usb send`",
    );
    expect(state.out).not.toContain("replace sign-with-keychain by");
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

describe("args files are named by their content (T15-R1)", () => {
  const argv = (pk: string) => ["agent", "add", "--vault", VAULT, "--pk", pk, "--label", "a"];

  it("two different prints in one out-dir keep two files and two distinct commands", async () => {
    const first = testIo(dir);
    expect(await runCli(argv(TEST_KEYS.agent.publicKey), first.io)).toBe(0);
    const second = testIo(dir);
    expect(await runCli(argv(TEST_KEYS.other.publicKey), second.io)).toBe(0);

    const firstPath = printedArgsPath(first.state.out);
    const secondPath = printedArgsPath(second.state.out);
    expect(firstPath).not.toBe(secondPath);

    const files = (await readdir(dir)).filter((name) => name.endsWith(".args.json")).sort();
    expect(files).toHaveLength(2);
    expect(files).toEqual([firstPath, secondPath].map((p) => p.replace("./", "")).sort());

    // The command printed first still reads the arguments it was printed with.
    const firstArgs = JSON.parse(await readFile(join(dir, firstPath), "utf8")) as {
      public_key: string;
    };
    const secondArgs = JSON.parse(await readFile(join(dir, secondPath), "utf8")) as {
      public_key: string;
    };
    expect(firstArgs.public_key).toBe(TEST_KEYS.agent.publicKey);
    expect(secondArgs.public_key).toBe(TEST_KEYS.other.publicKey);
    expect(first.state.out).toContain(TEST_KEYS.agent.publicKey);
    expect(first.state.out).not.toContain(TEST_KEYS.other.publicKey);
  });

  it("the name is <method>.<12 hex of sha256 of the file>.args.json", async () => {
    const { io, state } = testIo(dir);
    expect(await runCli(argv(TEST_KEYS.agent.publicKey), io)).toBe(0);
    const shown = printedArgsPath(state.out);
    const text = await readFile(join(dir, shown), "utf8");
    expect(shown).toBe(`./add_agent.${sha256Hex(text).slice(0, 12)}.args.json`);
    expect(shown).toMatch(/^\.\/add_agent\.[0-9a-f]{12}\.args\.json$/);
  });

  it("identical prints share one file and print the same command", async () => {
    const first = testIo(dir);
    const second = testIo(dir);
    expect(await runCli(argv(TEST_KEYS.agent.publicKey), first.io)).toBe(0);
    expect(await runCli(argv(TEST_KEYS.agent.publicKey), second.io)).toBe(0);
    expect(printedArgsPath(second.state.out)).toBe(printedArgsPath(first.state.out));
    expect((await readdir(dir)).filter((name) => name.endsWith(".args.json"))).toHaveLength(1);
  });

  it("a change in any argument changes the name, a change in the signer does not", async () => {
    const base = testIo(dir);
    await runCli(argv(TEST_KEYS.agent.publicKey), base.io);
    const label = testIo(dir);
    await runCli(
      ["agent", "add", "--vault", VAULT, "--pk", TEST_KEYS.agent.publicKey, "--label", "b"],
      label.io,
    );
    const allowance = testIo(dir);
    await runCli([...argv(TEST_KEYS.agent.publicKey), "--allowance", "2"], allowance.io);
    const signer = testIo(dir);
    await runCli([...argv(TEST_KEYS.agent.publicKey), "--sign-as", "owner.testnet"], signer.io);
    const names = new Set([base, label, allowance].map((r) => printedArgsPath(r.state.out)));
    expect(names.size).toBe(3);
    expect(printedArgsPath(signer.state.out)).toBe(printedArgsPath(base.state.out));
  });
});
