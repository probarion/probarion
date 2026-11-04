import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
const RELEASE_YML_SHA256 = "09ea64589e940cec6be2013512e10676427510be5fe9ba37fc246d03e82daf9a";
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

/**
 * Every way the pnpm/action-setup steps of a workflow differ from the pin; the empty list means none.
 * The pnpm version has one source, `packageManager` in the root package.json, which pnpm/action-setup and
 * Vercel (with ENABLE_EXPERIMENTAL_COREPACK=1) both read. So the step is the bare `uses:` line with no
 * `with:` block: a `version:` that differs from packageManager makes the action fail ("Multiple versions of
 * pnpm specified"), and one that equals it is a second place to edit. `package_json_file` would point the
 * action at another file. Used for ci.yml and release.yml alike.
 */
function pnpmSetupProblems(text) {
  const problems = [];
  const jobs = blockLines(codeLines(text.replace(/\r\n/g, "\n")), "jobs") ?? [];
  const ids = jobs.filter((l) => /^ {2}[\w-]+:$/.test(l)).map((l) => l.trim().slice(0, -1));
  let found = 0;
  for (const id of ids) {
    for (const step of stepsOf(blockLines(jobs, id, 2) ?? [])) {
      if (!step.some((l) => /\buses:\s*pnpm\/action-setup@/.test(l))) continue;
      found += 1;
      if (step.length !== 1 || !/^ {6}- uses: pnpm\/action-setup@[0-9a-f]{40}$/.test(step[0])) {
        problems.push(
          `${id}: the pnpm/action-setup step must be exactly "- uses: pnpm/action-setup@<sha>" with no with: block, so that the pnpm version comes only from packageManager in package.json (a version: input that differs makes the action fail, and one that is equal is a second place to edit)`,
        );
      }
    }
  }
  if (found === 0) {
    problems.push(
      "no pnpm/action-setup step: the workflow must install pnpm through it, at the version packageManager names",
    );
  }
  return problems;
}

