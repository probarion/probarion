// Tests for scripts/judge.mjs: the table logic (expectations, skips, exit codes, the report), run with a fake
// exec and a fake fetch, so nothing here builds, spawns a step or touches the network; and the pins that keep
// the judge in step with README.md, docs/evidence and the workflow.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALL_PASS,
  CHECK_IDS,
  childEnv,
  compareCommitted,
  compareLines,
  countResults,
  evidenceSnapshots,
  exitCodeOf,
  LIVE_VAULTS,
  ledgerPrefix,
  locate,
  looksLikeNetworkError,
  matchVerify,
  parseArgs,
  parseVerifyText,
  planSteps,
  pnpmLauncher,
  readmeCliRuns,
  readmeExample,
  renderRow,
  runJudge,
  SNAPSHOTS,
  withOutDir,
} from "./judge.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const README = read("README.md");

// ---------------------------------------------------------------------------------------------
// A fake world: each command answers as the README says it does, unless a test overrides it

const report = (expect, { entries = 3, anchors = 2 } = {}) => ({
  ok: expect.exit === 0,
  entries,
  anchors,
  checks: CHECK_IDS.map((id) => ({
    id,
    name: `check-${id}`,
    status: expect.checks[id],
    detail: expect.why?.[id] ?? "fine",
  })),
});
const answer = (code, stdout, stderr = "") => ({
  code,
  stdout,
  stderr,
  all: `${stdout}${stderr}`,
  timedOut: false,
  ms: 1,
});

/** What each command prints when every claim holds. `overrides` maps a part of the command line to an answer. */
function fakeExec(calls, overrides = {}) {
  const examples = ["Watch the verifier catch a one-field edit.", "Ask the vault itself."].map(
    (m) => readmeExample(README, m),
  );
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env, shell: opts.shell });
    const line = args.join(" ");
    for (const [part, fn] of Object.entries(overrides)) if (line.includes(part)) return fn(args);
    if (line.includes("run build")) return answer(0, "packages/core build: Done\n");
    if (line.includes("check-claims.mjs --online")) {
      return answer(
        0,
        "check-claims: ok. 1 links (0 anchors), 41 online checks (offline and online)\n",
      );
    }
    if (line.includes("check-claims.mjs"))
      return answer(0, "check-claims: ok. 1 links (offline)\n");
    if (args[0] === "--input-type=module") {
      const ex = examples.find((e) => e.script === args[2]);
      return ex ? answer(0, `${ex.output.join("\n")}\n`) : answer(1, "", "unknown snippet\n");
    }
    if (args.includes("verify")) {
      const offline = args[args.indexOf("--offline") + 1];
      const s = SNAPSHOTS.find((x) => x.file === offline);
      if (s) {
        const was = s.committed ? parseVerifyText(read(s.committed)) : { entries: 5, anchors: 3 };
        return answer(s.expect.exit, JSON.stringify(report(s.expect, was)));
      }
      const vault = args[args.indexOf("--vault") + 1];
      const expect = vault.startsWith("v0.")
        ? LIVE_VAULTS.v0
        : vault.startsWith("canary.")
          ? LIVE_VAULTS.canary
          : LIVE_VAULTS.demo;
      return answer(expect.exit, JSON.stringify(report(expect)));
    }
    if (args[1] === "mandate") {
      if (args.includes("base:0x1234")) {
        return answer(1, "", "error: --payee base:0x1234 is not a 0x-prefixed 20-byte address\n");
      }
      return answer(
        0,
        "OWNER SIGNS: probarion never signs owner or approver transactions.\n\nnear contract call-function as-transaction v0.probarion.testnet create_mandate file-args '/tmp/a.args.json' prepaid-gas '100.0 Tgas'\n",
      );
    }
    if (line.includes("example-402 run demo")) {
      return answer(
        0,
        "All three calls ended as expected.\nDemo finished in 1.0 s (limit 120 s).\n",
      );
    }
    if (line.includes("eval:check")) {
      return answer(
        0,
        "eval:check passed: the dataset and the results match the committed files\n",
      );
    }
    if (line.endsWith("bin.js demo")) {
      return answer(0, "Done: 6 steps, 6 as expected. Nothing was signed or sent.\n");
    }
    if (line.includes("run test")) {
      return answer(0, " Test Files  2 passed (2)\n      Tests  12 passed (12)\n");
    }
    return answer(127, "", `no fake for ${line}\n`);
  };
}

