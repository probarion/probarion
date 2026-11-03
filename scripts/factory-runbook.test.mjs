import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The text inside the ``` fences of a markdown file, joined (the same helper as mainnet-runbook.test.mjs). */
function blocksOf(markdown) {
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
  return blocks.join("\n");
}

/** `later` must come after `earlier` in `text`, and both must exist. */
function assertOrder(text, earlier, later, message) {
  const a = text.indexOf(earlier);
  const b = text.indexOf(later, Math.max(a, 0));
  assert.ok(a >= 0, `missing: ${earlier}`);
  assert.ok(b >= 0, `missing after "${earlier}": ${later}`);
  assert.ok(a < b, message ?? `out of order: ${earlier} / ${later}`);
}

const factory = read("docs/runbooks/factory.md");
const factoryBlocks = blocksOf(factory);

test("the factory runbook checks out the commit it means to deploy before it asks which commit is recorded", () => {
  // `recorded-commit` answers for the local HEAD: a stale checkout would approve a stale build.
  assert.ok(factoryBlocks.includes("git fetch origin --tags"));
  assert.ok(factoryBlocks.includes(`export WANT_REF="\${WANT_REF:-origin/dev}"`));
  assert.ok(
    factoryBlocks.includes('[ "$(git rev-parse HEAD)" = "$(git rev-parse "$WANT_REF^{commit}")" ]'),
  );
  assert.ok(factoryBlocks.includes('echo "OK: HEAD is $WANT_REF"'));
  assert.ok(factoryBlocks.includes('echo "STOP: HEAD is not $WANT_REF'));
  assertOrder(
    factoryBlocks,
    'echo "STOP: HEAD is not $WANT_REF',
    "recorded-commit probarion-vault vault",
  );
  assert.match(factory, /`recorded-commit` answers for the local `HEAD`/);
  assert.match(factory, /freeze tag/);
});

test("both factory-runbook wasm files are tied to the commit recorded for their own crate", () => {
  for (const [crate, dir, lib, upper] of [
    ["probarion-vault", "vault", "probarion_vault", "VAULT"],
    ["probarion-factory", "factory", "probarion_factory", "FACTORY"],
  ]) {
    const recorded = `RECORDED_${upper}`;
    assert.ok(
      factoryBlocks.includes(
        `${recorded}="$(node scripts/code-hash.mjs recorded-commit ${crate} ${dir})"`,
      ),
      `no ${recorded} from recorded-commit`,
    );
    // `check` accepts ANY recorded build, so its output must name exactly this crate's commit.
    assert.ok(
      factoryBlocks.includes(
        `CHECK_${upper}="$(REQUIRE_RECORDED=1 node scripts/code-hash.mjs check ${crate} ${dir} contracts/target/ci-artifact/${lib}.wasm 2>&1)"`,
      ),
      `${crate}: the check output is not captured`,
    );
    assert.ok(factoryBlocks.includes(`echo "$CHECK_${upper}"`), `${crate}: output not shown`);
    assert.ok(
      factoryBlocks.includes(
        `[ "\${#${recorded}}" = 40 ] && printf '%s\\n' "$CHECK_${upper}" | grep -qF "matches the recorded build (commit $${recorded})"`,
      ),
      `${crate}: no guard on the recorded commit`,
    );
    assert.ok(factoryBlocks.includes(`echo "OK: ${dir} artifact is the recorded build"`));
    assert.ok(factoryBlocks.includes(`echo "STOP: wrong ${dir} artifact, do not deploy"`));
  }
  // The guard of each crate comes before its hash is used.
  assertOrder(
    factoryBlocks,
    'echo "OK: factory artifact is the recorded build"',
    "export VAULT_WASM=",
  );
  assertOrder(
    factoryBlocks,
    'echo "OK: vault artifact is the recorded build"',
    "export VAULT_WASM=",
  );
  // The run id is required, never a placeholder, and the two crates may be recorded apart.
  assert.ok(
    factoryBlocks.includes(
      `export RUN_ID="\${RUN_ID:?the CI push run whose headSha is the recorded commit}"`,
    ),
  );
  assert.ok(!factory.includes("<run-id>"), "a <run-id> placeholder is left");
  assert.match(factory, /different commits/);
  assert.match(factory, /On `STOP`, stop and tell Claude/);
  // The recorded commit is derived by the commands, never typed in.
  assert.ok(!/(?<![\w-])[0-9a-f]{40}(?!\w)/.test(factoryBlocks), "a commit hash is hard-coded");
});

test("the vault's NEAR runway is stated, and min_deposit is the OWNER's decision before Day 7", () => {
  for (const fact of [
    "0.0048 NEAR",
    "0.0036 NEAR",
    "0.0005 NEAR",
    "about 200 payments at 1 NEAR",
    "about 100 at 0.5 NEAR",
    "`LackBalanceForState`",
    "not with a `PROBARION:` code",
    "no NEAR-withdraw method",
    "cannot be changed after",
    "OWNER decision before Day 7",
    "the recommendation is 0.5 NEAR",
  ]) {
    assert.ok(factory.includes(fact), `factory.md lacks: ${fact}`);
  }
  // The mainnet init keeps 1 NEAR and says why, in the block itself.
  assert.ok(factoryBlocks.includes("# OWNER decides; see the runway note"));
  assertOrder(
    factoryBlocks,
    "# OWNER decides; see the runway note",
    '\\"min_deposit\\":\\"1000000000000000000000000\\"',
  );
  const note = factory.indexOf("Runway note");
  assert.ok(note > 0 && note < factory.indexOf("# OWNER decides"), "the runway note comes first");
});

test("the factory keeps liquid NEAR for a refund, and checks it before creating vaults", () => {
  assert.match(factory, /Liquidity rule/);
  assert.ok(factory.includes("largest deposit"));
  assert.ok(factory.includes("for example 5 NEAR"));
  assert.ok(factory.includes("above its storage stake"));
  assert.ok(factory.includes("create_vault` checks the vault's init bounds itself"));
  assert.ok(factoryBlocks.includes(`MIN_FLOAT_NEAR="\${MIN_FLOAT_NEAR:-5}"`));
  assert.ok(factoryBlocks.includes("BigInt(a.storage_usage)*10n**19n"));
  assert.ok(factoryBlocks.includes("OK: the factory can refund the largest deposit"));
  assert.ok(factoryBlocks.includes("STOP: top the factory up before creating vaults"));
  assertOrder(factoryBlocks, "STOP: top the factory up", '\\"name\\":\\"team-smoke\\"');
});

