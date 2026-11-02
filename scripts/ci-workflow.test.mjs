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

// ---------- release.yml (the npm release, plan 03 Task 17) ----------

const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const releaseLines = release.split("\n");

/** The text of one top-level job: from `  name:` to the next job (two-space key) or the end. */
function job(text, name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `no job ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The workflow without comments, so a sentence about a permission is not counted as one. */
const releaseCode = releaseLines
  .filter((line) => !/^\s*#/.test(line))
  .map((line) => line.replace(/\s+#.*$/, ""))
  .join("\n");

const shaOf = (line) => /@([0-9a-f]{40})/.exec(line)?.[1];
const actionOf = (line) => /uses: ([\w.-]+\/[\w.-]+)@/.exec(line)?.[1];

test("release.yml pins every action by full commit SHA with its tag, at the SHAs ci.yml uses", () => {
  const uses = releaseLines.filter((line) => /^\s*-?\s*uses:/.test(line));
  assert.ok(uses.length >= 5, `only ${uses.length} uses: lines`);
  for (const line of uses) {
    assert.match(line, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # \S+/, `not pinned: ${line.trim()}`);
  }
  const ciShas = new Map(
    lines.filter((l) => /^\s*-?\s*uses:/.test(l)).map((l) => [actionOf(l), shaOf(l)]),
  );
  for (const line of uses) {
    const action = actionOf(line);
    if (ciShas.has(action)) {
      assert.equal(shaOf(line), ciShas.get(action), `${action} is at another SHA than in ci.yml`);
    }
  }
  // Every action is used at one SHA only.
  for (const action of new Set(uses.map(actionOf))) {
    const shas = new Set(uses.filter((l) => actionOf(l) === action).map(shaOf));
    assert.equal(shas.size, 1, `${action} is used at more than one SHA`);
  }
});

test("release.yml runs only for sdk-v* tags", () => {
  assert.match(release, /\non:\n {2}push:\n {4}tags: \["sdk-v\*"\]\n/);
  assert.ok(!/branches:|pull_request|workflow_dispatch|schedule:/.test(release));
});

test("release.yml has read-only permissions, and only the publish job can mint an OIDC token", () => {
  assert.match(releaseCode, /\npermissions:\n {2}contents: read\n/);
  assert.ok(!/contents: write|packages: write|write-all/.test(releaseCode));
  const verify = job(releaseCode, "verify");
  const publish = job(releaseCode, "publish");
  assert.ok(!verify.includes("id-token"), "the verify job must not get id-token");
  assert.equal(releaseCode.split("id-token: write").length - 1, 1);
  assert.ok(publish.includes("id-token: write"));
  assert.match(publish, /needs: verify\n/);
});

test("release.yml keeps the npm token and the OIDC token away from repository code", () => {
  const verify = job(releaseCode, "verify");
  const publish = job(releaseCode, "publish");
  assert.ok(!verify.includes("NPM_TOKEN") && !verify.includes("NODE_AUTH_TOKEN"));
  assert.equal(releaseCode.split("secrets.NPM_TOKEN").length - 1, 1);
  assert.ok(publish.includes("secrets.NPM_TOKEN"));
  // The publish job publishes the tarballs the verify job made: it checks out nothing and builds nothing.
  assert.ok(!/actions\/checkout|pnpm install|pnpm run|pnpm exec|pnpm\/action-setup/.test(publish));
  assert.ok(publish.includes("actions/download-artifact@"));
});

test("release.yml checks the tag, runs the TypeScript verification and packs before anything is published", () => {
  const verify = job(release, "verify");
  const at = (needle) => {
    const index = verify.indexOf(needle);
    assert.ok(index >= 0, `the verify job lacks ${needle}`);
    return index;
  };
  const order = [
    at("pnpm install --frozen-lockfile"),
    at('pnpm run release:check -- "$GITHUB_REF_NAME"'),
    at("pnpm run verify:ts"),
    at("pnpm run verify:launch"),
    at('pnpm run release:check -- --pack --out "$RUNNER_TEMP/release" "$GITHUB_REF_NAME"'),
    at("actions/upload-artifact@"),
  ];
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.match(
    verify,
    /uses: pnpm\/action-setup@[0-9a-f]{40} # \S+\n {8}with:\n {10}version: 10\n/,
  );
});

test("release.yml reads the tag from the environment, not from an expression in a script", () => {
  assert.ok(!/github\.ref_name|github\.head_ref/.test(release));
  const runBlocks = releaseCode.split(/\n\s*(?:- )?run: \|?/).slice(1);
  assert.ok(runBlocks.length >= 5);
  for (const block of runBlocks) {
    const body = block.split(/\n\s*(?:- |env:|with:)/)[0];
    assert.ok(!body.includes("${{"), `an expression in a run block: ${body.slice(0, 80)}`);
  }
});

test("release.yml publishes with provenance, falls back only for a private repository, and skips what is on npm", () => {
  const publish = job(release, "publish");
  assert.match(publish, /base_args=\(--access public --provenance\)/);
  assert.match(publish, /if \[ "\$REPO_PRIVATE" = "true" \]/);
  assert.match(publish, /npm view "\$name@\$version" version/);
  assert.match(publish, /npm publish "\$RELEASE_DIR\/\$file"/);
  assert.match(publish, /--tag next/);
});
