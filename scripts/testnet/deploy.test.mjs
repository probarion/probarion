import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatNear, fullAccessKeys, isUnknownAccount, parseNear } from "./chain.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));

// A path that exists on no machine. The runbook downloads the CI artifact to
// contracts/target/ci-artifact, and these tests must give the same result whether or not it is there.
// A dry run then prints that the file is not there yet, and deploy.sh assumes the size of the CI wasm
// (248,501 bytes).
const ARTIFACT = "contracts/target/test-no-such-artifact/probarion_vault.wasm";
// A key file that exists on no machine: a dry run then uses a placeholder public key.
const AGENT_KEY = "/tmp/probarion-test-no-such-agent-key.json";
const RUNBOOK = readFileSync(new URL("../../docs/runbooks/testnet.md", import.meta.url), "utf8");
const DEPLOY_ENV = {
  OWNER_ID: "owner-dev.testnet",
  APPROVER_ID: "approver-dev.testnet",
  VAULT_WASM: ARTIFACT,
};
const SMOKE_ENV = {
  OWNER_ID: "owner-dev.testnet",
  PAYEE_ID: "payee-dev.testnet",
  AGENT_KEY_FILE: AGENT_KEY,
};

// Every variable either script reads: a value inherited from the machine must not change a result.
const SCRIPT_VARS = [
  "ROOT",
  "OWNER_ID",
  "APPROVER_ID",
  "PAYEE_ID",
  "AGENT_KEY_FILE",
  "BASE_ADDRESS",
  "VAULT_NAME",
  "VAULT_WASM",
  "ALLOW_NON_REPRODUCIBLE",
  "TOKEN_NEAR",
  "STUB_NEAR",
  "VAULT_NEAR",
  "RPC",
  "DRY_RUN",
];

/** Runs a script with DRY_RUN=1 and a clean environment. An env value of undefined removes a variable. */
function run(script, env) {
  const merged = { ...process.env };
  for (const name of SCRIPT_VARS) delete merged[name];
  Object.assign(merged, { DRY_RUN: "1", ...env });
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return spawnSync("bash", [script], { cwd: repo, encoding: "utf8", env: merged });
}

function dryRun(script, env) {
  const result = run(script, env);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes("mainnet"), "the testnet script must never touch mainnet");
  assert.ok(!result.stderr.includes("mainnet"), "the testnet script must never touch mainnet");
  return result.stdout;
}

function finder(out) {
  const lines = out.split("\n");
  return (...parts) => {
    const i = lines.findIndex((l) => parts.every((p) => l.includes(p)));
    assert.ok(i >= 0, `no line contains ${parts.join(" + ")}`);
    return i;
  };
}