/** Every problem with a release workflow; the empty list means it has the shape the release relies on. */
function checkReleaseWorkflow(crlfOrLf, ciText) {
  const problems = [];
  const fail = (message) => problems.push(message);
  // Line endings are normalised exactly as the sha256 pin does, so a CRLF copy has the same shape.
  const text = crlfOrLf.replace(/\r\n/g, "\n");
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
  // Y1: the checkout takes the tagged commit. A ref: (main, a branch, a SHA) would test and pack another
  // commit than the one the tag names, while the main check still looks at the tag's $GITHUB_SHA.
  const checkoutStep = stepsOf(verify).find((step) => /uses: actions\/checkout@/.test(step[0]));
  if (
    JSON.stringify(checkoutStep?.slice(1)) !==
    JSON.stringify([
      "        with:",
      "          fetch-depth: 0",
      "          persist-credentials: false",
    ])
  ) {
    fail(
      "Y1: the checkout's with: must be exactly fetch-depth: 0 and persist-credentials: false (no ref:, which would pack another commit than the tag)",
    );
  }
  // Y6: the upload sends exactly what release:check packed and checked. With path: . it would send the
  // checkout, so a committed packages.json and tarball, never built from the tested code, would be published.
  const uploadStep = stepsOf(verify).find((step) =>
    /uses: actions\/upload-artifact@/.test(step[0]),
  );
  if (
    JSON.stringify(uploadStep?.slice(1)) !==
    JSON.stringify([
      "        with:",
      "          name: release-tarballs",
      "          path: ${{ runner.temp }}/release",
      "          if-no-files-found: error",
      "          retention-days: 7",
    ])
  ) {
    fail(
      "Y6: the upload's with: must be exactly name: release-tarballs, path: ${{ runner.temp }}/release, if-no-files-found: error and retention-days: 7",
    );
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
  // pnpm comes from packageManager (pinned in gateProblems below), so the step takes no version input.
  for (const problem of pnpmSetupProblems(text)) fail(problem);

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

/** A workflow with one more input on its (first) pnpm/action-setup step. */
const addPnpmInput = (text, input) =>
  text.replace(
    /( {6}- uses: pnpm\/action-setup@[0-9a-f]{40} # \S+\n)/,
    `$1        with:\n          ${input}\n`,
  );

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
  // pnpm comes from packageManager, so the step takes no inputs (the inverse of the old "version: 10" pin)
  [
    "a version input added to pnpm/action-setup (the action then fails, or names a second version)",
    (t) => addPnpmInput(t, "version: 10"),
    "pnpm/action-setup step must be exactly",
  ],
  [
    "a version input equal to packageManager added to pnpm/action-setup",
    (t) => addPnpmInput(t, "version: 10.10.0"),
    "pnpm/action-setup step must be exactly",
  ],
  [
    "package_json_file pointing the action at another file",
    (t) => addPnpmInput(t, "package_json_file: apps/web/package.json"),
    "pnpm/action-setup step must be exactly",
  ],
  [
    "the pnpm/action-setup step removed",
    (t) => t.replace(/ {6}- uses: pnpm\/action-setup@[0-9a-f]{40} # \S+\n/, ""),
    "no pnpm/action-setup step",
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
  // Named by the shape check itself, not only by the pin (T17-R4, review minors)
  [
    "Y1: ref: main on the checkout",
    (t) =>
      t.replace(
        "          persist-credentials: false\n",
        "          persist-credentials: false\n          ref: main\n",
      ),
    "Y1:",
  ],
  [
    "Y1b: a ref: before fetch-depth",
    (t) =>
      t.replace(
        "        with:\n          fetch-depth: 0\n",
        "        with:\n          ref: main\n          fetch-depth: 0\n",
      ),
    "Y1:",
  ],
  [
    "Y6: the upload path changed to .",
    (t) =>
      t.replace(
        "          path: ${{ runner.temp }}/release\n          if-no-files-found: error",
        "          path: .\n          if-no-files-found: error",
      ),
    "Y6:",
  ],
  [
    "Y6b: a second upload path",
    (t) =>
      t.replace(
        "          path: ${{ runner.temp }}/release\n          if-no-files-found: error",
        "          path: |\n            ${{ runner.temp }}/release\n            .\n          if-no-files-found: error",
      ),
    "Y6:",
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

test("the shape check treats a CRLF copy as the pin does: same shape, and every mutant still refused", () => {
  const crlf = (text) => text.replace(/\n/g, "\r\n");
  assert.notEqual(crlf(release), release);
  assert.deepEqual(checkReleaseWorkflow(crlf(release), crlf(ci)), []);
  for (const [name, mutate, expected] of mutations) {
    const problems = checkReleaseWorkflow(crlf(mutate(release)), ci);
    assert.ok(
      problems.some((p) => p.includes(expected)),
      `CRLF copy of "${name}" not refused for "${expected}": ${problems.join(" | ")}`,
    );
  }
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

// ---------- the gate scripts, pinned crosswise with scripts/test/release-manifests.test.ts (T17-R4) ----------
//
// release.yml runs `pnpm run verify:ts` and `pnpm run verify:launch`; what they do is in package.json
// scripts, so the scripts are pinned too, by two files that run under different gates. This file runs
// under verify:ts (root `test` runs `node --test "scripts/**/*.test.mjs"`) and pins verify:launch and the
// scripts it runs. scripts/test/release-manifests.test.ts runs under verify:launch and pins verify:ts and
// the scripts it runs. Switching off one gate is refused by the test that runs under the other. The
// refusal of constructs that swallow a failure, the per-package map and the workspace pins are in both
// files on purpose (T17-R4).

const SELF = "scripts/ci-workflow.test.mjs";

/** The root scripts this file pins (release-manifests.test.ts pins verify:ts and what it runs). */
const ROOT_PINNED = {
  "verify:launch": "pnpm typecheck:scripts && pnpm test:scripts",
  "test:scripts": "vitest run --root scripts",
  "typecheck:scripts": "tsc -p scripts/tsconfig.json",
  "release:check": "tsx scripts/release-check.ts",
};

/**
 * The pnpm that CI and Vercel install is the one `packageManager` names in the root package.json:
 * pnpm/action-setup reads it (the workflows give it no version), and Vercel does with
 * ENABLE_EXPERIMENTAL_COREPACK=1. This file pins the major line (pnpm 10, which the lockfile and
 * engines.pnpm need); release-manifests.test.ts pins the exact value, so moving to another major
 * needs a reviewed change in both files, and a patch bump a reviewed change in that one.
 */
const PNPM_PACKAGE_MANAGER = /^pnpm@10\.\d+\.\d+$/;

const PACKAGE_BUILD =
  "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\" && tsc -p tsconfig.build.json";
/**
 * The test, build, typecheck and lint scripts of every workspace package, exactly; null means the
 * package has no such script. `pnpm -r --if-present` skips a package whose script is missing, so a
 * removed script is a change too. No package has a lint script: the root `biome check .` lints them all.
 */
const PACKAGE_PINNED = {
  "packages/cli/package.json": {
    test: "vitest run",
    build: PACKAGE_BUILD,
    typecheck: "tsc -p tsconfig.json",
    lint: null,
  },
  "packages/core/package.json": {
    test: "vitest run",
    build: PACKAGE_BUILD,
    typecheck: "tsc -p tsconfig.json",
    lint: null,
  },
  "packages/sdk/package.json": {
    test: "vitest run",
    build: PACKAGE_BUILD,
    typecheck: "tsc -p tsconfig.json",
    lint: null,
  },
  "apps/web/package.json": {
    test: "vitest run",
    build: "next build",
    typecheck: "tsc --noEmit",
    lint: null,
  },
};

/** The one script allowed to use `||`: the publish guard of the three published packages, exactly. */
const PREPUBLISH_GUARD =
  "node -e \"if(process.env.CI!=='true'||process.env.GITHUB_WORKFLOW!=='release'){console.error('Refusing to publish: only the GitHub release workflow publishes. Push a tag such as sdk-v0.1.0 instead.');process.exit(1)}\"";
const GUARDED = [
  "packages/core/package.json",
  "packages/sdk/package.json",
  "packages/cli/package.json",
];

// Where a shell word starts a command: the start, after && || | & ; ( ) { !, or after then/do/else.
const COMMAND_START = String.raw`(?:^|&&|\|\||[;|&(){!]|\b(?:then|do|else)\b)\s*`;
/** Constructs that let a failing script pass. None may appear in any script of any workspace package. */
const SWALLOWS = [
  [/\|\|/, '"||"'],
  [/\|\|\s*exit\s+0\b/, '"|| exit 0"'],
  [/;\s*true\b/, '"; true" (or ";true")'],
  [/\bexit\s+0\b/, '"exit 0"'],
  [/--passWithNoTests|--pass-with-no-tests/i, '"--passWithNoTests"'],
  [
    /--dangerouslyIgnoreUnhandledErrors|--dangerously-ignore-unhandled-errors/i,
    '"--dangerouslyIgnoreUnhandledErrors"',
  ],
  [/--bail(?:\s+|=)0\b/, '"--bail 0"'],
  [new RegExp(`${COMMAND_START}(?:true|:)(?=$|[\\s;&|)}])`), '"true" (or ":") used as a command'],
  [new RegExp(`${COMMAND_START}exit\\s*(?=$|[;&|)}])`), 'a bare "exit", which exits 0'],
];

// pnpm-workspace.yaml chooses the packages that `pnpm -r` runs and can hold settings (scriptShell).
const WORKSPACE_YAML = 'packages:\n  - "packages/*"\n  - "apps/*"\n  - "eval"\n';
// scripts/vitest.config.ts chooses which scripts/test files verify:launch runs. Update with:
// node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync("scripts/vitest.config.ts","utf8").replace(/\r\n/g,"\n")).digest("hex"))'
const SCRIPTS_VITEST_SHA256 = "b2c667b89f365ece33ad8b5fdb0024cd6ce82b64bd6916cb5b5696776e8f9b70";

const repoRoot = new URL("../", import.meta.url);
const inRepo = (path) => new URL(path, repoRoot);
const readRepo = (path) => readFileSync(inRepo(path), "utf8");
const lf = (text) => text.replace(/\r\n/g, "\n");
const sha256 = (text) => createHash("sha256").update(lf(text)).digest("hex");

/** The workspace manifests by path, and the config files that decide how the scripts run (null: absent). */
function loadRepo() {
  const paths = ["package.json"];
  for (const parent of ["packages", "apps"]) {
    for (const dir of readdirSync(inRepo(`${parent}/`)).sort()) {
      if (existsSync(inRepo(`${parent}/${dir}/package.json`))) {
        paths.push(`${parent}/${dir}/package.json`);
      }
    }
  }
  if (existsSync(inRepo("eval/package.json"))) paths.push("eval/package.json");
  const optional = (path) => (existsSync(inRepo(path)) ? readRepo(path) : null);
  const files = new Map([
    ["pnpm-workspace.yaml", optional("pnpm-workspace.yaml")],
    ["scripts/vitest.config.ts", optional("scripts/vitest.config.ts")],
  ]);
  for (const dir of ["", ...paths.slice(1).map((p) => p.slice(0, -"package.json".length))]) {
    files.set(`${dir}.npmrc`, optional(`${dir}.npmrc`));
    for (const pnpmfile of [".pnpmfile.cjs", ".pnpmfile.mjs"]) {
      files.set(`${dir}${pnpmfile}`, optional(`${dir}${pnpmfile}`));
    }
    for (const base of ["vitest.config", "vite.config"]) {
      for (const ext of ["ts", "mts", "cts", "js", "mjs", "cjs"]) {
        const path = `${dir}${base}.${ext}`;
        if (existsSync(inRepo(path))) files.set(path, readRepo(path));
      }
    }
  }
  return { manifests: new Map(paths.map((p) => [p, JSON.parse(readRepo(p))])), files };
}

/** Every way the workspace's scripts differ from the pinned ones; the empty list means none. */
function gateProblems(repo) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const show = (value) => (value === null ? "absent" : JSON.stringify(value));
  const pinned = (file, name, want) => {
    const got = repo.manifests.get(file)?.scripts?.[name] ?? null;
    if (got !== want) {
      fail(
        `${file}: scripts["${name}"] changed (pinned ${show(want)}, now ${show(got)}); review the change, then update the pinned value in ${SELF}`,
      );
    }
  };

  const expected = ["package.json", ...Object.keys(PACKAGE_PINNED)];
  for (const file of repo.manifests.keys()) {
    if (!expected.includes(file)) {
      fail(
        `${file}: a workspace package whose test, build, typecheck and lint scripts are not pinned; review them, then add them to the pinned value in ${SELF}`,
      );
    }
  }
  for (const file of expected) {
    if (!repo.manifests.has(file)) {
      fail(
        `${file}: a pinned workspace package is missing; review the change, then update ${SELF}`,
      );
    }
  }
  for (const [name, want] of Object.entries(ROOT_PINNED)) pinned("package.json", name, want);
  for (const [file, scripts] of Object.entries(PACKAGE_PINNED)) {
    for (const [name, want] of Object.entries(scripts)) pinned(file, name, want);
  }
  for (const file of GUARDED) pinned(file, "prepublishOnly", PREPUBLISH_GUARD);
  const packageManager = repo.manifests.get("package.json")?.packageManager;
  if (typeof packageManager !== "string" || !PNPM_PACKAGE_MANAGER.test(packageManager)) {
    fail(
      `package.json: packageManager must be pnpm@10.x.y (pnpm/action-setup and Vercel install the version it names; the lockfile and engines.pnpm need pnpm 10), now ${show(packageManager ?? null)}; review the change, then update the pattern in ${SELF}`,
    );
  }

  for (const [file, manifest] of repo.manifests) {
    for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
      if (typeof script !== "string") {
        fail(`${file}: scripts["${name}"] is not a string; review the change`);
        continue;
      }
      if (name === "prepublishOnly" && GUARDED.includes(file) && script === PREPUBLISH_GUARD)
        continue;
      for (const [pattern, label] of SWALLOWS) {
        if (pattern.test(script)) {
          fail(
            `${file}: scripts["${name}"] contains ${label}, which lets a failure pass; review the change (only the three pinned prepublishOnly guards may use "||")`,
          );
        }
      }
    }
  }

  if (lf(repo.files.get("pnpm-workspace.yaml") ?? "") !== WORKSPACE_YAML) {
    fail(
      `pnpm-workspace.yaml changed (it chooses the packages that pnpm -r runs, and can set scriptShell); review the change, then update the pinned value in ${SELF}`,
    );
  }
  if (sha256(repo.files.get("scripts/vitest.config.ts") ?? "") !== SCRIPTS_VITEST_SHA256) {
    fail(
      `scripts/vitest.config.ts changed (it chooses which scripts/test files verify:launch runs); review the change, then update the pinned value in ${SELF}`,
    );
  }
  for (const [path, text] of repo.files) {
    if (path.endsWith(".npmrc") && text !== null) {
      fail(
        `${path} exists (an .npmrc can replace the shell every script runs in, with script-shell); review it, then allow it in ${SELF}`,
      );
    }
    if (/(^|\/)\.pnpmfile\.[cm]js$/.test(path) && text !== null) {
      fail(
        `${path} exists (a pnpmfile runs its own code on every pnpm install and can rewrite package manifests); review it, then allow it in ${SELF}`,
      );
    }
    if (/\bvite(st)?\.config\./.test(path) && /passWithNoTests/i.test(text ?? "")) {
      fail(
        `${path} sets passWithNoTests, which lets a run with no test files pass; review the change`,
      );
    }
    if (
      /\bvite(st)?\.config\./.test(path) &&
      /dangerouslyIgnoreUnhandledErrors/i.test(text ?? "")
    ) {
      fail(
        `${path} sets dangerouslyIgnoreUnhandledErrors, which lets a run with unhandled errors pass; review the change`,
      );
    }
  }
  return problems;
}

const workspace = loadRepo();

const cloneRepo = (from) => ({
  manifests: new Map([...from.manifests].map(([file, m]) => [file, structuredClone(m)])),
  files: new Map(from.files),
});
const scriptsIn = (of, file) => {
  const scripts = of.manifests.get(file)?.scripts;
  if (!scripts) throw new Error(`${file} has no scripts`);
  return scripts;
};
const appendTo = (of, file, name, tail) => {
  const scripts = scriptsIn(of, file);
  scripts[name] = `${scripts[name]}${tail}`;
};

// Each is an edit of an in-memory copy of the parsed manifests (or of a config file). Every one must be
// refused, and for each listed reason. The first four are the ruling's (T17-R4 item 5).
const gateMutations = [
  [
    '"|| true" on verify:ts',
    (r) => appendTo(r, "package.json", "verify:ts", " || true"),
    ['package.json: scripts["verify:ts"] contains "||"'],
  ],
  [
    "verify:launch replaced with true",
    (r) => {
      scriptsIn(r, "package.json")["verify:launch"] = "true";
    },
    [
      'package.json: scripts["verify:launch"] changed (pinned "pnpm typecheck:scripts && pnpm test:scripts", now "true")',
      'package.json: scripts["verify:launch"] contains "true" (or ":") used as a command',
    ],
  ],
  [
    "a package's test replaced with echo ok",
    (r) => {
      scriptsIn(r, "packages/core/package.json").test = "echo ok";
    },
    ['packages/core/package.json: scripts["test"] changed (pinned "vitest run", now "echo ok")'],
  ],
  [
    "--passWithNoTests added to a package's test",
    (r) => appendTo(r, "packages/sdk/package.json", "test", " --passWithNoTests"),
    [
      'packages/sdk/package.json: scripts["test"] changed',
      'packages/sdk/package.json: scripts["test"] contains "--passWithNoTests"',
    ],
  ],
  // The other constructs, on scripts no exact pin covers, so only the scan can refuse them.
  [
    '"; true" on a root script',
    (r) => appendTo(r, "package.json", "proof", "; true"),
    ['package.json: scripts["proof"] contains "; true"'],
  ],
  [
    '";true" on an app script',
    (r) => appendTo(r, "apps/web/package.json", "test:e2e", ";true"),
    ['apps/web/package.json: scripts["test:e2e"] contains "; true"'],
  ],
  [
    '"exit 0" in an app script',
    (r) => appendTo(r, "apps/web/package.json", "dev", " && exit 0"),
    ['apps/web/package.json: scripts["dev"] contains "exit 0"'],
  ],
  [
    '"|| exit 0" in a package script',
    (r) => appendTo(r, "packages/core/package.json", "fixtures", " || exit 0"),
    ['packages/core/package.json: scripts["fixtures"] contains "|| exit 0"'],
  ],
  [
    '"--bail 0" on the web tests',
    (r) => appendTo(r, "apps/web/package.json", "test", " --bail 0"),
    [
      'apps/web/package.json: scripts["test"] changed',
      'apps/web/package.json: scripts["test"] contains "--bail 0"',
    ],
  ],
  [
    '" true" used as a command',
    (r) => {
      scriptsIn(r, "package.json")["verify:full"] = "pnpm run verify; true";
    },
    ['scripts["verify:full"] contains "; true"', 'scripts["verify:full"] contains "true" (or ":")'],
  ],
  [
    "true as the whole script",
    (r) => {
      scriptsIn(r, "package.json")["test:sandbox"] = " true";
    },
    ['scripts["test:sandbox"] contains "true" (or ":") used as a command'],
  ],
  [
    "a bare exit",
    (r) => {
      scriptsIn(r, "package.json")["contracts:build"] = "exit";
    },
    ['scripts["contracts:build"] contains a bare "exit"'],
  ],
  [
    '":" as a command',
    (r) => {
      scriptsIn(r, "packages/sdk/package.json")["record:nearai"] = ":";
    },
    ['scripts["record:nearai"] contains "true" (or ":") used as a command'],
  ],
  // Pins this file holds
  [
    "test:scripts dropped from verify:launch",
    (r) => {
      scriptsIn(r, "package.json")["verify:launch"] = "pnpm typecheck:scripts";
    },
    ['package.json: scripts["verify:launch"] changed'],
  ],
  [
    "test:scripts weakened to echo",
    (r) => {
      scriptsIn(r, "package.json")["test:scripts"] = "echo ok";
    },
    ['package.json: scripts["test:scripts"] changed'],
  ],
  [
    "test:scripts pointed at another root",
    (r) => {
      scriptsIn(r, "package.json")["test:scripts"] = "vitest run --root scripts/testnet";
    },
    ['package.json: scripts["test:scripts"] changed'],
  ],
  [
    "typecheck:scripts weakened",
    (r) => {
      scriptsIn(r, "package.json")["typecheck:scripts"] = "tsc --version";
    },
    ['package.json: scripts["typecheck:scripts"] changed'],
  ],
  [
    "release:check pointed at another script",
    (r) => {
      scriptsIn(r, "package.json")["release:check"] = "node -e 0";
    },
    ['package.json: scripts["release:check"] changed'],
  ],
  [
    "a package's test script removed (pnpm -r --if-present would skip it)",
    (r) => {
      delete scriptsIn(r, "packages/cli/package.json").test;
    },
    ['packages/cli/package.json: scripts["test"] changed (pinned "vitest run", now absent)'],
  ],
  [
    "a package's typecheck weakened",
    (r) => {
      scriptsIn(r, "apps/web/package.json").typecheck = "echo ok";
    },
    ['apps/web/package.json: scripts["typecheck"] changed'],
  ],
  [
    "a package lint script added",
    (r) => {
      scriptsIn(r, "packages/core/package.json").lint = "echo ok";
    },
    ['packages/core/package.json: scripts["lint"] changed (pinned absent, now "echo ok")'],
  ],
  [
    "a package build that no longer cleans dist",
    (r) => {
      scriptsIn(r, "packages/sdk/package.json").build = "tsc -p tsconfig.build.json";
    },
    ['packages/sdk/package.json: scripts["build"] changed'],
  ],
  [
    "a prepublishOnly guard that exits 0",
    (r) => {
      const scripts = scriptsIn(r, "packages/cli/package.json");
      scripts.prepublishOnly = scripts.prepublishOnly.replace("exit(1)", "exit(0)");
    },
    [
      'packages/cli/package.json: scripts["prepublishOnly"] changed',
      'packages/cli/package.json: scripts["prepublishOnly"] contains "||"',
    ],
  ],
  [
    "the guard copied into a package that is not one of the three",
    (r) => {
      scriptsIn(r, "apps/web/package.json").prepublishOnly = PREPUBLISH_GUARD;
    },
    ['apps/web/package.json: scripts["prepublishOnly"] contains "||"'],
  ],
  [
    "a new workspace package that nothing pins",
    (r) => {
      r.manifests.set("packages/mcp/package.json", { scripts: { test: "echo ok" } });
    },
    ["packages/mcp/package.json: a workspace package whose test, build, typecheck and lint"],
  ],
  // The files that decide how every script runs
  [
    "an .npmrc that replaces the script shell",
    (r) => {
      r.files.set(".npmrc", "script-shell=/bin/true\n");
    },
    [".npmrc exists"],
  ],
  [
    "a scriptShell setting in pnpm-workspace.yaml",
    (r) => {
      r.files.set("pnpm-workspace.yaml", `${WORKSPACE_YAML}scriptShell: ./sh\n`);
    },
    ["pnpm-workspace.yaml changed"],
  ],
  [
    "a package dropped from the pnpm workspace",
    (r) => {
      r.files.set("pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n');
    },
    ["pnpm-workspace.yaml changed"],
  ],
  [
    "a scripts/vitest.config.ts that skips release-manifests.test.ts",
    (r) => {
      r.files.set(
        "scripts/vitest.config.ts",
        r.files
          .get("scripts/vitest.config.ts")
          .replace(
            'include: ["test/**/*.test.ts"]',
            'include: ["test/**/*.test.ts"], exclude: ["test/release-manifests.test.ts"]',
          ),
      );
    },
    ["scripts/vitest.config.ts changed"],
  ],
  [
    "passWithNoTests in a package's vitest config",
    (r) => {
      r.files.set(
        "packages/core/vitest.config.ts",
        r.files
          .get("packages/core/vitest.config.ts")
          .replace("  test: {\n", "  test: {\n    passWithNoTests: true,\n"),
      );
    },
    ["packages/core/vitest.config.ts sets passWithNoTests"],
  ],
  [
    "a .pnpmfile.cjs at the root",
    (r) => {
      r.files.set(".pnpmfile.cjs", "module.exports = { hooks: { readPackage: (p) => p } };\n");
    },
    [".pnpmfile.cjs exists (a pnpmfile runs its own code"],
  ],
  [
    "a .pnpmfile.cjs in a workspace package",
    (r) => {
      r.files.set("packages/core/.pnpmfile.cjs", "module.exports = {};\n");
    },
    ["packages/core/.pnpmfile.cjs exists"],
  ],
  [
    "dangerouslyIgnoreUnhandledErrors in a package's vitest config",
    (r) => {
      r.files.set(
        "apps/web/vitest.config.ts",
        r.files
          .get("apps/web/vitest.config.ts")
          .replace("  test: {\n", "  test: {\n    dangerouslyIgnoreUnhandledErrors: true,\n"),
      );
    },
    ["apps/web/vitest.config.ts sets dangerouslyIgnoreUnhandledErrors"],
  ],
  [
    "--dangerouslyIgnoreUnhandledErrors on a package's test",
    (r) => appendTo(r, "packages/cli/package.json", "test", " --dangerouslyIgnoreUnhandledErrors"),
    [
      'packages/cli/package.json: scripts["test"] changed',
      'packages/cli/package.json: scripts["test"] contains "--dangerouslyIgnoreUnhandledErrors"',
    ],
  ],
  // packageManager is what pnpm/action-setup and Vercel install
  [
    "packageManager set to pnpm 9",
    (r) => {
      r.manifests.get("package.json").packageManager = "pnpm@9.15.9";
    },
    ["package.json: packageManager must be pnpm@10.x.y", 'now "pnpm@9.15.9"'],
  ],
  [
    "packageManager set to npm",
    (r) => {
      r.manifests.get("package.json").packageManager = "npm@10.9.0";
    },
    ["package.json: packageManager must be pnpm@10.x.y", 'now "npm@10.9.0"'],
  ],
  [
    "packageManager set to yarn",
    (r) => {
      r.manifests.get("package.json").packageManager = "yarn@4.5.0";
    },
    ["package.json: packageManager must be pnpm@10.x.y", 'now "yarn@4.5.0"'],
  ],
  [
    "packageManager set to pnpm 11",
    (r) => {
      r.manifests.get("package.json").packageManager = "pnpm@11.0.0";
    },
    ["package.json: packageManager must be pnpm@10.x.y"],
  ],
  [
    "packageManager with a range instead of a version",
    (r) => {
      r.manifests.get("package.json").packageManager = "pnpm@^10.10.0";
    },
    ["package.json: packageManager must be pnpm@10.x.y"],
  ],
  [
    "packageManager removed",
    (r) => {
      delete r.manifests.get("package.json").packageManager;
    },
    ["package.json: packageManager must be pnpm@10.x.y", "now absent"],
  ],
  [
    "packageManager not a string",
    (r) => {
      r.manifests.get("package.json").packageManager = { name: "pnpm", version: "10.10.0" };
    },
    ["package.json: packageManager must be pnpm@10.x.y"],
  ],
];

test("the gate scripts release.yml runs are the pinned ones, and none can swallow a failure (T17-R4)", () => {
  assert.deepEqual(gateProblems(workspace), []);
});

test("the gate scripts are read from every workspace package and every config file that changes how they run", () => {
  assert.deepEqual(
    [...workspace.manifests.keys()].sort(),
    ["package.json", ...Object.keys(PACKAGE_PINNED)].sort(),
  );
  for (const path of [
    "pnpm-workspace.yaml",
    "scripts/vitest.config.ts",
    ".npmrc",
    "apps/web/.npmrc",
    ".pnpmfile.cjs",
    "apps/web/.pnpmfile.cjs",
    "packages/core/vitest.config.ts",
    "apps/web/vitest.config.ts",
  ]) {
    assert.ok(workspace.files.has(path), `${path} is not read`);
  }
});

test("the major-line check here accepts a pnpm 10 bump: the exact value is pinned in release-manifests.test.ts", () => {
  const bumped = cloneRepo(workspace);
  bumped.manifests.get("package.json").packageManager = "pnpm@10.99.0";
  assert.deepEqual(gateProblems(bumped), []);
});

for (const [name, edit, reasons] of gateMutations) {
  test(`the gate scripts check refuses: ${name}`, () => {
    const before = JSON.stringify([...workspace.manifests, ...workspace.files]);
    const mutated = cloneRepo(workspace);
    edit(mutated);
    assert.notEqual(
      JSON.stringify([...mutated.manifests, ...mutated.files]),
      before,
      "changed nothing",
    );
    const problems = gateProblems(mutated);
    for (const reason of reasons) {
      assert.ok(
        problems.some((p) => p.includes(reason)),
        `"${name}" not refused for "${reason}": ${problems.join(" | ")}`,
      );
    }
    // The edit was made on a copy: the manifests as read are untouched.
    assert.equal(JSON.stringify([...workspace.manifests, ...workspace.files]), before);
  });
}

// ---------- ci.yml: the one `verify` check, and the failure explainer ----------
//
// A ruleset on dev and main requires one check, `verify`, rather than a list of job names that changes
// whenever a job is renamed or added. That check means "every job succeeded" only while the verify job
// has the shape below: it needs every other job, runs even when one of them failed, was skipped or was
// cancelled (if: always(); GitHub counts a skipped required check as passed), and fails unless each
// result is `success`. The long jobs tee each gate to a log under pipefail and end with the failure
// explainer (scripts/ci-failure-note.mjs). `checkVerifyJob` and `checkExplainers` return every way
// ci.yml differs from that; the tests run them on the real file and on in-memory mutants.

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions are text here, not templates

/** The job ids of a workflow (as code lines), in file order. */
const jobIdsOf = (workflowLines) =>
  (blockLines(workflowLines, "jobs") ?? [])
    .filter((l) => /^ {2}[\w-]+:$/.test(l))
    .map((l) => l.trim().slice(0, -1));

const resultVar = (id) => id.toUpperCase().replace(/-/g, "_");
const hasIfKey = (l) => /(^|[{,]\s*)["']?if["']?\s*:/.test(l.replace(/^\s*(-\s+)?/, ""));

// The result check, exactly as reviewed: the body of the step's `run: |`, without its indentation.
const VERIFY_SCRIPT = [
  'failed=""',
  'echo "| Job | Result |" >> "$GITHUB_STEP_SUMMARY"',
  'echo "| --- | --- |" >> "$GITHUB_STEP_SUMMARY"',
  'for pair in "ts=$TS" "gitleaks=$GITLEAKS" "rust-unit=$RUST_UNIT" "sandbox=$SANDBOX" "reproducible=$REPRODUCIBLE"; do',
  '  job="${pair%%=*}"',
  '  result="${pair#*=}"',
  '  echo "$job: $result"',
  '  echo "| $job | $result |" >> "$GITHUB_STEP_SUMMARY"',
  '  if [ "$result" != "success" ]; then',
  '    failed="$failed $job ($result)"',
  "  fi",
  "done",
  'if [ -n "$failed" ]; then',
  '  echo "::error title=verify failed::Not every job succeeded:$failed. A skipped or cancelled job counts as a failure."',
  "  exit 1",
  "fi",
  'echo "Every job succeeded."',
];

/** Every way ci.yml's verify job differs from the reviewed shape; the empty list means none. */
function checkVerifyJob(text) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const lines = codeLines(text.replace(/\r\n/g, "\n"));
  const ids = jobIdsOf(lines);
  const jobs = blockLines(lines, "jobs") ?? [];
  const job = blockLines(jobs, "verify", 2);
  if (!job) return ["there is no verify job"];
  const others = ids.filter((id) => id !== "verify");
  if (ids.at(-1) !== "verify") fail("verify must be the last job");

  const keys = job.filter((l) => /^ {4}[\w-]+:/.test(l)).map((l) => l.trim().split(":")[0]);
  const wantKeys = ["name", "needs", "if", "runs-on", "timeout-minutes", "permissions", "steps"];
  if (JSON.stringify(keys) !== JSON.stringify(wantKeys)) {
    fail(`the verify job's keys must be exactly ${wantKeys.join(", ")}`);
  }
  if (!job.includes("    name: verify")) {
    fail("the job must be named verify: that is the check name the ruleset requires");
  }
  if (jobs.filter((l) => /^ {4}name: ["']?verify["']?$/.test(l)).length !== 1) {
    fail("only the verify job may be named verify");
  }
  const needsLine = job.find((l) => /^ {4}needs:/.test(l)) ?? "";
  const needs = /^ {4}needs: \[(.*)\]$/.exec(needsLine)?.[1];
  if (JSON.stringify(needs?.split(", ")) !== JSON.stringify(others)) {
    fail(`needs: must list every other job, in file order (${others.join(", ")})`);
  }
  if (JSON.stringify(job.filter(hasIfKey)) !== JSON.stringify(["    if: always()"])) {
    fail(
      "the job needs if: always(), and no other if:, so that a failed, skipped or cancelled job still reaches it",
    );
  }
  if (!job.includes("    runs-on: ubuntu-latest")) fail("the job runs on ubuntu-latest");
  if (
    !job.includes("    permissions: {}") ||
    job.filter((l) => /permissions/.test(l)).length !== 1
  ) {
    fail("the job needs permissions: {} and no other permissions");
  }
  const timeoutLine = job.find((l) => /timeout-minutes/.test(l)) ?? "";
  const timeout = Number(/^ {4}timeout-minutes: (\d+)$/.exec(timeoutLine)?.[1]);
  if (!(timeout >= 1 && timeout <= 10)) fail("the job needs a short timeout-minutes, at most 10");
  if (job.some((l) => /continue-on-error/.test(l))) {
    fail("continue-on-error is not allowed in the verify job: its failure must fail the check");
  }
  if (job.some((l) => /\buses:/.test(l)))
    fail("the verify job checks out nothing and uses no action");
  if (job.some((l) => /\bsecrets\b|github\.token|GITHUB_TOKEN/.test(l))) {
    fail("the verify job must not touch a secret or the token");
  }

  const steps = stepsOf(job);
  if (steps.length !== 1) fail("the verify job has exactly one step");
  const step = steps[0] ?? [];
  const stepKeys = step
    .filter((l) => /^ {6}- [\w-]+:|^ {8}[\w-]+:/.test(l))
    .map((l) => l.trim().replace(/^- /, "").split(":")[0]);
  if (JSON.stringify(stepKeys) !== JSON.stringify(["name", "env", "run"])) {
    fail("the result step's keys must be exactly name, env and run");
  }
  const env = blockLines(step, "env", 8);
  const wantEnv = [
    "        env:",
    ...others.map((id) => `          ${resultVar(id)}: \${{ needs.${id}.result }}`),
  ];
  if (JSON.stringify(env) !== JSON.stringify(wantEnv)) {
    fail("the result check must read needs.<id>.result of every other job, and nothing else");
  }
  const runAt = step.indexOf("        run: |");
  const body = runAt < 0 ? [] : step.slice(runAt + 1).map((l) => l.slice(10));
  const loop = `for pair in ${others.map((id) => `"${id}=$${resultVar(id)}"`).join(" ")}; do`;
  if (!body.includes(loop)) fail("the result check must test every job in needs");
  if (JSON.stringify(body) !== JSON.stringify(VERIFY_SCRIPT)) {
    fail("the result check must equal the reviewed copy: it fails unless every result is success");
  }
  return problems;
}

// The gate commands of each explained job, in order, with the name of each one's log.
const EXPLAINED = {
  ts: [
    ["pnpm install --frozen-lockfile", "install"],
    ["pnpm run verify:ts", "verify-ts"],
    ["pnpm verify:launch", "verify-launch"],
  ],
  "rust-unit": [
    ["cargo fmt --manifest-path contracts/Cargo.toml --all -- --check", "fmt"],
    [
      "cargo clippy --manifest-path contracts/Cargo.toml --workspace --exclude integration-tests --all-targets -- -D warnings",
      "clippy",
    ],
    [
      "cargo test --manifest-path contracts/Cargo.toml --workspace --exclude integration-tests",
      "test",
    ],
  ],
  sandbox: [
    ["bash scripts/build-contracts.sh", "build"],
    [
      "cargo clippy --manifest-path contracts/Cargo.toml -p integration-tests --all-targets -- -D warnings",
      "clippy",
    ],
    [
      "cargo test --manifest-path contracts/Cargo.toml -p integration-tests -- --test-threads=2",
      "test",
    ],
  ],
};

/** Every way the gate steps and the failure explainer of the long jobs differ from the reviewed shape. */
function checkExplainers(text) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const jobs = blockLines(codeLines(text.replace(/\r\n/g, "\n")), "jobs") ?? [];
  for (const [id, gates] of Object.entries(EXPLAINED)) {
    const job = blockLines(jobs, id, 2);
    if (!job) {
      fail(`${id}: the job is missing`);
      continue;
    }
    const steps = stepsOf(job);
    const explainer = [
      "      - name: Explain the failure",
      "        if: failure()",
      `        run: node scripts/ci-failure-note.mjs ${id}`,
    ];
    if (JSON.stringify(steps.at(-1)) !== JSON.stringify(explainer)) {
      fail(
        `${id}: the last step must be the failure explainer, with if: failure() and run: node scripts/ci-failure-note.mjs ${id}`,
      );
    }
    const gateSteps = steps.slice(-1 - gates.length, -1);
    for (const [i, [command, log]] of gates.entries()) {
      const tee = `          ${command} 2>&1 | tee "$RUNNER_TEMP/gate-${i + 1}-${log}.log"`;
      const step = gateSteps[i] ?? [];
      const shape = ["        run: |", "          set -o pipefail", tee];
      if (
        !/^ {6}- name: \S/.test(step[0] ?? "") ||
        JSON.stringify(step.slice(1)) !== JSON.stringify(shape)
      ) {
        fail(
          `${id}: gate ${i + 1} must be a named step that runs exactly: set -o pipefail, then ${tee.trim()}`,
        );
      }
    }
    if (JSON.stringify(job.filter(hasIfKey)) !== JSON.stringify(["        if: failure()"])) {
      fail(`${id}: only the explainer may have an if:, and it is if: failure()`);
    }
    if (job.some((l) => /continue-on-error/.test(l))) {
      fail(`${id}: continue-on-error is not allowed: a failed gate must fail the job`);
    }
    if (job.some((l) => /\bsecrets\b/.test(l))) {
      fail(`${id}: the explainer posts this job's log, so the job must use no secret`);
    }
  }
  return problems;
}

test("ci.yml: the verify job has the reviewed shape, and needs every other job", () => {
  assert.deepEqual(checkVerifyJob(ci), []);
  assert.deepEqual(jobIdsOf(codeLines(ci)), [
    "ts",
    "gitleaks",
    "rust-unit",
    "sandbox",
    "reproducible",
    "verify",
  ]);
});

test("ci.yml: every gate of the long jobs keeps its exit status through tee, and a failure is explained", () => {
  assert.deepEqual(checkExplainers(ci), []);
});

test("ci.yml and release.yml install pnpm through pnpm/action-setup with no inputs: packageManager names the version", () => {
  assert.deepEqual(pnpmSetupProblems(ci), []);
  assert.deepEqual(pnpmSetupProblems(release), []);
});

/** Every check that runs on ci.yml text: the verify job, the explainers and the pnpm setup. */
const ciProblems = (text) => [
  ...checkVerifyJob(text),
  ...checkExplainers(text),
  ...pnpmSetupProblems(text),
];

const VERIFY_STEP_RUN = '        run: |\n          failed=""\n';
const ciMutations = [
  // pnpm comes from packageManager, so the step takes no inputs
  [
    "a version input added to pnpm/action-setup (the action then fails, or names a second version)",
    (t) => addPnpmInput(t, "version: 10"),
    "ts: the pnpm/action-setup step must be exactly",
  ],
  [
    "a version input equal to packageManager added to pnpm/action-setup",
    (t) => addPnpmInput(t, "version: 10.10.0"),
    "ts: the pnpm/action-setup step must be exactly",
  ],
  [
    "package_json_file pointing the action at another file",
    (t) => addPnpmInput(t, "package_json_file: apps/web/package.json"),
    "ts: the pnpm/action-setup step must be exactly",
  ],
  [
    "the pnpm/action-setup step removed",
    (t) => t.replace(/ {6}- uses: pnpm\/action-setup@[0-9a-f]{40} # \S+\n/, ""),
    "no pnpm/action-setup step",
  ],
  // The four the brief names
  ["a verify job without if: always()", (t) => t.replace("    if: always()\n", ""), "if: always()"],
  [
    "a result check that ignores a skipped need (only failure fails)",
    (t) => t.replace('if [ "$result" != "success" ]; then', 'if [ "$result" = "failure" ]; then'),
    "result check must equal the reviewed copy",
  ],
  [
    "a need dropped from needs",
    (t) =>
      t.replace(
        "needs: [ts, gitleaks, rust-unit, sandbox, reproducible]",
        "needs: [ts, gitleaks, rust-unit, reproducible]",
      ),
    "needs: must list every other job",
  ],
  [
    "continue-on-error on the verify job",
    (t) => t.replace("    if: always()\n", "    if: always()\n    continue-on-error: true\n"),
    "continue-on-error is not allowed in the verify job",
  ],
  // More ways to make the check pass when a job did not succeed
  [
    "if: success() instead of always()",
    (t) => t.replace("    if: always()", "    if: success()"),
    "if: always()",
  ],
  [
    "if: !cancelled() instead of always()",
    (t) => t.replace("    if: always()", "    if: ${{ !cancelled() }}"),
    "if: always()",
  ],
  [
    "a result check that also accepts skipped",
    (t) =>
      t.replace(
        'if [ "$result" != "success" ]; then',
        'if [ "$result" != "success" ] && [ "$result" != "skipped" ]; then',
      ),
    "result check must equal the reviewed copy",
  ],
  [
    "a need dropped from the result loop",
    (t) => t.replace(' "sandbox=$SANDBOX" "reproducible', ' "reproducible'),
    "must test every job in needs",
  ],
  [
    "a need's result read from another job",
    (t) => t.replace("SANDBOX: ${{ needs.sandbox.result }}", "SANDBOX: ${{ needs.ts.result }}"),
    "needs.<id>.result of every other job",
  ],
  [
    "continue-on-error on the result step",
    (t) => t.replace(VERIFY_STEP_RUN, `        continue-on-error: true\n${VERIFY_STEP_RUN}`),
    "continue-on-error is not allowed in the verify job",
  ],
  [
    "exit 0 instead of exit 1",
    (t) =>
      t.replace(
        'counts as a failure."\n            exit 1',
        'counts as a failure."\n            exit 0',
      ),
    "result check must equal the reviewed copy",
  ],
  [
    "a checkout in the verify job",
    (t) =>
      t.replace(
        "      - name: Require every job to have succeeded\n",
        "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n      - name: Require every job to have succeeded\n",
      ),
    "checks out nothing",
  ],
  [
    "a secret in the verify job",
    (t) =>
      t.replace(
        "          TS: ${{ needs.ts.result }}\n",
        "          TS: ${{ needs.ts.result }}\n          TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
      ),
    "must not touch a secret",
  ],
  [
    "permissions widened",
    (t) => t.replace("    permissions: {}\n", "    permissions:\n      contents: write\n"),
    "permissions: {}",
  ],
  [
    "permissions removed (the job would inherit contents: read)",
    (t) => t.replace("    permissions: {}\n", ""),
    "permissions: {}",
  ],
  ["no timeout", (t) => t.replace("    timeout-minutes: 5\n", ""), "timeout-minutes"],
  [
    "a long timeout",
    (t) => t.replace("    timeout-minutes: 5\n", "    timeout-minutes: 360\n"),
    "timeout-minutes",
  ],
  ["the check renamed", (t) => t.replace("    name: verify\n", "    name: CI\n"), "named verify"],
  [
    "another job named verify",
    (t) => t.replace("    name: Secret scan\n", "    name: verify\n"),
    "only the verify job may be named verify",
  ],
  [
    "a new job that verify does not need",
    (t) =>
      t.replace(
        "\n  verify:\n",
        "\n  docs:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo docs\n\n  verify:\n",
      ),
    "needs: must list every other job",
  ],
  [
    "a job after verify",
    (t) => `${t}\n  late:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo late\n`,
    "verify must be the last job",
  ],
  // The gates and the explainer
  [
    "pipefail dropped from a gate",
    (t) =>
      t.replace(
        "          set -o pipefail\n          pnpm run verify:ts 2>&1",
        "          pnpm run verify:ts 2>&1",
      ),
    "ts: gate 2 must be a named step that runs exactly",
  ],
  [
    "a gate that tees outside $RUNNER_TEMP",
    (t) => t.replace('| tee "$RUNNER_TEMP/gate-2-clippy.log"', "| tee gate-2-clippy.log"),
    "rust-unit: gate 2",
  ],
  [
    "|| true after a gate",
    (t) =>
      t.replace(
        'tee "$RUNNER_TEMP/gate-3-verify-launch.log"\n',
        'tee "$RUNNER_TEMP/gate-3-verify-launch.log" || true\n',
      ),
    "ts: gate 3",
  ],
  [
    "a gate dropped",
    (t) =>
      t.replace(
        '      - name: Launch checks (pnpm verify:launch)\n        run: |\n          set -o pipefail\n          pnpm verify:launch 2>&1 | tee "$RUNNER_TEMP/gate-3-verify-launch.log"\n',
        "",
      ),
    "ts: gate",
  ],
  [
    "gate logs numbered out of order",
    (t) => t.replace("gate-1-fmt.log", "gate-4-fmt.log"),
    "rust-unit: gate 1",
  ],
  [
    "the explainer without if: failure()",
    (t) =>
      t.replace(
        "        if: failure()\n        run: node scripts/ci-failure-note.mjs rust-unit",
        "        run: node scripts/ci-failure-note.mjs rust-unit",
      ),
    "rust-unit: the last step must be the failure explainer",
  ],
  [
    "the explainer on if: always()",
    (t) =>
      t.replace(
        "        if: failure()\n        run: node scripts/ci-failure-note.mjs ts",
        "        if: always()\n        run: node scripts/ci-failure-note.mjs ts",
      ),
    "ts: only the explainer may have an if:",
  ],
  [
    "a step after the explainer",
    (t) =>
      t.replace(
        "        run: node scripts/ci-failure-note.mjs sandbox\n",
        "        run: node scripts/ci-failure-note.mjs sandbox\n      - run: echo after\n",
      ),
    "sandbox: the last step must be the failure explainer",
  ],
  [
    "the explainer removed",
    (t) =>
      t.replace(
        "      - name: Explain the failure\n        if: failure()\n        run: node scripts/ci-failure-note.mjs sandbox\n",
        "",
      ),
    "sandbox: the last step must be the failure explainer",
  ],
  [
    "continue-on-error on a gate",
    (t) =>
      t.replace(
        "      - name: Unit and property tests (cargo test)\n",
        "      - name: Unit and property tests (cargo test)\n        continue-on-error: true\n",
      ),
    "rust-unit: continue-on-error is not allowed",
  ],
  [
    "a secret in an explained job",
    (t) =>
      t.replace(
        "      - name: Install (pnpm install --frozen-lockfile)\n",
        "      - name: Install (pnpm install --frozen-lockfile)\n        env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n",
      ),
    "ts: the explainer posts this job's log, so the job must use no secret",
  ],
];

for (const [name, mutate, expected] of ciMutations) {
  test(`ci.yml check refuses: ${name}`, () => {
    const mutated = mutate(ci);
    assert.notEqual(mutated, ci, `the mutation "${name}" changed nothing`);
    const problems = ciProblems(mutated);
    assert.ok(
      problems.some((p) => p.includes(expected)),
      `"${name}" was not refused for "${expected}": ${problems.join(" | ") || "accepted"}`,
    );
  });
}

test("ci.yml: a CRLF copy has the same shape, and every mutant is still refused", () => {
  const crlf = (text) => text.replace(/\n/g, "\r\n");
  assert.deepEqual(ciProblems(crlf(ci)), []);
  for (const [name, mutate, expected] of ciMutations) {
    const mutated = crlf(mutate(ci));
    const problems = ciProblems(mutated);
    assert.ok(
      problems.some((p) => p.includes(expected)),
      `CRLF copy of "${name}" not refused for "${expected}": ${problems.join(" | ")}`,
    );
  }
});

// biome-ignore-end lint/suspicious/noTemplateCurlyInString: see biome-ignore-start above
