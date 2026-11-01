import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The text inside the ``` fences of a markdown file, one string per block. */
function codeBlocks(markdown) {
  const blocks = [];
  let current = null;
  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (current === null) {
        current = [];
      } else {
        blocks.push(current.join("\n"));
        current = null;
      }
    } else if (current !== null) {
      current.push(line);
    }
  }
  return blocks;
}

/** Shell commands with trailing-backslash continuation lines joined. */
function commands(markdown) {
  return codeBlocks(markdown)
    .join("\n")
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

test("the mainnet v0 runbook has every Day 4 step, in order", () => {
  const runbook = read("docs/runbooks/mainnet-v0.md");
  const steps = [
    'create-account fund-myself "$VAULT"',
    'contract deploy "$VAULT"',
    'delete-keys "$VAULT"',
    "storage_deposit",
    "ft_transfer",
    "mt_balance_of",
    "add_agent",
    "create_mandate",
    'mandate_id\\":1,',
    'mandate_id\\":2,',
    'mandate_id\\":999,',
  ];
  let from = 0;
  for (const step of steps) {
    const at = runbook.indexOf(step, from);
    assert.ok(at >= 0, `missing or out of order: ${step}`);
    from = at;
  }
});

test("the runbook uses the mainnet constants from interfaces §3 and the spec defaults", () => {
  const runbook = read("docs/runbooks/mainnet-v0.md");
  for (const value of [
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "intents.near",
    "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    "500000000",
    "259200000000000",
  ]) {
    assert.ok(runbook.includes(value), `missing ${value}`);
  }
});

test("mainnet.json has a slot for every proof transaction", () => {
  const record = JSON.parse(read("contracts/deployments/mainnet.json"));
  assert.equal(record.network, "mainnet");
  for (const key of [
    "first_near_payment_tx",
    "first_base_payout_tx",
    "first_base_payout_base_tx",
    "first_no_mandate_refusal_tx",
  ]) {
    assert.ok(key in record.proof, `missing proof.${key}`);
  }
});

test("the runbook records every README-cited transaction with pnpm proof add-tx (interfaces §16)", () => {
  const runbook = read("docs/runbooks/mainnet-v0.md");
  for (const id of [
    "v0_deploy",
    "v0_lock",
    "v0_agent_added",
    "v0_mandate_near",
    "v0_mandate_base",
    "first_near_payment",
    "first_base_payout",
    "refused_no_mandate",
  ]) {
    assert.ok(runbook.includes(`pnpm proof add-tx --id ${id} `), `no pnpm proof add-tx for ${id}`);
  }
});

test("the vault wasm comes only from the CI artifact of the recorded commit", () => {
  const runbook = read("docs/runbooks/mainnet-v0.md");
  const blocks = codeBlocks(runbook).join("\n");
  for (const command of [
    "git fetch origin",
    'RECORDED="$(node scripts/code-hash.mjs recorded-commit probarion-vault vault)"',
    "gh run list --repo probarion/probarion --workflow ci --branch dev --limit 30 --json databaseId,headSha,event,conclusion",
    "-n probarion-vault-wasm -D contracts/target/ci-artifact-mainnet",
    "REQUIRE_RECORDED=1 node scripts/code-hash.mjs check probarion-vault vault contracts/target/ci-artifact-mainnet/probarion_vault.wasm",
    "export WASM=contracts/target/ci-artifact-mainnet/probarion_vault.wasm",
  ]) {
    assert.ok(blocks.includes(command), `missing command: ${command}`);
  }
  assert.ok(runbook.includes("matches the recorded build"), "no expected output for check");
  // A local build is never used on mainnet, and the testnet escape hatch is never a command here.
  assert.ok(!runbook.includes("contracts/target/reproducible"), "mentions the local build path");
  assert.ok(!blocks.includes("ALLOW_NON_REPRODUCIBLE"), "ALLOW_NON_REPRODUCIBLE is in a command");
  assert.match(runbook, /never[^\n]*ALLOW_NON_REPRODUCIBLE|ALLOW_NON_REPRODUCIBLE[^\n]*never/);
  // The recorded commit is derived by the commands, never typed in.
  assert.ok(
    !/(?<![\w-])[0-9a-f]{40}(?!\w)/.test(blocks),
    "a commit hash is hard-coded in a command",
  );
  assert.ok(!blocks.includes("ba65435"), "the example commit is hard-coded in a command");
});

test("the runbook needs no jq: Node reads the JSON (scripts/testnet/chain.mjs)", () => {
  const runbook = read("docs/runbooks/mainnet-v0.md");
  assert.ok(!/\bjq\b/.test(runbook), "the runbook mentions jq");
  for (const use of [
    'node scripts/testnet/chain.mjs full-access-keys "$VAULT"',
    'node scripts/testnet/chain.mjs key-count "$VAULT"',
    'node scripts/testnet/chain.mjs code-hash "$VAULT"',
    'node scripts/testnet/chain.mjs public-key "$AGENT_KEY_FILE"',
    "export RPC=https://rpc.mainnet.fastnear.com",
  ]) {
    assert.ok(runbook.includes(use), `missing: ${use}`);
  }
});

test("commands use the shapes the testnet run proved (create-account, agent key, signing)", () => {
  const all = commands(read("docs/runbooks/mainnet-v0.md"));
  const create = all.filter((c) => c.includes("create-account fund-myself"));
  assert.equal(create.length, 1);
  assert.ok(
    create[0].includes("autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain"),
  );
  assert.ok(
    all.some((c) => c.includes("create-account fund-later use-auto-generation save-to-folder")),
  );
  // The agent key signs as the vault itself, from its key file.
  const spends = all.filter((c) => c.includes('as-transaction "$VAULT" spend'));
  assert.equal(spends.length, 3);
  for (const spend of spends) {
    assert.ok(
      spend.includes(
        'sign-as "$VAULT" network-config mainnet sign-with-access-key-file "$AGENT_KEY_FILE" send',
      ),
      `spend is not signed by the agent key file: ${spend}`,
    );
  }
});

test("gas follows docs/runbooks/testnet.md §5 for the vault calls", () => {
  const all = commands(read("docs/runbooks/mainnet-v0.md"));
  const wanted = { add_agent: 30, create_mandate: 100, spend: 200, freeze: 30, withdraw: 100 };
  wanted.withdraw_intents = 150;
  for (const [method, tgas] of Object.entries(wanted)) {
    const calls = all.filter((c) => c.includes(`as-transaction "$VAULT" ${method} `));
    assert.ok(calls.length > 0, `no ${method} call`);
    for (const call of calls) {
      const gas = /prepaid-gas '(\d+(?:\.\d+)?) Tgas'/.exec(call)?.[1];
      assert.equal(Number(gas), tgas, `${method} must attach ${tgas} Tgas: ${call}`);
    }
  }
  // Owner calls to one-yocto methods attach exactly 1 yoctoNEAR, spends and freeze attach nothing.
  for (const method of ["add_agent", "withdraw", "withdraw_intents"]) {
    for (const call of all.filter((c) => c.includes(`as-transaction "$VAULT" ${method} `))) {
      assert.ok(call.includes("attached-deposit '1 yoctoNEAR'"), `${method} needs 1 yoctoNEAR`);
    }
  }
  for (const call of all.filter((c) => c.includes('as-transaction "$VAULT" spend '))) {
    assert.ok(call.includes("attached-deposit '0 NEAR'"));
  }
});

test("the refused spend's hash comes from FastNEAR, with NearBlocks as the fallback", () => {
  const runbook = read("docs/runbooks/mainnet-v0.md");
  for (const part of [
    "https://tx.main.fastnear.com/v0/account",
    '"is_signer":true',
    "is_success",
    '"method\\":\\"tx\\"',
    '\\"wait_until\\":\\"NONE\\"',
    "Smart contract panicked: PROBARION:NoMandate",
    "https://nearblocks.io/address/v0.probarion.near",
    "https://api.nearblocks.io/v1/account/v0.probarion.near/txns?per_page=5",
  ]) {
    assert.ok(runbook.includes(part), `missing: ${part}`);
  }
  assert.ok(
    runbook.indexOf("tx.main.fastnear.com") < runbook.indexOf("api.nearblocks.io"),
    "FastNEAR must come before the NearBlocks fallback",
  );
});

test("the evidence files exist, use LF, and the decisions point at their invoices", () => {
  const texts = ["v0-po", "v0-invoice-1", "v0-invoice-2", "v0-invoice-refusal"];
  const decisions = [
    ["v0-decision-1", "v0-invoice-1", 1, "2000000"],
    ["v0-decision-2", "v0-invoice-2", 2, "2000000"],
    ["v0-decision-refusal", "v0-invoice-refusal", 999, "1000000"],
  ];
  const files = [
    ...texts.map((name) => `docs/evidence/${name}.txt`),
    ...decisions.map(([name]) => `docs/evidence/${name}.json`),
  ];
  for (const file of files) {
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `missing ${file}`);
    // The sha256 of each file becomes an on-chain hash, so its bytes must not depend on the OS.
    const text = read(file);
    assert.ok(!text.includes("\r"), `${file} has CR characters`);
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), `${file} must end in one newline`);
  }
  for (const [name, invoice, mandateId, amount] of decisions) {
    const decision = JSON.parse(read(`docs/evidence/${name}.json`));
    assert.equal(decision.kind, "v0-manual-decision");
    assert.equal(decision.invoice_file, `docs/evidence/${invoice}.txt`);
    assert.equal(decision.mandate_id, mandateId);
    assert.equal(decision.amount, amount);
    assert.equal(decision.verdict, "allow");
  }
  assert.match(read("docs/evidence/v0-invoice-refusal.txt"), /PROBARION:NoMandate/);
});
