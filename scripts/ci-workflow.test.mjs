import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
//
// The workflow is checked as text: `checkReleaseWorkflow` returns every way in which a workflow differs
// from the shape the release depends on, and the tests run it on the real file (no problems) and on
// in-memory mutated copies (each must be refused). Nothing here publishes, tags or pushes.

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions are text here, not templates
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

const NPM_PUBLISH_LINE = 'npm publish "$RELEASE_DIR/$file" "${args[@]}" </dev/null';
const REPO_PRIVATE_LINE = "REPO_PRIVATE: ${{ github.event.repository.private }}";
const NPM_TOKEN_LINE = "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}";

/** A workflow as lines without comments or blank lines (a trailing ` # tag` comment is cut off too). */
function codeLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line) && line.trim() !== "")
    .map((line) => line.replace(/\s+#.*$/, ""));
}

/** The lines of a block: the key line at `indent`, and what follows with a deeper indent. */
function blockLines(lines, key, indent = 0) {
  const pad = " ".repeat(indent);
  const start = lines.indexOf(`${pad}${key}:`);
  if (start < 0) return null;
  const out = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line.length - line.trimStart().length <= indent) break;
    out.push(line);
  }
  return out;
}

const usesAction = (line) => /uses: ([\w.-]+\/[\w.-]+)@/.exec(line)?.[1];
const usesSha = (line) => /@([0-9a-f]{40})/.exec(line)?.[1];

// The whole file is pinned. A reviewed change to release.yml needs a reviewed change to this hash, which
// is the point: the structural checks below explain what is wrong, the pin refuses everything else.
// Update it with: node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(".github/workflows/release.yml","utf8").replace(/\r\n/g,"\n")).digest("hex"))'
const RELEASE_YML_SHA256 = "f58673e15ed0df05372b03a105ca30fcf24ec8f3f09e200fa120263ca4d73e45";
const releaseSha = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

// The publish script and the run steps of the verify job, exactly as reviewed (comments and blank lines
// removed). The script is the body of the one `run: |` of the publish job, without its indentation.
const PUBLISH_SCRIPT = [
  "set -euo pipefail",
  "base_args=(--access public --provenance)",
  'if [ "$REPO_PRIVATE" = "true" ]; then',
  '  echo "::warning::the repository is private; npm provenance needs a public repository, so this publish has no provenance"',
  "  base_args=(--access public)",
  "fi",
  'list=$(node -e \'for (const p of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).packages) console.log([p.file, p.name, p.version].join("\\t"))\' "$RELEASE_DIR/packages.json")',
  '[ -n "$list" ] || { echo "::error::empty publish list"; exit 1; }',
  "while IFS=$'\\t' read -r file name version; do",
  '  if view=$(npm view "$name@$version" version 2>&1 </dev/null); then',
  '    published=$(npm view "$name@$version" dist.integrity </dev/null)',
  '    local_integrity="sha512-$(openssl dgst -sha512 -binary "$RELEASE_DIR/$file" | base64 -w0)"',
  '    if [ "$published" = "$local_integrity" ]; then',
  '      echo "::notice::$name@$version is already on npm with the same content as this tarball; skipping"',
  "      continue",
  "    fi",
  '    echo "::error::$name@$version is already on npm with different content (npm: $published, this run: $local_integrity); nothing after it is published"',
  "    exit 1",
  "  else",
  '    case "$view" in',
  "      *E404*) ;;",
  '      *) echo "::error::cannot tell whether $name@$version is on npm: $view"; exit 1 ;;',
  "    esac",
  "  fi",
  '  args=("${base_args[@]}")',
  '  case "$version" in *-*) args+=(--tag next) ;; esac',
  '  echo "publishing $name@$version"',
  '  npm publish "$RELEASE_DIR/$file" "${args[@]}" </dev/null',
  'done <<<"$list"',
];

const VERIFY_RUN_STEPS = [
  [
    "      - name: Require the tagged commit to be on main",
    "        run: |",
    '          git merge-base --is-ancestor "$GITHUB_SHA" origin/main || {',
    '            echo "::error::the tagged commit $GITHUB_SHA is not on main; a release is cut from main"',
    "            exit 1",
    "          }",
  ],
  ["      - run: pnpm install --frozen-lockfile"],
  ['      - run: pnpm run release:check -- "$GITHUB_REF_NAME"'],
  ["      - run: pnpm run verify:ts"],
  ["      - run: pnpm run verify:launch"],
  ['      - run: pnpm run release:check -- --pack --out "$RUNNER_TEMP/release" "$GITHUB_REF_NAME"'],
];

const PUBLISH_ENV_LINES = [
  "        env:",
  "          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
  "          REPO_PRIVATE: ${{ github.event.repository.private }}",
  "          RELEASE_DIR: ${{ runner.temp }}/release",
];
// The only lines that may hold a ${{ }} expression.
const EXPRESSION_LINES = [
  "          path: ${{ runner.temp }}/release",
  ...PUBLISH_ENV_LINES.slice(1),
];

