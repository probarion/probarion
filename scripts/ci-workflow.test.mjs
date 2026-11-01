import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const lines = ci.split("\n");

test("every third-party action is pinned by full commit SHA, with its tag in a trailing comment", () => {
  const uses = lines.filter((line) => /^\s*-?\s*uses:/.test(line));
  assert.ok(uses.length >= 10, `only ${uses.length} uses: lines`);
  for (const line of uses) {
    assert.match(line, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # \S+/, `not pinned: ${line.trim()}`);
  }
  // The actions the brief names are all present, at one SHA each.
  for (const action of [
    "actions/checkout",
    "actions/setup-node",
    "actions/upload-artifact",
    "pnpm/action-setup",
    "Swatinem/rust-cache",
    "dtolnay/rust-toolchain",
  ]) {
    const shas = new Set(
      uses.filter((l) => l.includes(`uses: ${action}@`)).map((l) => /@([0-9a-f]{40})/.exec(l)[1]),
    );
    assert.equal(shas.size, 1, `${action} must be used at exactly one pinned SHA`);
  }
});

test("the gitleaks image is pinned by digest", () => {
  assert.match(ci, /zricethezav\/gitleaks:v8\.21\.2@sha256:[0-9a-f]{64} detect/);
});

test("cargo-near is installed from its release archive and checked against a pinned sha256", () => {
  // cargo-near-v0.22.0 cargo-near-x86_64-unknown-linux-gnu.tar.gz: the release's own .sha256 file,
  // sha256.sum, dist-manifest.json and the GitHub API digest all say this.
  const sha = "9429064e30a427e96523f539cb255f3688d2345e5000d7d4e4873a8247247d1a";
  assert.ok(ci.includes(`CARGO_NEAR_SHA256: ${sha}`), "the sha256 is not pinned in the workflow");
  assert.ok(!/cargo-near-installer\.sh/.test(ci), "the installer script is still used");
  assert.ok(!/\|\s*(sh|bash)\b/.test(ci), "something is piped into a shell");
  const installs = lines.filter((l) => l.includes("Install cargo-near 0.22.0"));
  assert.equal(installs.length, 2, "the sandbox and reproducible jobs both install cargo-near");
  assert.equal(
    ci.split("cargo-near-v0.22.0/cargo-near-x86_64-unknown-linux-gnu.tar.gz").length - 1,
    2,
  );
  assert.equal(
    ci.split('echo "$CARGO_NEAR_SHA256  $archive" | sha256sum --check --strict -').length - 1,
    2,
  );
  assert.equal(ci.split("set -euo pipefail").length - 1, 2);
  // The check comes before the extract and the install, in each step.
  const check = ci.indexOf("sha256sum --check");
  assert.ok(
    check > 0 && check < ci.indexOf("tar -xzf"),
    "the archive is unpacked before it is checked",
  );
  assert.ok(
    ci.includes(
      'install -m 0755 "$RUNNER_TEMP/cargo-near/cargo-near" "$HOME/.cargo/bin/cargo-near"',
    ),
  );
});

test("the toolchain stays 1.99.1", () => {
  assert.equal(ci.split("toolchain: 1.99.1").length - 1, 3);
  assert.ok(!/toolchain: (?!1\.99\.1)/.test(ci));
});
