import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    .map((line) => line.trim())
    .filter((line) => line !== "");
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
    // The Base USDC contract in its EIP-55 checksum spelling (wrong casing is an invalid checksum).
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ]) {
    assert.ok(runbook.includes(value), `missing ${value}`);
  }
  assert.ok(!runbook.includes("0x833589fCD6eDb6E08f4C7C32D4f71b54bdA02913"), "bad EIP-55 casing");
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
  // `check` accepts ANY recorded build, so the guard ties the artifact to the recorded commit.
  assert.ok(
    blocks.includes('grep -qF "matches the recorded build (commit $RECORDED)"'),
    "no guard that the checked artifact is the recorded commit",
  );
  assert.ok(runbook.includes("matches the recorded build (commit $RECORDED)"));
  // The output is captured, not piped through `tee /dev/stderr`: that truncates when stderr is a file.
  assert.ok(!blocks.includes("tee /dev/stderr"), "the guard still pipes through tee /dev/stderr");
  assert.ok(blocks.includes('CHECK_OUT="$(REQUIRE_RECORDED=1 node scripts/code-hash.mjs check'));
  assert.ok(blocks.includes('probarion_vault.wasm 2>&1)"\necho "$CHECK_OUT"'), "output not shown");
  assert.ok(blocks.includes("printf '%s\\n' \"$CHECK_OUT\" | grep -qF"));
  assert.ok(blocks.includes('echo "OK: artifact is the recorded build"'));
  assert.ok(blocks.includes('echo "STOP: wrong artifact, do not deploy"'));
  assert.match(runbook, /On `STOP`, stop and tell Claude/);
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
  const wanted = {
    add_agent: 30,
    remove_agent: 30,
    revoke_mandate: 30,
    create_mandate: 100,
    spend: 200,
    freeze: 30,
    withdraw: 100,
    withdraw_intents: 150,
  };
  for (const [method, tgas] of Object.entries(wanted)) {
    const calls = all.filter((c) => c.includes(`as-transaction "$VAULT" ${method} `));
    assert.ok(calls.length > 0, `no ${method} call`);
    for (const call of calls) {
      const gas = /prepaid-gas '(\d+(?:\.\d+)?) Tgas'/.exec(call)?.[1];
      assert.equal(Number(gas), tgas, `${method} must attach ${tgas} Tgas: ${call}`);
    }
  }
  // Owner calls to one-yocto methods attach exactly 1 yoctoNEAR.
  const oneYocto = ["add_agent", "remove_agent", "revoke_mandate", "withdraw", "withdraw_intents"];
  for (const method of oneYocto) {
    for (const call of all.filter((c) => c.includes(`as-transaction "$VAULT" ${method} `))) {
      assert.ok(call.includes("attached-deposit '1 yoctoNEAR'"), `${method} needs 1 yoctoNEAR`);
    }
  }
  // Spends and freeze attach nothing: freeze is not payable, so any deposit makes it panic.
  for (const method of ["spend", "freeze"]) {
    for (const call of all.filter((c) => c.includes(`as-transaction "$VAULT" ${method} `))) {
      assert.ok(call.includes("attached-deposit '0 NEAR'"), `${method} must attach '0 NEAR'`);
    }
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

test("the evidence files have the exact bytes whose sha256 becomes an on-chain hash", () => {
  // purpose_hash, invoice_hash and decision_hash of the Day 4 spends are these digests. If one of
  // these changes (an edit, a formatter, a line-ending conversion), the hashes in the mandates and
  // the spends no longer match the files in the repo. Change a file only on purpose, with this table.
  const pinned = {
    "v0-po.txt": "30cdebeaa06b60c55f48662123b77b7fe97c0d44ce3c9d10c861c690e21488dc",
    "v0-invoice-1.txt": "0f6567aeaf517d3ea2270388169afb7e7e70c378b1d8ffd07585dfe9aeea8f4b",
    "v0-invoice-2.txt": "c1267f368fea15adc277b29dc8dd38a361ccdc1e2953d177014bd7914d1f86ac",
    "v0-invoice-refusal.txt": "03f5854ef2555ff209ad01330f73d15dc82f49431eddbc62e9564b5a3c716053",
    "v0-decision-1.json": "64eaf4203ca06a1bf20c76bd235df60be3640c3a15b85e632f8c8c86ef4a1672",
    "v0-decision-2.json": "5cadc59418b90e510ab73e0d73614aee5391d7122bd7c8d58e0cd99b82b3fd11",
    "v0-decision-refusal.json": "aa8a907f0666ab97fe78e8d9e6b77ed4572db5ed7132a6a6776325d4c0bc6dd0",
  };
  for (const [name, digest] of Object.entries(pinned)) {
    const bytes = readFileSync(new URL(`../docs/evidence/${name}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, `${name} changed`);
  }
  // A formatter must never touch them: biome ignores the folder.
  const biome = JSON.parse(read("biome.json"));
  assert.ok(
    biome.files.includes.includes("!docs/evidence"),
    "biome.json must exclude docs/evidence",
  );
});

test("the money-safety order: guards before the deploy, checks before the irreversible lock", () => {
  const runbook = read("docs/runbooks/mainnet-v0.md");
  const inOrder = [
    // The wasm is the recorded commit's CI build (and `check` alone accepts any recorded build).
    'grep -qF "matches the recorded build (commit $RECORDED)"',
    // Owner and approver are permanent after the lock: the owner confirms them before the deploy.
    'echo "owner: $OWNER_ID  approver: $APPROVER_ID"',
    "account by account",
    'contract deploy "$VAULT"',
    // Everything about the deployed vault is verified while the account can still be fixed.
    'as-read-only "$VAULT" get_config',
    "OK: get_config is exactly what was meant",
    'node scripts/testnet/chain.mjs code-hash "$VAULT"',
    "OK: the deployed code is the CI wasm",
    "## 3. Lock",
    "Run this step only if every check of step 2 passed",
    'node scripts/testnet/chain.mjs full-access-keys "$VAULT"',
    'echo "STOP: expected exactly one full-access key"',
    'delete-keys "$VAULT"',
  ];
  let from = 0;
  for (const step of inOrder) {
    const at = runbook.indexOf(step, from);
    assert.ok(at >= 0, `missing or out of order: ${step}`);
    from = at;
  }
  // The comparison covers every field the owner cannot change after the lock.
  for (const field of [
    "owner:e.OWNER_ID",
    "approvers:[e.APPROVER_ID]",
    "usdc:e.USDC",
    "frozen:false",
  ]) {
    assert.ok(runbook.includes(field), `the get_config guard does not compare ${field}`);
  }
  assert.match(runbook, /no method to change its `owner` or `approvers`/);
  // Guard 2 needs both hashes non-empty: two empty values (RPC error plus unset WASM) are no match.
  assert.ok(
    runbook.includes('[ -n "$DEPLOYED" ] && [ -n "$BUILT" ] && [ "$DEPLOYED" = "$BUILT" ]'),
    "the code-hash guard does not require both hashes to be non-empty",
  );
  assert.ok(!runbook.includes('"$(node scripts/testnet/chain.mjs code-hash "$VAULT")" ='));
  // The owner and approver confirmation is a condition of the lock, and of the deploy.
  assert.match(runbook, /the owner and approver were confirmed against the wallet apps/);
  assert.match(runbook, /If either differs, do not deploy: stop and tell Claude/);
  // A comma would delete several keys at once.
  assert.ok(runbook.includes('""|*,*) echo "STOP: expected exactly one full-access key"'));
});

test("both payees are verified against the owner's own wallets, and a wrong one is revoked", () => {
  const runbook = read("docs/runbooks/mainnet-v0.md");
  const all = commands(runbook);
  // Mandate 1: the stored payee is shown and the owner confirms they control it, before step 9.
  const mandateOne = runbook.indexOf("get_mandate json-args '{\"mandate_id\":1}'");
  assert.ok(mandateOne > runbook.indexOf("Expected result: `1`"), "no get_mandate for mandate 1");
  assert.ok(
    mandateOne < runbook.indexOf('mandate_id\\":1,'),
    "mandate 1 is not checked before step 9",
  );
  // Mandate 2: the address is printed and compared with the wallet app BEFORE the mandate exists,
  // and the on-chain copy is compared with the wallet app (not with the variable) before step 10.
  const echoAddress = runbook.indexOf('echo "$BASE_PAYEE_ADDRESS"');
  const baseMandate = runbook.indexOf('\\"type\\":\\"intents\\"');
  const mandateTwo = runbook.indexOf("get_mandate json-args '{\"mandate_id\":2}'");
  const firstBaseSpend = runbook.indexOf('mandate_id\\":2,');
  assert.ok(echoAddress > 0 && echoAddress < baseMandate, "address not compared before mandate 2");
  assert.ok(
    baseMandate < mandateTwo && mandateTwo < firstBaseSpend,
    "mandate 2 not checked on chain",
  );
  assert.match(runbook, /character by character/);
  // The intro: the NEAR payee gets the on-chain check and "do you control it", not "twice".
  assert.ok(!runbook.includes("checks both payees against their own wallets, twice"));
  assert.match(
    runbook,
    /The NEAR payee \(mandate 1\) gets the on-chain check plus the owner's confirmation/,
  );
  assert.match(runbook, /The Base payee \(mandate 2\) gets one more check/);
  assert.match(runbook, /Do not compare it with `\$BASE_PAYEE_ADDRESS`/);
  assert.match(runbook, /do not run step 10/);
  assert.match(runbook, /do not run step 9/);
  // revoke_mandate is in the runbook (recovery) and signed by the owner.
  const revoke = all.filter((c) => c.includes('as-transaction "$VAULT" revoke_mandate '));
  assert.equal(revoke.length, 1);
  assert.ok(revoke[0].includes("json-args '{\"mandate_id\":2}'"));
  assert.ok(revoke[0].includes('sign-as "$OWNER_ID"'));
  const recovery = runbook.indexOf("## If anything looks wrong");
  assert.ok(recovery > 0 && runbook.indexOf('as-transaction "$VAULT" revoke_mandate ') > recovery);
});

test("the vault is funded with 3 NEAR, checked, and topped up from probarion.near if needed", () => {
  const runbook = read("docs/runbooks/mainnet-v0.md");
  const all = commands(runbook);
  assert.ok(!runbook.includes("'6 NEAR'") && !runbook.includes("(6 NEAR)"));
  const create = all.filter((c) => c.includes("create-account fund-myself"));
  assert.equal(create.length, 1);
  assert.ok(create[0].includes("\"$VAULT\" '3 NEAR' autogenerate-new-keypair"));
  // One story for the reserve: 3 NEAR for the vault + one 0.5 NEAR top-up (+ gas) = about 4 NEAR.
  assert.ok(all.includes('node scripts/testnet/chain.mjs enough "$ROOT" 3 0.5   # exit code 0'));
  assert.ok(runbook.includes("about 4 NEAR in `probarion.near`"));
  assert.ok(!runbook.includes("3.5 NEAR"), "a stale 3.5 NEAR figure");
  // The measured numbers behind the 3 NEAR (testnet, identical wasm).
  for (const fact of ["250,733 bytes", "2.507 NEAR", "0.4955 NEAR", "0.0016 NEAR", "cap"]) {
    assert.ok(runbook.includes(fact), `budget line lacks ${fact}`);
  }
  // Free NEAR = balance - storage_usage x 1e19, and below 0.2 NEAR the owner tops the vault up.
  assert.ok(runbook.includes("BigInt(a.storage_usage)*10n**19n"));
  assert.match(runbook, /free NEAR is below 0\.2/);
  const topUp = all.filter((c) => c.includes("send-near"));
  assert.deepEqual(topUp, [
    'near tokens "$ROOT" send-near "$VAULT" \'0.5 NEAR\' network-config mainnet sign-with-keychain send',
  ]);
});

test("probarion.near is checked on mainnet, not on testnet's default RPC", () => {
  const all = commands(read("docs/runbooks/mainnet-v0.md"));
  assert.ok(
    all.includes(
      "RPC=https://rpc.mainnet.fastnear.com node scripts/testnet/chain.mjs exists probarion.near   # must print yes",
    ),
  );
  // Any other chain.mjs account query comes after `export RPC=` (section 0.2).
  const runbook = read("docs/runbooks/mainnet-v0.md");
  const exported = runbook.indexOf("export RPC=https://rpc.mainnet.fastnear.com");
  for (const m of runbook.matchAll(
    /^(?:\s*)(?:for .*; do )?node scripts\/testnet\/chain\.mjs (exists|balance|enough|full-access-keys|key-count|code-hash|public-key) /gm,
  )) {
    assert.ok(m.index > exported, `chain.mjs ${m[1]} runs before RPC is exported: ${m[0]}`);
  }
});

test("check_spend gates every spend, and the payee's balance is read before the first one", () => {
  const runbook = read("docs/runbooks/mainnet-v0.md");
  const gates = runbook.match(/do not sign the spend: stop and tell Claude/g) ?? [];
  assert.equal(gates.length, 2, "steps 9 and 10 both need the check_spend stop rule");
  const expected = '`{"ok": true, "code": null, "would_hold": false}`';
  assert.equal(runbook.split(expected).length - 1, 2, "steps 9 and 10 both need the Expected line");
  const balance = runbook.indexOf('ft_balance_of json-args "{\\"account_id\\":\\"$PAYEE_ID\\"}"');
  const firstSpend = runbook.indexOf('as-transaction "$VAULT" spend');
  assert.ok(balance > 0 && balance < firstSpend, "payee balance not read before the first spend");
});

test("the recorded-commit guard runs only on a checkout that is origin/dev", () => {
  // `recorded-commit` answers for the local HEAD, so a stale checkout would approve a stale vault.
  const runbook = read("docs/runbooks/mainnet-v0.md");
  const blocks = codeBlocks(runbook).join("\n");
  for (const part of [
    "git fetch origin",
    '[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/dev)" ]',
    'echo "OK: HEAD is origin/dev"',
    'echo "STOP: HEAD is not origin/dev',
  ]) {
    assert.ok(blocks.includes(part), `missing: ${part}`);
  }
  assert.ok(
    blocks.indexOf('echo "STOP: HEAD is not origin/dev') <
      blocks.indexOf('RECORDED="$(node scripts/code-hash.mjs recorded-commit'),
    "the checkout guard must come before recorded-commit",
  );
  assert.match(runbook, /`recorded-commit` answers for the local `HEAD`/);
  assert.match(runbook, /prints `OK: HEAD is origin\/dev`/);
});

test("the vault's free NEAR is a storage runway, with the numbers measured on testnet", () => {
  const runbook = read("docs/runbooks/mainnet-v0.md");
  assert.ok(!/stays free for gas/.test(runbook), "the free NEAR is still called a gas reserve");
  assert.match(runbook, /not a gas reserve/);
  for (const fact of [
    "`v0.probarion.testnet`",
    "`view_state`",
    "about 480 bytes",
    "0.0048 NEAR",
    "about 363 bytes",
    "0.0036 NEAR",
    "about 0.0005 NEAR",
    "about 90%",
    "about 100 payments",
    "`LackBalanceForState`",
    "not with a `PROBARION:` code",
    "no method to withdraw NEAR",
  ]) {
    assert.ok(runbook.includes(fact), `missing: ${fact}`);
  }
  // The top-up command and its trigger are still the ones in step 9.
  assert.match(runbook, /free NEAR is below 0\.2/);
  assert.ok(runbook.includes("send-near"));
});

test("signing wording: keys are written only to the keychain or .keys/, and no command prints one", () => {
  const runbook = read("docs/runbooks/mainnet-v0.md");
  assert.ok(runbook.includes("sign-with-ledger"));
  // near-cli-rs 0.30.1 rejects `sign-with-ledger send`; the Ledger transport word `usb` is required.
  assert.ok(runbook.includes("`sign-with-keychain send` with `sign-with-ledger usb send`"));
  assert.ok(!runbook.includes("No command here prints or stores a private key"));
  assert.match(runbook, /Keys are written only to the keychain.*git-ignored `\.keys\/` folder/);
  assert.match(runbook, /no command prints one/);
  assert.ok(runbook.includes("save-to-keychain") && runbook.includes("save-to-folder"));
});

test("the Day 4 gate lets only the Base transaction hash stay pending", () => {
  const runbook = read("docs/runbooks/mainnet-v0.md");
  const gate = runbook.split("\n").find((line) => line.startsWith("- Day 4 gate:"));
  assert.ok(gate, "no Day 4 gate line");
  assert.ok(!gate.includes("all four `proof.*` fields"), "the gate still demands all four");
  for (const part of [
    "first_near_payment_tx",
    "first_base_payout_tx",
    "first_no_mandate_refusal_tx",
    "first_base_payout_base_tx",
    "burned, awaiting bridge",
    "may be pending",
    "filled when the Base transfer lands",
    "WITHDRAW_TO:",
  ]) {
    assert.ok(gate.includes(part), `the gate lacks: ${part}`);
  }
  // Step 10 points at the gate, so the two never disagree.
  assert.match(
    runbook,
    /the Day 4 gate \(step 12\) allows `proof\.first_base_payout_base_tx` to stay pending/,
  );
});