/** The steps of a job as arrays of lines (a step starts at `      - `). */
function stepsOf(jobLines) {
  const at = jobLines.indexOf("    steps:");
  const steps = [];
  if (at < 0) return steps;
  for (const line of jobLines.slice(at + 1)) {
    if (/^ {6}- /.test(line)) steps.push([line]);
    else steps.at(-1)?.push(line);
  }
  return steps;
}

/** Every problem with a release workflow; the empty list means it has the shape the release relies on. */
function checkReleaseWorkflow(text, ciText) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const lines = codeLines(text);
  const ciLines = ciText.split(/\r?\n/);

  // --- the file as a whole
  if (!/^name: release\n/.test(text))
    fail('the workflow must be named "release" (prepublishOnly checks it)');
  if (!blockLines(lines, "jobs")) fail("no jobs");
  if (/toJSON\(secrets\)/.test(text)) fail("toJSON(secrets) hands every secret to a step");
  if (/\bnpx\b|\bpnpm publish\b|\byarn publish\b|\bnpm install\b|\bpnpm dlx\b/.test(text)) {
    fail("npx, pnpm publish, yarn publish, npm install and pnpm dlx are not allowed");
  }
  if (/provenance=false|--no-provenance|provenance: false/.test(text)) {
    fail("provenance must not be switched off by a flag");
  }
  if ((text.match(/\bsecrets\b/g) ?? []).length !== 1 || text.split(NPM_TOKEN_LINE).length !== 2) {
    fail("the word secrets must occur once, as NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
  }
  if (/github\.ref_name|github\.head_ref|github\.event\.(?!repository\.private)/.test(text)) {
    fail("an attacker-controllable expression is used (take the tag from $GITHUB_REF_NAME)");
  }

  // --- triggers and permissions
  const on = blockLines(lines, "on");
  if (JSON.stringify(on) !== JSON.stringify(["on:", "  push:", '    tags: ["sdk-v*"]'])) {
    fail('the on block must be exactly push on tags ["sdk-v*"]');
  }
  const top = blockLines(lines, "permissions");
  if (JSON.stringify(top) !== JSON.stringify(["permissions:", "  contents: read"])) {
    fail("the top-level permissions must be exactly contents: read");
  }

  // --- jobs
  const jobsBlock = blockLines(lines, "jobs") ?? [];
  const jobNames = jobsBlock
    .filter((l) => /^ {2}[\w-]+:$/.test(l))
    .map((l) => l.trim().slice(0, -1));
  if (JSON.stringify(jobNames) !== JSON.stringify(["verify", "publish"])) {
    fail("the jobs must be exactly verify and publish");
  }
  const verify = blockLines(jobsBlock, "verify", 2) ?? [];
  const publish = blockLines(jobsBlock, "publish", 2) ?? [];
  if (verify.some((l) => l === "    permissions:"))
    fail("the verify job must have no permissions block");
  if (verify.some((l) => /id-token|environment:|NPM_TOKEN|NODE_AUTH_TOKEN/.test(l))) {
    fail("the verify job must not touch id-token, the environment or the npm token");
  }
  const publishPerms = blockLines(publish, "permissions", 4);
  if (
    JSON.stringify(publishPerms) !==
    JSON.stringify(["    permissions:", "      contents: read", "      id-token: write"])
  ) {
    fail("the publish permissions must be exactly contents: read and id-token: write");
  }
  if (lines.filter((line) => line.includes("id-token: write")).length !== 1) {
    fail("id-token: write must occur once");
  }
  if (!publish.includes("    needs: verify")) fail("the publish job must need verify");
  if (!publish.includes("    environment: npm-release")) {
    fail("the publish job must run in the npm-release environment");
  }
  // The publish job publishes what the verify job made: two actions, one script, no checkout, no pnpm.
  const publishUses = publish.filter((l) => /\buses:/.test(l)).map(usesAction);
  if (
    JSON.stringify(publishUses) !==
    JSON.stringify(["actions/download-artifact", "actions/setup-node"])
  ) {
    fail("the publish job must use exactly download-artifact and setup-node");
  }
  if (publish.filter((l) => /^ {6,8}(- )?run:/.test(l)).length !== 1) {
    fail("the publish job must have exactly one run step");
  }
  if (/pnpm|checkout/.test(publish.join("\n")))
    fail("the publish job must not check out or use pnpm");
  if (publish.filter((l) => l.trim() === NPM_TOKEN_LINE).length !== 1) {
    fail("the npm token must reach the publish step as NODE_AUTH_TOKEN");
  }
  if (publish.filter((l) => l.trim() === REPO_PRIVATE_LINE).length !== 1) {
    fail(`the publish step needs exactly ${REPO_PRIVATE_LINE}`);
  }
  const publishLines = publish.filter((l) => /\bnpm publish\b/.test(l)).map((l) => l.trim());
  if (publishLines.length !== 1 || publishLines[0] !== NPM_PUBLISH_LINE) {
    fail(`the only npm publish line must be exactly: ${NPM_PUBLISH_LINE}`);
  }
  const script = publish.join("\n");
  for (const needle of [
    "base_args=(--access public --provenance)",
    'if [ "$REPO_PRIVATE" = "true" ]; then',
    "list=$(node -e ",
    '[ -n "$list" ] || { echo "::error::empty publish list"; exit 1; }',
    'done <<<"$list"',
    'if view=$(npm view "$name@$version" version 2>&1 </dev/null); then',
    "*E404*) ;;",
    '*) echo "::error::cannot tell whether $name@$version is on npm: $view"; exit 1 ;;',
    'case "$version" in *-*) args+=(--tag next) ;; esac',
  ]) {
    if (!script.includes(needle)) fail(`the publish script lacks: ${needle}`);
  }
  // An existing version is skipped only when npm holds these very bytes; a different one stops the run.
  const at = (needle) => script.indexOf(needle);
  const integrity = [
    at('published=$(npm view "$name@$version" dist.integrity </dev/null)'),
    at(
      'local_integrity="sha512-$(openssl dgst -sha512 -binary "$RELEASE_DIR/$file" | base64 -w0)"',
    ),
    at('if [ "$published" = "$local_integrity" ]; then'),
    at("::notice::"),
    at("continue"),
    at("::error::$name@$version is already on npm with different content"),
    at('nothing after it is published"\n              exit 1\n            else'),
    at("*E404*) ;;"),
    at("cannot tell whether"),
    at(NPM_PUBLISH_LINE),
  ];
  if (integrity.includes(-1) || integrity.some((n, i) => i > 0 && n < integrity[i - 1])) {
    fail(
      "an existing version must be compared by dist.integrity: same bytes skip, different bytes stop",
    );
  }

  // --- the verify job
  const checkoutAt = verify.findIndex((l) => /uses: actions\/checkout@/.test(l));
  const checkout = checkoutAt < 0 ? "" : verify.slice(checkoutAt, checkoutAt + 4).join("\n");
  if (checkoutAt < 0) fail("the verify job needs a checkout");
  if (!/with:\n\s+fetch-depth: 0\n\s+persist-credentials: false/.test(checkout)) {
    fail("the checkout needs fetch-depth: 0 and persist-credentials: false");
  }
  if (/\bcache:/.test(text)) fail("no dependency cache in the release workflow");
  const verifyText = verify.join("\n");
  const order = [
    "uses: actions/checkout@",
    'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
    "pnpm install --frozen-lockfile",
    'pnpm run release:check -- "$GITHUB_REF_NAME"',
    "pnpm run verify:ts",
    "pnpm run verify:launch",
    'pnpm run release:check -- --pack --out "$RUNNER_TEMP/release" "$GITHUB_REF_NAME"',
    "uses: actions/upload-artifact@",
  ].map((needle) => verifyText.indexOf(needle));
  if (order.includes(-1) || order.some((n, i) => i > 0 && n < order[i - 1])) {
    fail(
      "the verify job must check out, require main, install, check the tag, verify, pack, then upload",
    );
  }
  if (!/uses: pnpm\/action-setup@[0-9a-f]{40}\n\s+with:\n\s+version: 10(\n|$)/.test(verifyText)) {
    fail("pnpm/action-setup needs with: version: 10");
  }

  // --- pins: every action by full SHA, at the SHA ci.yml uses
  const uses = text.split(/\r?\n/).filter((l) => /^\s*-?\s*uses:/.test(l));
  if (uses.length < 6) fail(`only ${uses.length} uses: lines`);
  const ciShas = new Map(
    ciLines.filter((l) => /^\s*-?\s*uses:/.test(l)).map((l) => [usesAction(l), usesSha(l)]),
  );
  const seen = new Map();
  for (const line of uses) {
    if (!/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # \S+/.test(line))
      fail(`not pinned by SHA: ${line.trim()}`);
    const action = usesAction(line);
    if (ciShas.has(action) && ciShas.get(action) !== usesSha(line)) {
      fail(`${action} is at another SHA than in ci.yml`);
    }
    if (seen.has(action) && seen.get(action) !== usesSha(line))
      fail(`${action} is used at two SHAs`);
    seen.set(action, usesSha(line));
  }
  // --- only the reviewed lines may hold an expression, wherever they stand
  for (const l of lines) {
    if (l.includes("${{") && !EXPRESSION_LINES.includes(l)) {
      fail(`an expression outside the reviewed lines: ${l.trim().slice(0, 80)}`);
    }
  }

  // --- nothing may swallow a failure or switch a gate off
  const code = lines.join("\n");
  if (/continue-on-error/.test(code)) {
    fail("continue-on-error is not allowed: a failed step must fail the run");
  }
  // Also inside a flow mapping ({ if: false, run: … }) and with a quoted key.
  const keyOf = (l) => l.replace(/^\s*(-\s+)?/, "");
  if (lines.some((l) => /(^|[{,]\s*)["']?if["']?\s*:/.test(keyOf(l)))) {
    fail("an if: key is not allowed: every step and job runs, and a failure stops the run");
  }
  // Every script runs under `bash -eo pipefail`, which GitHub applies only when the shell is named.
  const defaults = blockLines(lines, "defaults");
  if (JSON.stringify(defaults) !== JSON.stringify(["defaults:", "  run:", "    shell: bash"])) {
    fail("defaults must be exactly run: shell: bash, so that every script runs with pipefail");
  }
  if ((code.match(/\bshell\s*:/g) ?? []).length !== 1) {
    fail("shell: may appear once, in defaults (no step may choose another shell)");
  }
  if (/set \+/.test(code)) fail("set +e, set +o pipefail and every other set + are not allowed");
  if (/\bpipefail\b/.test(code.replace("set -euo pipefail", ""))) {
    fail("pipefail may be mentioned only in set -euo pipefail");
  }
  if (/\bexit 0\b/.test(code)) fail("exit 0 is not allowed");
  if (lines.some((l) => /;\s*true\s*$/.test(l))) {
    fail('a line that ends in "; true" swallows a failure');
  }
  // The only places where a command may fail into something else are these two guards, and both exit 1.
  const exitGuards = [
    'git merge-base --is-ancestor "$GITHUB_SHA" origin/main || {',
    '[ -n "$list" ] || { echo "::error::empty publish list"; exit 1; }',
  ];
  for (const l of lines) {
    if (l.includes("||") && !exitGuards.includes(l.trim())) {
      fail(`|| outside the two exit-1 guards swallows a failure: ${l.trim().slice(0, 80)}`);
    }
  }
  const mainCheck = [
    "      - name: Require the tagged commit to be on main",
    "        run: |",
    '          git merge-base --is-ancestor "$GITHUB_SHA" origin/main || {',
    '            echo "::error::the tagged commit $GITHUB_SHA is not on main; a release is cut from main"',
    "            exit 1",
    "          }",
  ].join("\n");
  if (!verify.join("\n").includes(mainCheck)) {
    fail("the main check must be verbatim (a failing check must exit 1)");
  }
  const runAt = publish.findIndex((l) => /^ {8}run: \|$/.test(l));
  if (runAt < 0 || publish[runAt + 1] !== "          set -euo pipefail") {
    fail("the publish script must start with set -euo pipefail");
  }
  // The token goes to the registry named here, so it is pinned: exactly one, in the publish job.
  const registries = lines.filter((l) => /registry-url:/.test(l));
  if (
    registries.length !== 1 ||
    registries[0] !== "          registry-url: https://registry.npmjs.org" ||
    !publish.includes(registries[0])
  ) {
    fail("registry-url must be exactly https://registry.npmjs.org, once, in the publish job");
  }
  if (!verify.includes("          if-no-files-found: error")) {
    fail("the upload step needs if-no-files-found: error");
  }
  if (
    !verify.includes("          name: release-tarballs") ||
    !publish.includes("          name: release-tarballs")
  ) {
    fail("the artifact must be named release-tarballs in both jobs");
  }

  // --- exact run bodies (a blacklist always misses a way to swallow a failure; these list what is allowed)
  const verifyRunSteps = stepsOf(verify).filter((step) =>
    step.some((l) => /(^|[\s{,-])run\s*:/.test(l)),
  );
  if (JSON.stringify(verifyRunSteps) !== JSON.stringify(VERIFY_RUN_STEPS)) {
    fail("the verify job's run steps must be exactly the reviewed ones, each with no other key");
  }
  const publishRunAt = publish.findIndex((l) => /^ {8}run: \|$/.test(l));
  const publishBody =
    publishRunAt < 0 ? [] : publish.slice(publishRunAt + 1).map((l) => l.slice(10));
  if (JSON.stringify(publishBody) !== JSON.stringify(PUBLISH_SCRIPT)) {
    fail("the publish script must equal the reviewed copy, line for line");
  }
  const publishEnv = blockLines(publish, "env", 8);
  if (JSON.stringify(publishEnv) !== JSON.stringify(PUBLISH_ENV_LINES)) {
    fail("the publish env block must be exactly NODE_AUTH_TOKEN, REPO_PRIVATE and RELEASE_DIR");
  }
  if (/\bNPM_CONFIG_|\bnpm_config_/i.test(text)) {
    fail("npm configuration through the environment is not allowed (registry, dry-run, …)");
  }
  if (/--registry|--dry-run|--userconfig|--otp/.test(text)) {
    fail("--registry, --dry-run, --userconfig and --otp are not allowed on any command");
  }
  return problems;
}

test("release.yml has exactly the shape the release relies on", () => {
  assert.deepEqual(checkReleaseWorkflow(release, ci), []);
});

// Each mutation is a change a careless edit, or an attacker with a pull request, could make. The checker
// must refuse every one of them, and for the stated reason.
const mutations = [
  // The six the reviewer named
  [
    "an added trigger",
    (t) => t.replace('tags: ["sdk-v*"]', 'tags: ["sdk-v*"]\n  workflow_dispatch:'),
    "the on block",
  ],
  [
    "an added release trigger",
    (t) => t.replace('tags: ["sdk-v*"]', 'tags: ["sdk-v*"]\n  release:\n    types: [created]'),
    "the on block",
  ],
  [
    "an extra write permission on the publish job",
    (t) =>
      t.replace(
        "      id-token: write # npm",
        "      packages: write\n      id-token: write # npm",
      ),
    "the publish permissions",
  ],
  [
    "an extra npx step in the publish job",
    (t) =>
      t.replace(
        "      - name: Publish core",
        "      - run: npx some-tool\n      - name: Publish core",
      ),
    "npx",
  ],
  [
    "an extra run step in the publish job",
    (t) =>
      t.replace(
        "      - name: Publish core",
        "      - run: echo hello\n      - name: Publish core",
      ),
    "exactly one run step",
  ],
  [
    "toJSON(secrets)",
    (t) =>
      t.replace(
        "          RELEASE_DIR:",
        "          ALL: ${{ toJSON(secrets) }}\n          RELEASE_DIR:",
      ),
    "toJSON(secrets)",
  ],
  [
    "a hard-coded REPO_PRIVATE",
    (t) => t.replace(REPO_PRIVATE_LINE, 'REPO_PRIVATE: "false"'),
    "REPO_PRIVATE",
  ],
  [
    "--provenance=false",
    (t) =>
      t.replace(
        "base_args=(--access public --provenance)",
        "base_args=(--access public --provenance=false)",
      ),
    "provenance",
  ],
  [
    "--no-provenance on the publish line",
    (t) => t.replace('"${args[@]}" </dev/null', '"${args[@]}" --no-provenance </dev/null'),
    "provenance",
  ],
  // Permissions and secrets
  [
    "a top-level id-token",
    (t) =>
      t.replace(
        "permissions:\n  contents: read\n\n",
        "permissions:\n  contents: read\n  id-token: write\n\n",
      ),
    "top-level permissions",
  ],
  [
    "a permissions block on the verify job",
    (t) =>
      t.replace(
        "    name: Check, test and pack\n",
        "    name: Check, test and pack\n    permissions:\n      contents: read\n",
      ),
    "verify job must have no permissions",
  ],
  [
    "the npm token in the verify job",
    (t) =>
      t.replace(
        "      - run: pnpm install --frozen-lockfile",
        "      - run: pnpm install --frozen-lockfile\n        env:\n          X: ${{ secrets.NPM_TOKEN }}",
      ),
    "secrets",
  ],
  [
    "a second use of secrets",
    (t) =>
      t.replace(
        "          RELEASE_DIR:",
        "          OTHER: ${{ secrets.OTHER }}\n          RELEASE_DIR:",
      ),
    "secrets",
  ],
  // Publish job content
  [
    "a checkout in the publish job",
    (t) =>
      t.replace(
        "      - uses: actions/download-artifact",
        "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n      - uses: actions/download-artifact",
      ),
    "exactly download-artifact and setup-node",
  ],
  [
    "no environment on the publish job",
    (t) => t.replace("    environment: npm-release\n", ""),
    "npm-release environment",
  ],
  [
    "another publish command",
    (t) =>
      t.replace(
        'npm publish "$RELEASE_DIR/$file" "${args[@]}" </dev/null',
        'npm publish "$RELEASE_DIR/$file" "${args[@]}"',
      ),
    "only npm publish line",
  ],
  [
    "a second npm publish line",
    (t) =>
      t.replace(
        '          done <<<"$list"',
        '          npm publish ./evil.tgz\n          done <<<"$list"',
      ),
    "only npm publish line",
  ],
  [
    "the integrity comparison removed",
    (t) => t.replace('if [ "$published" = "$local_integrity" ]; then', "if true; then"),
    "dist.integrity",
  ],
  [
    "a different version skipped without the error",
    (t) =>
      t.replace(
        'nothing after it is published"\n              exit 1\n            else',
        'nothing after it is published"\n              true\n            else',
      ),
    "dist.integrity",
  ],
  [
    "any failure of npm view taken for not published",
    (t) => t.replace("                *E404*) ;;\n", "                *) ;;\n"),
    "*E404*",
  ],
  [
    "the error branch for an unreadable registry answer replaced",
    (t) => t.replace('is on npm: $view"; exit 1 ;;', 'is on npm: $view"; echo "going on" ;;'),
    "cannot tell whether",
  ],
  [
    "the empty publish list not refused",
    (t) => t.replace('[ -n "$list" ] || { echo "::error::empty publish list"; exit 1; }', ""),
    "empty publish list",
  ],
  [
    "a process substitution loop that lets npm read the list",
    (t) => t.replace('done <<<"$list"', 'done < <(echo "$list")'),
    "done <<<",
  ],
  // Trigger, pins, order
  [
    "a branch trigger",
    (t) => t.replace('tags: ["sdk-v*"]', 'tags: ["sdk-v*"]\n    branches: [main]'),
    "the on block",
  ],
  [
    "an action SHA that differs from ci.yml",
    (t) => t.replace("actions/checkout@11d5960a", "actions/checkout@21d5960a"),
    "another SHA than in ci.yml",
  ],
  [
    "an action pinned by tag",
    (t) =>
      t.replace(
        "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2",
        "actions/upload-artifact@v4",
      ),
    "not pinned",
  ],
  [
    "the tag taken from an expression",
    (t) =>
      t.replace(
        'release:check -- "$GITHUB_REF_NAME"\n      - run: pnpm run verify:ts',
        "release:check -- ${{ github.ref_name }}\n      - run: pnpm run verify:ts",
      ),
    "attacker-controllable",
  ],
  [
    "no main ancestry check",
    (t) => t.replace('git merge-base --is-ancestor "$GITHUB_SHA" origin/main', "true"),
    "require main",
  ],
  ["a shallow checkout", (t) => t.replace("          fetch-depth: 0\n", ""), "fetch-depth: 0"],
  [
    "credentials left behind by the checkout",
    (t) => t.replace("          persist-credentials: false\n", ""),
    "persist-credentials: false",
  ],
  [
    "a dependency cache",
    (t) =>
      t.replace(
        "          node-version-file: .nvmrc\n",
        "          node-version-file: .nvmrc\n          cache: pnpm\n",
      ),
    "no dependency cache",
  ],
  [
    "pnpm version removed",
    (t) => t.replace("        with:\n          version: 10\n", ""),
    "version: 10",
  ],
  [
    "packing before the tests",
    (t) => t.replace("      - run: pnpm run verify:launch\n", ""),
    "check out, require main",
  ],
  [
    "a renamed workflow",
    (t) => t.replace(/^name: release/, "name: publish-all"),
    'named "release"',
  ],
  [
    "a publish job that does not wait for verify",
    (t) => t.replace("needs: verify\n", ""),
    "must need verify",
  ],
  // A gate that is still there but no longer stops the run (T17-R2)
  [
    "continue-on-error on the verify:ts step",
    (t) =>
      t.replace(
        "      - run: pnpm run verify:ts\n",
        "      - run: pnpm run verify:ts\n        continue-on-error: true\n",
      ),
    "continue-on-error",
  ],
  [
    "|| true after verify:ts",
    (t) => t.replace("pnpm run verify:ts\n", "pnpm run verify:ts || true\n"),
    "||",
  ],
  [
    "an if: false on the verify:launch step",
    (t) =>
      t.replace(
        "      - run: pnpm run verify:launch\n",
        "      - if: false\n        run: pnpm run verify:launch\n",
      ),
    "if:",
  ],
  [
    "if: always() on the publish job",
    (t) => t.replace("    needs: verify\n", "    needs: verify\n    if: always()\n"),
    "if:",
  ],
  [
    "the exit 1 of the main check replaced by true",
    (t) =>
      t.replace(
        'is not on main; a release is cut from main"\n            exit 1',
        'is not on main; a release is cut from main"\n            true',
      ),
    "main check must be verbatim",
  ],
  [
    "the publish registry pointed at another host",
    (t) =>
      t.replace(
        "registry-url: https://registry.npmjs.org",
        "registry-url: https://registry.example.com",
      ),
    "registry-url",
  ],
  [
    "a second registry-url",
    (t) =>
      t.replace(
        "      - run: pnpm install --frozen-lockfile\n",
        "      - run: pnpm install --frozen-lockfile\n      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n        with:\n          registry-url: https://registry.npmjs.org\n",
      ),
    "registry-url",
  ],
  [
    "|| true after the first release:check",
    (t) =>
      t.replace(
        'release:check -- "$GITHUB_REF_NAME"\n',
        'release:check -- "$GITHUB_REF_NAME" || true\n',
      ),
    "||",
  ],
  [
    "set -euo pipefail removed from the publish script",
    (t) => t.replace("          set -euo pipefail\n", ""),
    "set -euo pipefail",
  ],
  [
    "set -euo pipefail no longer the first line",
    (t) =>
      t.replace(
        "          set -euo pipefail\n",
        "          echo start\n          set -euo pipefail\n",
      ),
    "set -euo pipefail",
  ],
  [
    "|| true after the main check's closing brace",
    (t) =>
      t.replace(
        "          }\n      - uses: pnpm/action-setup",
        "          } || true\n      - uses: pnpm/action-setup",
      ),
    "||",
  ],
  [
    "if-no-files-found: warn on the upload",
    (t) => t.replace("if-no-files-found: error", "if-no-files-found: warn"),
    "if-no-files-found",
  ],
  [
    "|| : after a command",
    (t) => t.replace("pnpm run verify:launch\n", "pnpm run verify:launch || :\n"),
    "||",
  ],
  [
    "; true at the end of a run line",
    (t) => t.replace("pnpm run verify:ts\n", "pnpm run verify:ts; true\n"),
    "; true",
  ],
  [
    "exit 0 inside the main check",
    (t) =>
      t.replace(
        'is not on main; a release is cut from main"\n            exit 1',
        'is not on main; a release is cut from main"\n            exit 0',
      ),
    "exit 0",
  ],
  [
    "set +e in the publish script",
    (t) =>
      t.replace("          set -euo pipefail\n", "          set -euo pipefail\n          set +e\n"),
    "set +e",
  ],
  [
    "a shell override that drops -e",
    (t) =>
      t.replace(
        "        run: |\n          git merge-base",
        "        shell: bash {0}\n        run: |\n          git merge-base",
      ),
    "shell:",
  ],
  [
    "a different artifact name in the publish job",
    (t) =>
      t.replace(
        "      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0\n        with:\n          name: release-tarballs",
        "      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0\n        with:\n          name: other-artifact",
      ),
    "release-tarballs",
  ],
  // Ways to swallow a failure that a blacklist of words misses (T17-R3). They are refused because the run
  // steps, the publish script and the publish env are compared exactly with the reviewed copies.
  [
    "X1: a pipe into tee after verify:ts (no pipefail)",
    (t) =>
      t.replace(
        "      - run: pnpm run verify:ts\n",
        "      - run: pnpm run verify:ts | tee verify.log\n",
      ),
    "run steps must be exactly",
  ],
  [
    "X2: && echo ok after verify:launch",
    (t) =>
      t.replace(
        "      - run: pnpm run verify:launch\n",
        "      - run: pnpm run verify:launch && echo ok\n",
      ),
    "run steps must be exactly",
  ],
  [
    "X3: if ! … then … fi around verify:ts",
    (t) =>
      t.replace(
        "      - run: pnpm run verify:ts\n",
        "      - run: if ! pnpm run verify:ts; then echo skipped; fi\n",
      ),
    "run steps must be exactly",
  ],
  [
    "X4: a negated verify:ts",
    (t) => t.replace("      - run: pnpm run verify:ts\n", "      - run: ! pnpm run verify:ts\n"),
    "run steps must be exactly",
  ],
  [
    "X5: ; echo done after verify:ts",
    (t) =>
      t.replace(
        "      - run: pnpm run verify:ts\n",
        "      - run: pnpm run verify:ts; echo done\n",
      ),
    "run steps must be exactly",
  ],
  [
    "X6: if: inside a flow mapping",
    (t) =>
      t.replace(
        "      - run: pnpm run verify:launch\n",
        "      - { if: false, run: pnpm run verify:launch }\n",
      ),
    "an if: key",
  ],
  [
    "X6b: a quoted if key",
    (t) =>
      t.replace(
        "      - run: pnpm run verify:launch\n",
        '      - "if": false\n        run: pnpm run verify:launch\n',
      ),
    "an if: key",
  ],
  [
    "X6c: if with a space before the colon",
    (t) =>
      t.replace(
        "      - run: pnpm run verify:launch\n",
        "      - if : false\n        run: pnpm run verify:launch\n",
      ),
    "an if: key",
  ],
  [
    "X7: set +o pipefail in the publish script",
    (t) =>
      t.replace(
        "          set -euo pipefail\n",
        "          set -euo pipefail\n          set +o pipefail\n",
      ),
    "set +",
  ],
  [
    "X8: NPM_CONFIG_REGISTRY in the publish env",
    (t) =>
      t.replace(
        "          RELEASE_DIR:",
        "          NPM_CONFIG_REGISTRY: https://registry.example.com\n          RELEASE_DIR:",
      ),
    "npm configuration through the environment",
  ],
  [
    "X9: --registry added to the publish arguments",
    (t) =>
      t.replace(
        '            echo "publishing $name@$version"\n',
        '            args+=(--registry https://registry.example.com)\n            echo "publishing $name@$version"\n',
      ),
    "--registry",
  ],
  [
    "X9b: --dry-run in the base arguments",
    (t) =>
      t.replace(
        "base_args=(--access public --provenance)",
        "base_args=(--access public --provenance --dry-run)",
      ),
    "--dry-run",
  ],
  [
    "X12: a github.ref expression after a - line in the script",
    (t) =>
      t.replace(
        "          set -euo pipefail\n",
        "          set -euo pipefail\n          - x\n          echo ${{ github.ref }}\n",
      ),
    "an expression outside the reviewed lines",
  ],
  [
    "X14: a trailing & after verify:ts",
    (t) => t.replace("      - run: pnpm run verify:ts\n", "      - run: pnpm run verify:ts &\n"),
    "run steps must be exactly",
  ],
  [
    "X15: working-directory on a run step",
    (t) =>
      t.replace(
        "      - run: pnpm run verify:ts\n",
        "      - run: pnpm run verify:ts\n        working-directory: /tmp\n",
      ),
    "run steps must be exactly",
  ],
  [
    "X16: env on a run step",
    (t) =>
      t.replace(
        "      - run: pnpm run verify:ts\n",
        '      - run: pnpm run verify:ts\n        env:\n          CI: ""\n',
      ),
    "run steps must be exactly",
  ],
  [
    "X17: an extra run step in the verify job",
    (t) =>
      t.replace(
        "      - run: pnpm install --frozen-lockfile\n",
        "      - run: pnpm install --frozen-lockfile\n      - run: echo hello\n",
      ),
    "run steps must be exactly",
  ],
  [
    "X19: NPM_CONFIG_DRY_RUN in the publish env",
    (t) =>
      t.replace(
        "          RELEASE_DIR:",
        "          NPM_CONFIG_DRY_RUN: true\n          RELEASE_DIR:",
      ),
    "npm configuration through the environment",
  ],
  [
    "a publish env variable added",
    (t) => t.replace("          RELEASE_DIR:", "          EXTRA: x\n          RELEASE_DIR:"),
    "publish env block must be exactly",
  ],
  [
    "one character changed in the publish script",
    (t) => t.replace('echo "publishing $name@$version"', 'echo "publishing $name@$version!"'),
    "publish script must equal the reviewed copy",
  ],
  [
    "the defaults block removed",
    (t) => t.replace("defaults:\n  run:\n    shell: bash\n\n", ""),
    "defaults must be exactly",
  ],
  [
    "defaults with another shell",
    (t) => t.replace("    shell: bash\n", "    shell: sh\n"),
    "defaults must be exactly",
  ],
  [
    "a per-step shell: bash",
    (t) =>
      t.replace(
        "      - run: pnpm run verify:ts\n",
        "      - run: pnpm run verify:ts\n        shell: bash\n",
      ),
    "shell: may appear once",
  ],
];

for (const [name, mutate, expected] of mutations) {
  test(`release.yml check refuses: ${name}`, () => {
    const mutated = mutate(release);
    assert.notEqual(mutated, release, `the mutation "${name}" changed nothing`);
    const problems = checkReleaseWorkflow(mutated, ci);
    assert.ok(problems.length > 0, `"${name}" was accepted`);
    assert.ok(
      problems.some((p) => p.includes(expected)),
      `"${name}" was refused for other reasons than "${expected}": ${problems.join(" | ")}`,
    );
    // And the pin refuses it too, whatever the structural checks say.
    assert.notEqual(releaseSha(mutated), RELEASE_YML_SHA256);
  });
}

test("release.yml is the reviewed file", () => {
  assert.equal(
    releaseSha(release),
    RELEASE_YML_SHA256,
    "release.yml changed: review the diff, then update RELEASE_YML_SHA256",
  );
});

test("the pin ignores line endings and nothing else: one changed byte anywhere is refused", () => {
  assert.equal(releaseSha(release.replace(/\n/g, "\r\n")), releaseSha(release));
  const last = release.length - 1;
  for (const i of [0, 1, 17, 500, Math.floor(release.length / 2), last - 2, last - 1]) {
    const changed = release[i] === "x" ? "y" : "x";
    assert.notEqual(
      releaseSha(release.slice(0, i) + changed + release.slice(i + 1)),
      releaseSha(release),
      `byte ${i}`,
    );
  }
  // An appended comment, a deleted line break, an inserted space, and one more empty line.
  assert.notEqual(releaseSha(`${release}# x\n`), releaseSha(release));
  assert.notEqual(releaseSha(release.replace("\n", "")), releaseSha(release));
  assert.notEqual(
    releaseSha(release.replace("name: release", "name:  release")),
    releaseSha(release),
  );
  assert.notEqual(releaseSha(`${release}\n`), releaseSha(release));
});

test("release.yml: the tagged commit must be on main, and the workflow leaves no credentials behind", () => {
  assert.match(release, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  assert.match(release, /fetch-depth: 0\n\s+persist-credentials: false/);
  assert.ok(!/\bcache:/.test(release));
});

test("release.yml publishes through the npm-release environment, whose setup is written down", () => {
  assert.match(release, /\n {4}environment: npm-release\n/);
  assert.match(release, /Create the environment "npm-release"/);
  assert.match(release, /trusted publishing \(OIDC, no token\)/);
});

// ---------- prepublishOnly: a publish from a developer machine is refused ----------

const publishedDirs = ["core", "sdk", "cli"];

test("every published package refuses `npm publish` outside the release workflow, and `pnpm pack` is not affected", async () => {
  for (const dir of publishedDirs) {
    const manifest = JSON.parse(
      readFileSync(new URL(`../packages/${dir}/package.json`, import.meta.url), "utf8"),
    );
    const script = manifest.scripts.prepublishOnly;
    assert.ok(typeof script === "string", `${dir} has no prepublishOnly`);
    const js = /^node -e "(.*)"$/s.exec(script)?.[1];
    assert.ok(js, `${dir}: prepublishOnly is not a node -e "…" script`);
    assert.match(js, /process\.env\.CI!=='true'/);
    assert.match(js, /process\.env\.GITHUB_WORKFLOW!=='release'/);
    // The script itself, run with other environments (no network, no publishing: it only reads env).
    const base = { ...process.env };
    delete base.CI;
    delete base.GITHUB_WORKFLOW;
    const run = (extra) =>
      spawnSync(process.execPath, ["-e", js], { env: { ...base, ...extra }, encoding: "utf8" });
    const local = run({});
    assert.equal(local.status, 1, `${dir}: not refused on a developer machine`);
    assert.match(local.stderr, /Refusing to publish/);
    assert.equal(
      run({ CI: "true", GITHUB_WORKFLOW: "ci" }).status,
      1,
      `${dir}: refused for another workflow only if CI is wrong`,
    );
    assert.equal(run({ CI: "true" }).status, 1);
    assert.equal(run({ GITHUB_WORKFLOW: "release" }).status, 1);
    assert.equal(
      run({ CI: "true", GITHUB_WORKFLOW: "release" }).status,
      0,
      `${dir}: refused inside the release workflow`,
    );
    // Only a publish runs it: pack runs prepack, and prepack is the build.
    assert.equal(manifest.scripts.prepack, "pnpm run build");
    for (const other of ["prepare", "postpack", "prepublish"]) {
      assert.ok(!(other in manifest.scripts), `${dir} has a ${other} script`);
    }
  }
});

// biome-ignore-end lint/suspicious/noTemplateCurlyInString: see biome-ignore-start above