/** The initial balances (NEAR) of the five accounts in a dry run: usdc, base, sol, stub, vault. */
function balances(out) {
  const found = out
    .split("\n")
    .filter((l) => l.startsWith("+ near account create-account fund-myself "))
    .map((l) => /fund-myself \S+ '?([\d.]+) NEAR/.exec(l)?.[1]);
  assert.equal(found.length, 5);
  return found;
}

/** Runs a dry deploy with a stand-in vault wasm of the given size (git-ignored, under contracts/target). */
function withStandIn(bytes, env, check) {
  const dir = `contracts/target/test-standin-${process.pid}-${bytes}`;
  mkdirSync(join(repo, dir), { recursive: true });
  try {
    writeFileSync(join(repo, dir, "probarion_vault.wasm"), Buffer.alloc(bytes));
    const vaultWasm = `${dir}/probarion_vault.wasm`;
    check(run("scripts/testnet/deploy.sh", { ...DEPLOY_ENV, ...env, VAULT_WASM: vaultWasm }));
  } finally {
    rmSync(join(repo, dir), { recursive: true, force: true });
  }
}

test("deploy.sh deploys every contract, then locks the vault before funding it", () => {
  const out = dryRun("scripts/testnet/deploy.sh", DEPLOY_ENV);
  const at = finder(out);
  for (const id of ["usdc", "base-usdc", "sol-usdc", "intents-stub"]) {
    at("contract deploy", `${id}.probarion.testnet`);
    assert.ok(
      out
        .split("\n")
        .some((l) => l.startsWith(`+ near contract deploy ${id}.probarion.testnet use-file `)),
      `${id} is deployed from a file`,
    );
  }
  const deployVault = at("contract deploy", "v0.probarion.testnet", "probarion_vault.wasm");
  assert.ok(
    out.includes(`use-file ${ARTIFACT} with-init-call new`),
    "the vault is the artifact wasm",
  );
  const lock = at("delete-keys", "v0.probarion.testnet");
  const fund = at("mint", "v0.probarion.testnet");
  assert.ok(deployVault < lock && lock < fund, "the vault must be locked before it is funded");
});

test("deploy.sh signs with the keychain and attaches 1 yoctoNEAR to the transfer-call", () => {
  const out = dryRun("scripts/testnet/deploy.sh", DEPLOY_ENV);
  const commands = out.split("\n").filter((l) => l.startsWith("+ near "));
  assert.ok(commands.length > 20, "a full deploy prints its commands");
  for (const command of commands) {
    if (command.includes("as-read-only")) continue;
    assert.ok(command.includes("sign-with-keychain"), `signed with the keychain: ${command}`);
    assert.ok(!command.includes("plaintext"), command);
  }
  const transferCalls = commands.filter((l) => l.includes(" ft_transfer_call "));
  assert.equal(transferCalls.length, 2);
  for (const command of transferCalls) {
    assert.ok(command.includes("attached-deposit '1 yoctoNEAR'"), command);
    assert.ok(command.includes("prepaid-gas '100 Tgas'"), command);
  }
});

test("deploy.sh's balances fit in 10 NEAR plus the top-up the runbook documents", () => {
  const out = dryRun("scripts/testnet/deploy.sh", DEPLOY_ENV);
  const total = balances(out).reduce((sum, n) => sum + parseNear(n), 0n);
  // The CI wasm is 248,501 bytes (2.49 NEAR of storage), so the vault gets 3: 10.3 NEAR in all.
  assert.equal(formatNear(total), "10.3");
  const topUp = /send-near probarion\.testnet '(\d+(?:\.\d+)?) NEAR'/.exec(RUNBOOK)?.[1];
  assert.ok(topUp, "the runbook gives the command that tops up the root account");
  assert.ok(
    total + parseNear("0.3") <= parseNear("10") + parseNear(topUp),
    `${formatNear(total)} NEAR plus gas must fit in 10 NEAR plus the ${topUp} NEAR top-up`,
  );
});

test("every account is created with an explicit ed25519 key scheme, so no prompt can block", () => {
  const out = dryRun("scripts/testnet/deploy.sh", DEPLOY_ENV);
  const creates = out.split("\n").filter((l) => l.includes(" create-account "));
  assert.equal(creates.length, 5);
  for (const command of creates) {
    assert.ok(
      command.includes(" autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain "),
      command,
    );
  }
  // The runbook's own autogenerate command too.
  const manual = RUNBOOK.split("\n").filter((l) => l.includes("autogenerate-new-keypair"));
  assert.ok(manual.length >= 1);
  for (const command of manual) {
    assert.ok(command.includes("autogenerate-new-keypair --signature-scheme ed25519 "), command);
  }
});

test("deploy.sh refuses to deploy the vault without a reproducible wasm", () => {
  const result = run("scripts/testnet/deploy.sh", {
    ...DEPLOY_ENV,
    VAULT_WASM: undefined,
    ALLOW_NON_REPRODUCIBLE: undefined,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to deploy the vault: VAULT_WASM is not set/);
  assert.match(result.stderr, /gh run download/);
  assert.ok(
    !result.stdout.includes("contract deploy"),
    "nothing is printed, let alone sent, first",
  );
});

test("ALLOW_NON_REPRODUCIBLE=1 deploys the local vault build with a loud warning", () => {
  const result = run("scripts/testnet/deploy.sh", {
    ...DEPLOY_ENV,
    VAULT_WASM: undefined,
    ALLOW_NON_REPRODUCIBLE: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /WARNING: ALLOW_NON_REPRODUCIBLE=1/);
  assert.match(result.stderr, /NON-REPRODUCIBLE/);
  assert.ok(!result.stdout.includes("mainnet") && !result.stderr.includes("mainnet"));
  const at = finder(result.stdout);
  at(
    "contract deploy",
    "v0.probarion.testnet",
    "contracts/target/near/probarion_vault/probarion_vault.wasm",
  );
  // A local build (about 245 KB) needs at least as much storage as the CI wasm.
  const vaultNear = balances(result.stdout)[4];
  assert.ok(Number(vaultNear) >= 3, `the vault got ${vaultNear} NEAR`);
});

test("the CI vault wasm, 248,501 bytes, gets 3 NEAR and no warning", () => {
  // The file is absent, so deploy.sh assumes the size of the CI wasm. A dry run does not need the file.
  const result = run("scripts/testnet/deploy.sh", DEPLOY_ENV);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stderr.includes("WARNING"), result.stderr);
  assert.deepEqual(balances(result.stdout), ["1.8", "1.8", "1.8", "1.9", "3"]);
});

test("the vault balance follows the size of the wasm file", () => {
  // These stand-ins are not a recorded build, so ALLOW_NON_REPRODUCIBLE=1 lets the dry run go on.
  for (const [bytes, expected] of [
    [248_501, "3"],
    [101_654, "2"],
  ]) {
    withStandIn(bytes, { ALLOW_NON_REPRODUCIBLE: "1" }, (result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /does NOT match/);
      assert.match(result.stdout, /Vault v0\.probarion\.testnet \(unverified wasm\)/);
      assert.equal(balances(result.stdout)[4], expected, `${bytes} bytes`);
    });
  }
});

test("a wasm that is not the recorded build is refused without ALLOW_NON_REPRODUCIBLE", () => {
  withStandIn(248_501, {}, (result) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match the recorded reproducible build/);
    assert.ok(!result.stdout.includes("contract deploy"), "nothing is printed before the refusal");
  });
});