test("the global code is published once, and that is checked read-only first", () => {
  assert.match(factory, /Publish once/);
  assert.ok(
    factoryBlocks.includes(
      'GLOBAL_STATE="$(RPC=https://rpc.mainnet.fastnear.com node scripts/testnet/chain.mjs global-code "$VAULT_HASH")"',
    ),
  );
  assert.ok(
    factoryBlocks.includes('"not published") echo "OK: not published yet, publish once" ;;'),
  );
  assert.ok(factoryBlocks.includes('published) echo "STOP: already published'));
  assert.ok(factoryBlocks.includes('*) echo "STOP: could not tell, do not publish" ;;'));
  assert.match(factory, /view_global_contract_code/);
  // The guard runs before either publish command.
  assertOrder(factoryBlocks, 'global-code "$VAULT_HASH"', " publish_global json-args");
  assertOrder(factoryBlocks, 'global-code "$VAULT_HASH"', "deploy-as-global use-file");
  // Option B skips by itself (near-cli-rs 0.30.1 help); the rehearsal covers B, the sandbox covers A.
  assert.match(factory, /immutable, skips if already deployed/);
  assert.match(factory, /testnet section 1 rehearses Option B/i);
  assert.ok(
    factory.includes("publish_global_lets_the_factory_create_vaults_from_the_global_code"),
    "no pointer to the sandbox test that proves Option A",
  );
  // After the publish, the same read-only check confirms it.
  assert.match(factory, /prints `published`/);
});