const committedLedger = read("docs/evidence/demo-vault/ledger-2026-11-09.jsonl");

/** RPC answers ok, the proof page serves the committed ledger. `fail` makes every request fail. */
function fakeFetch(seen, { fail = false } = {}) {
  return async (url) => {
    seen.push(url);
    if (fail) throw new TypeError("fetch failed");
    if (String(url).endsWith("ledger.jsonl")) {
      return { ok: true, status: 200, text: async () => committedLedger };
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };
}

const temps = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** Runs the judge in the fake world and returns its exit code, the report, the calls and what it printed. */
async function judge(argv, { overrides, env = {}, fetchFails = false, readFile } = {}) {
  const calls = [];
  const fetched = [];
  const printed = [];
  let written = null;
  const tmp = mkdtempSync(join(tmpdir(), "probarion-judge-test-"));
  temps.push(tmp);
  const code = await runJudge(argv, {
    env: { PATH: process.env.PATH ?? "", ...env },
    exec: fakeExec(calls, overrides),
    fetch: fakeFetch(fetched, { fail: fetchFails }),
    git: () => ({ commit: "f".repeat(40), dirty: false }),
    exists: () => true,
    readFile,
    tmp,
    out: (s) => printed.push(s),
    err: (s) => printed.push(s),
    writeLog: () => {},
    writeReport: (r) => {
      written = r;
    },
  });
  return { code, report: written, calls, fetched, printed: printed.join("") };
}

const row = (r, id) => r.report.steps.find((s) => s.id === id);

// ---------------------------------------------------------------------------------------------

describe("a run", () => {
  test("every claim as the README says: each step meets its expectation and the run exits 0", async () => {
    const r = await judge([]);
    assert.equal(r.code, 0);
    for (const s of r.report.steps) {
      assert.equal(s.result, s.expected, `${s.id}: ${s.result} (${s.detail})`);
    }
    assert.deepEqual(
      r.report.steps.filter((s) => s.result === "EXPECTED-FAIL").map((s) => s.id),
      ["verify-canary-snapshot", "live-verify-v0", "live-verify-canary"],
    );
    assert.equal(r.report.counts.FAIL, 0);
    assert.match(r.printed, /judge: \d+ PASS, 3 EXPECTED-FAIL, 2 SKIPPED, 0 FAIL in /);
  });

  test("--offline: every live step is SKIPPED, and nothing reaches the network", async () => {
    const r = await judge(["--offline"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.fetched, [], "no fetch at all, not even the network probe");
    const live = planSteps(ROOT).filter((s) => s.kind === "live");
    assert.ok(live.length >= 6);
    for (const s of live) {
      const got = row(r, s.id);
      assert.equal(got.result, "SKIPPED", s.id);
      assert.match(got.detail, /^--offline/);
    }
    const lines = r.calls.map((c) => c.args.join(" "));
    assert.ok(!lines.some((l) => /--online|--network|bin\.js demo$/.test(l)), lines.join("\n"));
    assert.equal(r.report.flags.offline, true);
  });

  test("the network down: the live steps are SKIPPED with the reason, the offline ones still run", async () => {
    const r = await judge([], { fetchFails: true });
    assert.equal(r.code, 0);
    assert.equal(row(r, "mcp-demo").result, "SKIPPED");
    assert.match(row(r, "mcp-demo").detail, /the network is down \(.*fetch failed\)/);
    assert.equal(row(r, "verify-demo-snapshot").result, "PASS");
  });

  test("--quick: the package test suites are SKIPPED with the command that runs each", async () => {
    const r = await judge(["--quick", "--offline"]);
    const tests = r.report.steps.filter((s) => s.id.startsWith("test-") && s.id !== "test-rust");
    assert.equal(tests.length, 6);
    for (const s of tests) assert.equal(s.result, "SKIPPED", s.id);
    assert.match(
      row(r, "test-packages-sdk").detail,
      /--quick: not run; run `pnpm --filter @probarion\/sdk run test`/,
    );
    assert.ok(!r.calls.some((c) => c.args.includes("test")));
  });

  test("an expected failure that starts to pass is a FAIL, and the run exits 1", async () => {
    const r = await judge(["--offline"], {
      overrides: {
        "canary-vault/snapshot": () =>
          answer(0, JSON.stringify(report({ exit: 0, checks: ALL_PASS }))),
      },
    });
    assert.equal(r.code, 1);
    assert.equal(r.report.ok, false);
    assert.equal(row(r, "verify-canary-snapshot").result, "FAIL");
    assert.match(row(r, "verify-canary-snapshot").detail, /check c is pass, expected fail/);
  });

  test("a step that fails exits 1, and a step that needs the build is SKIPPED when the build fails", async () => {
    const r = await judge(["--offline", "--quick"], {
      overrides: { "run build": () => answer(1, "", "error TS2304: Cannot find name 'x'.\n") },
    });
    assert.equal(r.code, 1);
    assert.equal(row(r, "build").result, "FAIL");
    assert.equal(row(r, "verify-demo-snapshot").result, "SKIPPED");
    assert.match(row(r, "verify-demo-snapshot").detail, /the build step failed/);
    assert.equal(row(r, "check-claims").result, "PASS", "the claims check needs no build");
  });

  test("a README line the step quotes is gone: that step FAILs, whatever it printed", async () => {
    const quote = "reruns the 20-invoice eval offline";
    const r = await judge(["--offline", "--quick"], {
      readFile: (rel) => {
        const text = read(rel);
        return rel === "README.md" ? text.replace(quote, "reruns an eval") : text;
      },
    });
    assert.equal(row(r, "eval-check").result, "FAIL");
    assert.equal(row(r, "eval-check").readme_ref.line, null);
    assert.match(
      row(r, "eval-check").detail,
      /no longer says "reruns the 20-invoice eval offline"/,
    );
    assert.equal(r.code, 1);
  });

  test("the live ledger must start with the committed one", async () => {
    const r = await judge([], {
      overrides: {},
    });
    assert.match(
      row(r, "live-verify-demo-vault").detail,
      /its first 7 entries are the committed ledger's/,
    );
  });

  test("a live step that meets the network midway is SKIPPED, not FAIL", async () => {
    const r = await judge([], {
      overrides: { "bin.js demo": () => answer(1, "", "probarion-mcp demo: fetch failed\n") },
    });
    assert.equal(row(r, "mcp-demo").result, "SKIPPED");
    assert.equal(r.code, 0);
  });

  test("check-claims --online exit 2 (an endpoint did not answer) is SKIPPED, exit 1 is FAIL", async () => {
    const two = await judge([], {
      overrides: {
        "--online": () =>
          answer(
            2,
            "unchecked [online] chromewebstore.google.com: HTTP 503\ncheck-claims: 1 online check(s) could not run\n",
          ),
      },
    });
    assert.equal(row(two, "check-claims-online").result, "SKIPPED");
    assert.match(row(two, "check-claims-online").detail, /1 online check\(s\) could not run/);
    const one = await judge([], {
      overrides: {
        "--online": () =>
          answer(
            1,
            "README.md:476 [online] spend_paid not in the tx\ncheck-claims: 1 claim(s) do not match\n",
          ),
      },
    });
    assert.equal(row(one, "check-claims-online").result, "FAIL");
    assert.equal(one.code, 1);
  });

  test("the report: one entry per step with the claim, README line, command, result, expectation, ms and detail", async () => {
    const r = await judge(["--offline", "--quick"]);
    const rep = r.report;
    for (const key of [
      "commit",
      "dirty",
      "node",
      "os",
      "flags",
      "started_at",
      "ms",
      "ok",
      "exit_code",
      "counts",
      "steps",
    ]) {
      assert.ok(key in rep, key);
    }
    assert.equal(rep.commit, "f".repeat(40));
    assert.equal(rep.node, process.version);
    assert.equal(typeof rep.os.platform, "string");
    assert.equal(rep.steps.length, planSteps(ROOT).length);
    for (const s of rep.steps) {
      for (const key of ["claim", "readme_ref", "command", "result", "expected", "ms", "detail"]) {
        assert.ok(key in s, `${s.id}: ${key}`);
      }
      assert.ok(["PASS", "EXPECTED-FAIL", "SKIPPED", "FAIL"].includes(s.result), s.id);
      assert.ok(["PASS", "EXPECTED-FAIL", "SKIPPED"].includes(s.expected), s.id);
      assert.equal(typeof s.readme_ref.file, "string");
      assert.ok(Number.isInteger(s.readme_ref.line), `${s.id}: ${s.readme_ref.quote}`);
      assert.equal(typeof s.ms, "number");
    }
    assert.deepEqual(rep.counts, countResults(rep.steps));
  });

  test("--json prints the report on stdout and the table elsewhere", async () => {
    const out = [];
    const err = [];
    const tmp = mkdtempSync(join(tmpdir(), "probarion-judge-test-"));
    temps.push(tmp);
    const code = await runJudge(["--json", "--offline", "--quick"], {
      env: {},
      exec: fakeExec([]),
      fetch: fakeFetch([]),
      git: () => ({ commit: null, dirty: null }),
      exists: () => true,
      tmp,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeLog: () => {},
      writeReport: () => {},
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(out.join(""));
    assert.equal(parsed.exit_code, 0);
    assert.match(err.join(""), /RESULT/);
  });
});

describe("safety", () => {
  test("no child process gets a key or a secret, and colours are off", async () => {
    const env = {
      PROBARION_AGENT_KEY: "ed25519:secret",
      PROBARION_LEDGER_KEY: "ed25519:secret",
      PROBARION_VAULT_ID: "x.testnet",
      NEARAI_API_KEY: "sk",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      KEY_ENCRYPTION_SECRET: "s",
      GITHUB_TOKEN: "t",
      FORCE_COLOR: "1",
    };
    const r = await judge([], { env });
    assert.ok(r.calls.length > 10);
    for (const c of r.calls) {
      for (const name of Object.keys(env))
        assert.ok(!(name in c.env), `${name} reached ${c.args.join(" ")}`);
      assert.equal(c.env.NO_COLOR, "1");
      assert.equal(c.env.PATH, process.env.PATH ?? "");
    }
  });

  test("it runs only read-only commands: never pnpm verify, verify:ts, the root test, a publish or a deploy", async () => {
    const r = await judge([]);
    for (const c of r.calls) {
      const words = c.args.filter((a) => !/pnpm\.c?js$/i.test(a));
      if (/node(\.exe)?$/i.test(c.cmd) && !/pnpm/i.test(c.args[0] ?? "")) {
        assert.ok(
          [
            "packages/cli/dist/bin.js",
            "packages/mcp/dist/bin.js",
            "scripts/check-claims.mjs",
            "--input-type=module",
          ].includes(words[0]),
          `node ${words.join(" ")}`,
        );
        if (words[0] === "packages/cli/dist/bin.js") {
          assert.ok(["verify", "mandate"].includes(words[1]), words.join(" "));
          if (words[1] === "mandate") {
            // The owner transaction printer: its args file goes to the temp folder, never the clone.
            assert.equal(words.filter((w) => w === "--out-dir").length, 1);
            assert.ok(words.at(-1).includes("probarion-judge-test-"), words.at(-1));
          }
        }
        continue;
      }
      const ok =
        (words[0] === "--filter" &&
          words[2] === "run" &&
          ["build", "demo", "test"].includes(words[3])) ||
        (words.length === 1 && words[0] === "eval:check");
      assert.ok(ok, `pnpm ${words.join(" ")}`);
      assert.ok(
        !words.some((w) => /^(verify(:\w+)?|publish|deploy|release:check)$/.test(w)),
        words.join(" "),
      );
    }
    // The vitest runs are per package, never the root `pnpm test`, and never apps/web.
    const filtered = r.calls
      .filter((c) => c.args.includes("test"))
      .map((c) => c.args[c.args.indexOf("--filter") + 1]);
    assert.deepEqual(filtered.sort(), [
      "@probarion/core",
      "@probarion/example-402",
      "@probarion/mcp",
      "@probarion/sdk",
      "probarion",
    ]);
  });

  test("the live verifies read the chain with an empty or downloaded ledger, and send nothing", async () => {
    const r = await judge([]);
    const live = r.calls.filter((c) => c.args.includes("--network"));
    assert.equal(live.length, 3);
    for (const c of live) {
      assert.equal(c.args[c.args.indexOf("--network") + 1], "testnet");
      assert.ok(c.args.includes("--ledger"));
    }
  });
});

describe("matchVerify", () => {
  const canary = SNAPSHOTS.find((s) => s.id === "verify-canary-snapshot").expect;
  const pass = SNAPSHOTS.find((s) => s.id === "verify-demo-snapshot").expect;
  const run = (expect, code = expect.exit) => ({ code, report: report(expect), stderr: "" });

  test("PASS when PASS is expected and every check passes", () => {
    assert.equal(matchVerify(pass, run(pass)).result, "PASS");
  });

  test("EXPECTED-FAIL when the Canary fails c for its reason and only c", () => {
    const v = matchVerify(canary, run(canary));
    assert.equal(v.result, "EXPECTED-FAIL");
    assert.match(v.detail, /^fails exactly as the README says: c \(the ledger has 0\)/);
  });

  test("FAIL when an expected failure suddenly passes", () => {
    const v = matchVerify(canary, run({ exit: 0, checks: ALL_PASS }));
    assert.equal(v.result, "FAIL");
    assert.match(v.detail, /check c is pass, expected fail; exit code 0, expected 1/);
  });

  test("FAIL when it fails differently: another check fails too", () => {
    const v = matchVerify(canary, run({ exit: 1, checks: { ...canary.checks, d: "fail" } }));
    assert.equal(v.result, "FAIL");
    assert.match(v.detail, /check d is fail, expected pass/);
  });

  test("FAIL when the right check fails for another reason", () => {
    const other = { ...canary, why: { c: "anchor 2 does not match" } };
    const v = matchVerify(canary, run(other));
    assert.equal(v.result, "FAIL");
    assert.match(v.detail, /check c is fail for another reason: anchor 2 does not match/);
  });

  test("FAIL on another exit code, on an unknown check, and when verify printed no report", () => {
    assert.match(matchVerify(pass, run(pass, 2)).detail, /exit code 2, expected 0/);
    const extra = run(pass);
    extra.report.checks.push({ id: "j", status: "pass", detail: "" });
    assert.match(matchVerify(pass, extra).detail, /check j \(pass\) is not in the expectation/);
    const none = matchVerify(pass, {
      code: 64,
      report: null,
      stderr: "error: --offline x is not JSON\n",
    });
    assert.deepEqual(none, {
      result: "FAIL",
      detail: "verify printed no report (exit 64): error: --offline x is not JSON",
    });
  });

  test("the v0 and Canary live expectations are failures with their README reasons", () => {
    assert.equal(LIVE_VAULTS.v0.exit, 1);
    assert.deepEqual(
      CHECK_IDS.filter((id) => LIVE_VAULTS.v0.checks[id] === "fail"),
      ["d", "h"],
    );
    assert.deepEqual(
      CHECK_IDS.filter((id) => LIVE_VAULTS.canary.checks[id] === "fail"),
      ["c"],
    );
  });
});

describe("the committed live runs", () => {
  test("parseVerifyText reads each check and the counts of a committed output", () => {
    const got = parseVerifyText(read("docs/evidence/canary-vault/verify-2026-11-10.txt"));
    assert.deepEqual(got, { checks: { ...ALL_PASS, c: "fail" }, entries: 0, anchors: 4 });
  });

  test("compareCommitted names each check and count that differs, and nothing when all agree", () => {
    const text = read("docs/evidence/demo-vault/verify-2026-11-09.txt");
    const same = report({ exit: 0, checks: ALL_PASS }, { entries: 7, anchors: 5 });
    assert.deepEqual(compareCommitted(same, text), []);
    const other = report(
      { exit: 1, checks: { ...ALL_PASS, b: "fail" } },
      { entries: 8, anchors: 5 },
    );
    assert.deepEqual(compareCommitted(other, text), [
      "check b is fail offline, pass live",
      "entries 8, anchors 5 offline; entries 7, anchors 5 live",
    ]);
  });

  test("ledgerPrefix: the committed ledger is the start of the live one, link for link", () => {
    const lines = committedLedger.trim().split("\n");
    assert.equal(ledgerPrefix(committedLedger, `${committedLedger}${lines[0]}\n`).ok, true);
    assert.match(
      ledgerPrefix(committedLedger, lines.slice(0, 3).join("\n")).detail,
      /has 3 entries, fewer than the committed 7/,
    );
    const edited = [...lines];
    edited[2] = edited[2].replace(/"link":"[0-9a-f]/, '"link":"z');
    assert.match(
      ledgerPrefix(committedLedger, edited.join("\n")).detail,
      /entry 2 of the committed ledger differs/,
    );
    assert.match(
      ledgerPrefix(committedLedger, "<html>").detail,
      /the live ledger is not a JSON Lines ledger/,
    );
  });
});

describe("README references", () => {
  test("every step quotes a line its file still has", () => {
    for (const s of planSteps(ROOT)) {
      assert.ok(
        locate(read(s.ref.file), s.ref.quote),
        `${s.id}: ${s.ref.file} has no "${s.ref.quote}"`,
      );
    }
  });

  test("every committed snapshot under docs/evidence has its expectation written in judge.mjs", () => {
    const listed = SNAPSHOTS.map((s) => s.file);
    for (const f of evidenceSnapshots(ROOT))
      assert.ok(listed.includes(f), `${f}: add it to SNAPSHOTS`);
    for (const s of SNAPSHOTS.filter((x) => x.committed))
      assert.ok(read(s.committed).includes("RESULT:"), s.committed);
  });

  test("locate finds a quote across a line break and gives its first line; null when it is gone", () => {
    assert.equal(locate("one\ntwo three\n   four five", "three four"), 2);
    assert.equal(locate("one two", "two three"), null);
    assert.equal(locate(null, "x"), null);
  });

  test("readmeExample takes the README's step 2 and step 4 snippets and the output each shows", () => {
    const two = readmeExample(README, "Watch the verifier catch a one-field edit.");
    assert.match(two.script, /^import \{ readFileSync \} from "node:fs";/);
    assert.equal(
      two.output[0],
      "as recorded: true a pass, b pass, c pass, d pass, e pass, f pass, g pass, h pass, i pass",
    );
    assert.equal(two.output[1], "after one edit: false first broken entry: 2");
    const four = readmeExample(README, "Ask the vault itself.");
    assert.match(
      four.script,
      /new Probarion\(\{ network: "testnet", vault: "v0\.probarion\.testnet", model: null \}\)/,
    );
    assert.equal(
      four.output.at(-1),
      "6 USDC: { ok: false, code: 'OverPerPayment', would_hold: false }",
    );
    assert.ok(!four.script.includes("'"), "a single quote would end the shell's -e argument");
  });

  test("readmeExample says what is missing", () => {
    assert.match(readmeExample("no steps", "Ask the vault itself.").problem, /has no step/);
    const noText = "**Step.**\n\n```bash\nnode --input-type=module -e '\nconsole.log(1)\n'\n```\n";
    assert.match(readmeExample(noText, "Step.").problem, /shows no snippet and output/);
    const notNode = "**Step.**\n\n```bash\nls\n```\n";
    assert.match(readmeExample(notNode, "Step.").problem, /is not a node -e snippet/);
  });

  test("readmeCliRuns takes step 6's two CLI commands, joined over their line breaks, and the error the README shows", () => {
    const got = readmeCliRuns(README, "Print an owner transaction without signing it.");
    assert.equal(got.runs.length, 2);
    const [good, bad] = got.runs;
    assert.deepEqual(good.args.slice(0, 4), [
      "packages/cli/dist/bin.js",
      "mandate",
      "create",
      "--vault",
    ]);
    assert.ok(good.args.includes("Contractor"), "the quoted label is one word");
    assert.equal(good.error, null);
    assert.ok(bad.args.includes("base:0x1234"));
    assert.equal(bad.error, "error: --payee base:0x1234 is not a 0x-prefixed 20-byte address");
    assert.match(
      README.split("\n")[good.line - 1],
      /^\s+node packages\/cli\/dist\/bin\.js mandate create/,
    );
    const other =
      "**Step.**\n\n```bash\nnode packages/cli/dist/bin.js vault withdraw --to x\n```\n";
    assert.match(
      readmeCliRuns(other, "Step.").problem,
      /is not a `node packages\/cli\/dist\/bin\.js mandate` command/,
    );
  });

  test("withOutDir puts the args file in the given folder, whatever the README's command says", () => {
    assert.deepEqual(
      withOutDir(["mandate", "create", "--out-dir", "probarion-tx", "--label", "x"], "/t"),
      ["mandate", "create", "--label", "x", "--out-dir", "/t"],
    );
    assert.deepEqual(withOutDir(["a", "--out-dir=here"], "/t"), ["a", "--out-dir", "/t"]);
  });

  test("compareLines: exact, then the first line that differs", () => {
    assert.deepEqual(compareLines("a\r\nb  \n\n", ["a", "b"]), { same: true });
    assert.equal(
      compareLines("a\nc\n", ["a", "b"]).detail,
      'line 2: printed "c", README.md shows "b"',
    );
    assert.equal(
      compareLines("a\n", ["a", "b"]).detail,
      'line 2: printed "(nothing)", README.md shows "b"',
    );
  });
});

describe("helpers", () => {
  test("parseArgs takes --offline, --quick, --json and --help, and refuses anything else", () => {
    assert.deepEqual(parseArgs(["--offline", "--quick", "--json"]), {
      offline: true,
      quick: true,
      json: true,
      help: false,
    });
    assert.deepEqual(parseArgs([]), { offline: false, quick: false, json: false, help: false });
    assert.equal(parseArgs(["-h"]).help, true);
    assert.match(parseArgs(["--online"]).problem, /unknown argument "--online"/);
  });

  test("exitCodeOf: 0 unless a step FAILED; SKIPPED and EXPECTED-FAIL are not failures", () => {
    assert.equal(
      exitCodeOf([{ result: "PASS" }, { result: "EXPECTED-FAIL" }, { result: "SKIPPED" }]),
      0,
    );
    assert.equal(exitCodeOf([{ result: "PASS" }, { result: "FAIL" }]), 1);
    assert.equal(exitCodeOf([]), 0);
  });

  test("childEnv drops every name that looks like a key and keeps the rest", () => {
    const env = childEnv({
      PATH: "/bin",
      HOME: "/h",
      PROBARION_LEDGER_PATH: "x",
      NEAR_RPC_URLS: "u",
      npm_token: "t",
      Force_Color: "1",
    });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/h", NEAR_RPC_URLS: "u", NO_COLOR: "1" });
  });

  test("looksLikeNetworkError knows a network failure from a wrong answer", () => {
    assert.ok(looksLikeNetworkError("TypeError: fetch failed"));
    assert.ok(looksLikeNetworkError("error: connect ETIMEDOUT 1.2.3.4:443"));
    assert.ok(looksLikeNetworkError("RPC answered HTTP 503"));
    assert.ok(!looksLikeNetworkError("check d is fail, expected pass"));
  });

  test("pnpmLauncher runs the pnpm that runs the judge, else pnpm from PATH (through cmd.exe on Windows)", () => {
    assert.deepEqual(pnpmLauncher({ npm_execpath: "/x/pnpm/bin/pnpm.cjs" }, "linux"), {
      cmd: process.execPath,
      pre: ["/x/pnpm/bin/pnpm.cjs"],
      shell: false,
    });
    assert.deepEqual(pnpmLauncher({ npm_execpath: "C:\\pnpm\\pnpm.exe" }, "win32"), {
      cmd: "C:\\pnpm\\pnpm.exe",
      pre: [],
      shell: false,
    });
    assert.deepEqual(pnpmLauncher({}, "win32"), { cmd: "pnpm", pre: [], shell: true });
    assert.deepEqual(pnpmLauncher({ npm_execpath: "/usr/lib/npm/bin/npm-cli.js" }, "linux"), {
      cmd: "pnpm",
      pre: [],
      shell: false,
    });
  });

  test("renderRow: the number, result, time and claim with its README line, the detail below", () => {
    const text = renderRow({
      n: 8,
      claim: "verify --offline: Canary snapshot fails c only, by design",
      readme_ref: { file: "README.md", line: 564, quote: "q" },
      result: "EXPECTED-FAIL",
      ms: 2953,
      detail: "fails exactly as the README says",
    });
    assert.equal(
      text,
      "  8  EXPECTED-FAIL     2953 ms  verify --offline: Canary snapshot fails c only, by design  [README.md:564]\n       fails exactly as the README says\n",
    );
  });

  test("the command line: exit 2 and the usage on an unknown flag, 0 on --help", () => {
    const bad = spawnSync(process.execPath, [join(ROOT, "scripts/judge.mjs"), "--nope"], {
      encoding: "utf8",
    });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown argument "--nope"/);
    const help = spawnSync(process.execPath, [join(ROOT, "scripts/judge.mjs"), "--help"], {
      encoding: "utf8",
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: pnpm judge \[--offline\] \[--quick\] \[--json\]/);
  });
});

describe("the workflow", () => {
  const ci = read(".github/workflows/ci.yml");
  const wf = read(".github/workflows/judge.yml");
  const pins = (text) =>
    [...text.matchAll(/uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # \S+/g)].map((m) => [m[1], m[2]]);

  test("judge.yml pins every action by the full SHA ci.yml uses", () => {
    const ciPins = new Map(pins(ci));
    const uses = wf.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
    assert.ok(uses.length >= 3);
    for (const line of uses)
      assert.match(line, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # \S+/, line.trim());
    for (const [action, sha] of pins(wf))
      assert.equal(sha, ciPins.get(action), `${action} is at another SHA than in ci.yml`);
  });

  test("judge.yml reads only, runs daily and on pushes to main, and runs pnpm judge --offline --quick", () => {
    assert.match(wf, /^permissions:\n {2}contents: read\n/m);
    assert.ok(!/write/.test(wf.split("\njobs:")[0]), "no write permission");
    assert.match(wf, /^ {2}push:\n {4}branches: \[main\]\n/m);
    assert.match(wf, /^ {2}schedule:\n {4}- cron: "[^"]+"\n/m);
    assert.match(wf, /run: pnpm judge --offline --quick\n/);
    assert.match(wf, /run: pnpm install --frozen-lockfile\n/);
    assert.ok(!/secrets\./.test(wf), "the judge needs no secret");
  });
});