test("smoke.sh adds the agent, pays, burns, then expects a NoMandate refusal", () => {
  const out = dryRun("scripts/testnet/smoke.sh", SMOKE_ENV);
  const at = finder(out);
  const addAgent = at("add_agent");
  const firstSpend = at("v0.probarion.testnet", " spend ");
  const refusal = at("expect PROBARION:NoMandate");
  assert.ok(addAgent < firstSpend && firstSpend < refusal);
  assert.ok(
    out.includes(`sign-with-access-key-file ${AGENT_KEY}`),
    "spends are signed with the agent key file",
  );
});

test("smoke.sh attaches 1 yoctoNEAR to add_agent and explicit gas to every call", () => {
  const out = dryRun("scripts/testnet/smoke.sh", SMOKE_ENV);
  const commands = out.split("\n").filter((l) => l.includes("as-transaction"));
  const addAgent = commands.filter((l) => l.includes(" add_agent "));
  assert.equal(addAgent.length, 1);
  assert.ok(addAgent[0].includes("attached-deposit '1 yoctoNEAR'"), addAgent[0]);
  assert.ok(addAgent[0].includes("sign-with-keychain"), "the owner signs with the keychain");
  const spends = commands.filter((l) => l.includes(" spend "));
  assert.equal(spends.length, 3, "a NEAR payment, a Base burn and the refused spend");
  for (const command of spends) {
    assert.ok(
      command.includes("prepaid-gas '200 Tgas'"),
      `a cascading spend needs explicit gas: ${command}`,
    );
    assert.ok(command.includes("attached-deposit '0 NEAR'"), command);
    assert.ok(command.includes("sign-as v0.probarion.testnet"), command);
  }
  for (const command of commands.filter((l) => l.includes(" create_mandate "))) {
    assert.ok(command.includes("sign-as owner-dev.testnet"), command);
    assert.ok(command.includes("prepaid-gas '100 Tgas'"), command);
  }
  // Every mandate is created before its first payment.
  const lines = out.split("\n");
  const lastMandate = lines.findLastIndex((l) => l.includes(" create_mandate "));
  const firstSpend = lines.findIndex((l) => l.includes(" spend "));
  assert.ok(lastMandate < firstSpend);
});

test("both scripts are valid bash", () => {
  for (const script of ["scripts/testnet/deploy.sh", "scripts/testnet/smoke.sh"]) {
    const result = spawnSync("bash", ["-n", script], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test("contracts/deployments/testnet.json names the accounts that deploy.sh creates", () => {
  const record = JSON.parse(
    readFileSync(new URL("../../contracts/deployments/testnet.json", import.meta.url), "utf8"),
  );
  assert.equal(record.network, "testnet");
  const out = dryRun("scripts/testnet/deploy.sh", DEPLOY_ENV);
  const deployed = out
    .split("\n")
    .map((l) => /^\+ near contract deploy (\S+) /.exec(l)?.[1])
    .filter(Boolean);
  const { accounts } = record;
  assert.deepEqual(
    deployed.sort(),
    [
      accounts.usdc,
      accounts.base_asset,
      accounts.solana_asset,
      accounts.intents_stub,
      accounts.vault_v0,
    ].sort(),
  );
  assert.equal(accounts.root, "probarion.testnet");
  for (const account of deployed) assert.ok(account.endsWith(`.${accounts.root}`));
});

test("chain.mjs reads amounts and keys without jq", () => {
  assert.equal(parseNear("1.8"), 1_800_000_000_000_000_000_000_000n);
  assert.equal(parseNear("10"), 10n ** 25n);
  assert.equal(formatNear(parseNear("9.3")), "9.3");
  assert.equal(formatNear(10n ** 25n), "10");
  assert.equal(formatNear(0n), "0");
  for (const bad of ["", "1.", ".5", "-1", "1,8", "1e3", "1 NEAR"]) {
    assert.throws(() => parseNear(bad), /not an amount/, bad);
  }
  const keys = {
    keys: [
      { public_key: "ed25519:full", access_key: { nonce: 0, permission: "FullAccess" } },
      {
        public_key: "ed25519:agent",
        access_key: {
          nonce: 0,
          permission: { FunctionCall: { receiver_id: "v0", method_names: ["spend"] } },
        },
      },
    ],
  };
  assert.deepEqual(fullAccessKeys(keys), ["ed25519:full"]);
  assert.deepEqual(fullAccessKeys({ keys: [] }), []);
  assert.ok(isUnknownAccount({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } }));
  assert.ok(!isUnknownAccount({ result: { amount: "1" } }));
});
