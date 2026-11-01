import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatNear, fullAccessKeys, isUnknownAccount, parseNear } from "./chain.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));

// Stands in for the CI artifact (gh run download ... -n probarion-vault-wasm). Dry runs never read it.
const ARTIFACT = "contracts/target/ci-artifact/probarion_vault.wasm";
const DEPLOY_ENV = {
  OWNER_ID: "owner-dev.testnet",
  APPROVER_ID: "approver-dev.testnet",
  VAULT_WASM: ARTIFACT,
};

/** Runs a script with DRY_RUN=1. An env value of undefined removes the variable. */
function run(script, env) {
  const merged = { ...process.env, DRY_RUN: "1", ...env };
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

test("deploy.sh funds within the 10 NEAR a faucet account holds", () => {
  const out = dryRun("scripts/testnet/deploy.sh", DEPLOY_ENV);
  const balances = out
    .split("\n")
    .filter((l) => l.startsWith("+ near account create-account fund-myself "))
    .map((l) => /fund-myself \S+ '?([\d.]+) NEAR/.exec(l)?.[1]);
  assert.equal(balances.length, 5);
  const total = balances.reduce((sum, n) => sum + parseNear(n), 0n);
  assert.ok(
    total + parseNear("0.3") <= parseNear("10"),
    `${formatNear(total)} NEAR plus gas must fit in 10 NEAR`,
  );
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
  // The 244 KB local build needs more storage than the 102 KB reproducible one.
  at("create-account", "v0.probarion.testnet", "'3 NEAR'");
});

test("the reproducible vault gets the smaller balance and no warning", () => {
  const result = run("scripts/testnet/deploy.sh", DEPLOY_ENV);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stderr.includes("WARNING"), result.stderr);
  const at = finder(result.stdout);
  at("create-account", "v0.probarion.testnet", "'2 NEAR'");
});

test("smoke.sh adds the agent, pays, burns, then expects a NoMandate refusal", () => {
  const out = dryRun("scripts/testnet/smoke.sh", {
    OWNER_ID: "owner-dev.testnet",
    PAYEE_ID: "payee-dev.testnet",
    AGENT_KEY_FILE: "/tmp/agent.json",
  });
  const at = finder(out);
  const addAgent = at("add_agent");
  const firstSpend = at("v0.probarion.testnet", " spend ");
  const refusal = at("expect PROBARION:NoMandate");
  assert.ok(addAgent < firstSpend && firstSpend < refusal);
  assert.ok(
    out.includes("sign-with-access-key-file /tmp/agent.json"),
    "spends are signed with the agent key file",
  );
});

test("smoke.sh attaches 1 yoctoNEAR to add_agent and explicit gas to every call", () => {
  const out = dryRun("scripts/testnet/smoke.sh", {
    OWNER_ID: "owner-dev.testnet",
    PAYEE_ID: "payee-dev.testnet",
    AGENT_KEY_FILE: "/tmp/agent.json",
  });
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