test("the optional factory lock deletes one key that a guard has checked", () => {
  const lock = factoryBlocks.slice(factoryBlocks.indexOf("FULL_ACCESS_KEY="));
  assert.ok(factoryBlocks.includes("FULL_ACCESS_KEY="), "no guard before the lock");
  assert.ok(
    factoryBlocks.includes(
      'FULL_ACCESS_KEY="$(RPC=https://rpc.mainnet.fastnear.com node scripts/testnet/chain.mjs full-access-keys "$FACTORY")"',
    ),
  );
  assert.ok(factoryBlocks.includes('""|*,*) echo "STOP: expected exactly one full-access key" ;;'));
  assert.ok(factoryBlocks.includes('ed25519:*) echo "OK: one full-access key" ;;'));
  assertOrder(factoryBlocks, 'ed25519:*) echo "OK: one full-access key"', 'delete-keys "$FACTORY"');
  assert.ok(lock.includes('delete-keys "$FACTORY" public-keys "$FULL_ACCESS_KEY"'));
  assert.ok(!factoryBlocks.includes("head -n1"), "the lock still deletes the first key it finds");
  assert.ok(!/delete-keys[^\n]*list-keys/.test(factoryBlocks));
});

test("the signing story matches mainnet-v0.md: keychain or Ledger, keys written only there", () => {
  assert.ok(factory.includes("sign-with-ledger"));
  // near-cli-rs 0.30.1 rejects `sign-with-ledger send`; the Ledger transport word `usb` is required.
  assert.ok(factory.includes("`sign-with-keychain send` with `sign-with-ledger usb send`"));
  assert.ok(!factory.includes("Keys are kept only in the OS keychain"));
  assert.match(factory, /written only to the OS keychain/);
  const mainnet = read("docs/runbooks/mainnet-v0.md");
  assert.ok(!mainnet.includes("No command here prints or stores a private key"));
  assert.match(mainnet, /Keys are written only to the keychain.*git-ignored `\.keys\/` folder/);
  assert.ok(
    mainnet.includes("no command prints one") || mainnet.includes("no command here prints one"),
  );
});

test("factory names are first come, first served, and the demo name is a choice", () => {
  assert.match(factory, /first come, first served/);
  assert.ok(factory.includes("probarion-demo"));
  assert.ok(factory.includes("`demo` or `canary`"));
  assert.match(factory, /OWNER may reserve `demo` right after the global switch/);
  // The command keeps the hard-coded name, with a comment in the same block.
  const demo = factoryBlocks.indexOf('\\"name\\":\\"demo\\"');
  assert.ok(demo > 0, "the demo command lost its name");
  const comment = factoryBlocks.lastIndexOf("# ", demo);
  assert.ok(comment > 0 && demo - comment < 400, "no comment above the demo command");
  assert.ok(
    /first come, first served[^\n]*probarion-demo/.test(factoryBlocks.slice(comment, demo)),
  );
});

test("AGENTS.md and testnet.md fit this machine: no jq, and a release binary for near-cli-rs", () => {
  const agents = read("AGENTS.md");
  assert.ok(!/\bjq\b/.test(agents), "AGENTS.md still uses jq");
  assert.ok(
    agents.includes(
      "RPC=https://rpc.mainnet.fastnear.com node scripts/testnet/chain.mjs code-hash v0.probarion.near",
    ),
  );
  const testnet = read("docs/runbooks/testnet.md");
  assert.ok(testnet.includes("https://github.com/near/near-cli-rs/releases"));
  assert.ok(testnet.includes("v0.30.1"));
  assert.match(testnet, /sha256/);
  assert.match(testnet, /openssl-sys/);
  assert.match(testnet, /Linux and macOS/);
  // The release binary comes first; `cargo install` is the fallback on the platforms where it works.
  assert.ok(
    testnet.indexOf("releases") <
      testnet.indexOf("cargo install near-cli-rs --version 0.30.1 --locked"),
  );
});
