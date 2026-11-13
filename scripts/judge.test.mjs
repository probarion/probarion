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
  A8_RUN,
  ALL_PASS,
  a8Passes,
  CHECK_IDS,
  childEnv,
  compareCommitted,
  compareLines,
  countResults,
  demoCounts,
  downloadOutcome,
  evidenceSnapshots,
  exitCodeOf,
  LIVE_VAULTS,
  ledgerPrefix,
  locate,
  looksLikeNetworkError,
  MAINNET_V0_INVOICES,
  MAINNET_V0_LEDGER,
  matchA8,
  matchVerify,
  parseArgs,
  parseVerifyText,
  passedOf,
  planSteps,
  pnpmLauncher,
  readmeCliRuns,
  readmeCountNote,
  readmeExample,
  renderRow,
  runJudge,
  SNAPSHOTS,
  SNIPPET_IMPORTS,
  snippetProblem,
  testFileResult,
  withCommand,
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

/**
 * The A8 run's report as the CLI prints it with --json: check e's detail, and the invoice files with the attested
 * decisions A8 checks them against (`seqs`), plus one file that matches no entry.
 */
function a8Report({
  detail = `5 attested decisions pass A1–A7; ${a8Passes(A8_RUN.seqs)}`,
  seqs = A8_RUN.seqs,
} = {}) {
  const r = report({ exit: 0, checks: ALL_PASS }, parseVerifyText(read(A8_RUN.committed)));
  r.checks = r.checks.map((c) => (c.id === "e" ? { ...c, detail } : c));
  r.invoices = [
    ...seqs.map((seq) => ({
      file: `docs/evidence/demo-vault/invoice-${seq}.txt`,
      sha256: "0".repeat(64),
      seqs: [seq],
      attested_seqs: [seq],
    })),
    {
      file: "docs/evidence/demo-vault/po-PO-1001.txt",
      sha256: "1".repeat(64),
      seqs: [],
      attested_seqs: [],
    },
  ];
  return r;
}

// The marks vitest prints before a test: passed, skipped, todo, failed.
const [OK, SKIP, TODO, FAILED] = [0x2713, 0x2193, 0x25a1, 0xd7].map((c) => String.fromCharCode(c));

/** The examples/402 suite under the verbose reporter, as vitest 4 prints it: one line per test, then the summary. */
const PAY_PER_CALL_RUN = [
  " RUN  v4.1.12 examples/402",
  "",
  ` ${OK} test/paywall.test.ts > the quote > round-trips 5ms`,
  ` ${OK} test/pay-per-call.test.ts > pay per call under a mandate of 20 uses > pays and serves 20 calls, then refuses the 21st by code, and the contract agrees 2226ms`,
  ` ${OK} test/pay-per-call.test.ts > pay per call under a mandate of 20 uses > a paid spend cannot be shown again for a second call 91ms`,
  "",
  " Test Files  6 passed (6)",
  "      Tests  78 passed (78)",
  "",
].join("\n");

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
    if (args.includes("verify") && args.includes("--offline") && args.includes("--invoices")) {
      return answer(0, JSON.stringify(a8Report()));
    }
    if (args.includes("verify")) {
      const offline = args[args.indexOf("--offline") + 1];
      const s = SNAPSHOTS.find((x) => x.file === offline);
      if (s) {
        const was = s.committed ? parseVerifyText(read(s.committed)) : { entries: 5, anchors: 3 };
        return answer(s.expect.exit, JSON.stringify(report(s.expect, was)));
      }
      const vault = args[args.indexOf("--vault") + 1];
      const expect =
        vault === "v0.probarion.near"
          ? LIVE_VAULTS.mainnetV0
          : vault.startsWith("v0.")
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
    if (line.includes("example-402 run test --reporter=verbose")) {
      return answer(0, PAY_PER_CALL_RUN);
    }
    if (line.includes("run test")) {
      return answer(0, " Test Files  2 passed (2)\n      Tests  12 passed (12)\n");
    }
    return answer(127, "", `no fake for ${line}\n`);
  };
}

const committedLedger = read("docs/evidence/demo-vault/ledger-2026-11-12-video.jsonl");

/**
 * RPC answers ok, the proof page serves the committed ledger. `fail` makes every request fail; `ledger` is what
 * the proof page answers instead: an HTTP status, or "throw" for a network error on that request alone.
 */
function fakeFetch(seen, { fail = false, ledger = 200 } = {}) {
  return async (url) => {
    seen.push(url);
    if (fail) throw new TypeError("fetch failed");
    if (String(url).endsWith("ledger.jsonl")) {
      if (ledger === "throw") throw new TypeError("fetch failed");
      return { ok: ledger === 200, status: ledger, text: async () => committedLedger };
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };
}

const temps = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** Runs the judge in the fake world and returns its exit code, the report, the calls and what it printed. */
async function judge(argv, { overrides, env = {}, fetchFails = false, ledger, readFile } = {}) {
  const calls = [];
  const fetched = [];
  const printed = [];
  let written = null;
  const tmp = mkdtempSync(join(tmpdir(), "probarion-judge-test-"));
  temps.push(tmp);
  const code = await runJudge(argv, {
    env: { PATH: process.env.PATH ?? "", ...env },
    exec: fakeExec(calls, overrides),
    fetch: fakeFetch(fetched, { fail: fetchFails, ledger }),
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
  return { code, report: written, calls, fetched, printed: printed.join(""), tmp };
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
      // The printed row gives the reason and the command that runs the step, whole.
      assert.ok(got.detail.endsWith(`; run \`${s.command}\``), got.detail);
      assert.ok(r.printed.includes(got.detail), `${s.id}: the printed row cuts its command`);
    }
    // Each skip names the network the step reads: mainnet for the mainnet vault, testnet for the rest.
    assert.match(
      row(r, "live-verify-mainnet-v0").detail,
      /^--offline: this step reads NEAR mainnet;/,
    );
    assert.match(
      row(r, "live-verify-demo-vault").detail,
      /^--offline: this step reads NEAR testnet;/,
    );
    const lines = r.calls.map((c) => c.args.join(" "));
    assert.ok(!lines.some((l) => /--online|--network|bin\.js demo$/.test(l)), lines.join("\n"));
    assert.equal(r.report.flags.offline, true);
  });

  test("the network down: the live steps are SKIPPED with the reason, the offline ones still run", async () => {
    const r = await judge([], { fetchFails: true });
    assert.equal(r.code, 0);
    assert.equal(row(r, "mcp-demo").result, "SKIPPED");
    assert.match(
      row(r, "mcp-demo").detail,
      /the network is down \(.*fetch failed\); run `node packages\/mcp\/dist\/bin\.js demo`$/,
    );
    assert.equal(row(r, "verify-demo-snapshot").result, "PASS");
  });

  test("the build row says README step 1's pnpm build, apps/web included, is not what it runs", async () => {
    const r = await judge(["--offline", "--quick"]);
    assert.equal(row(r, "build").result, "PASS");
    assert.match(row(r, "build").detail, /`pnpm build` also builds apps\/web and apps\/extension/);
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
        "canary-vault/snapshot-2026-11-10": () =>
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
      /its first 17 entries are the committed ledger's, link for link \(docs\/evidence\/demo-vault\/ledger-2026-11-12-video\.jsonl\)/,
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

  test("check-claims --online exit 2 from a crash (no unchecked list) is a FAIL with its error, not a network skip", async () => {
    const r = await judge([], {
      overrides: {
        "--online": () =>
          answer(
            2,
            "",
            "check-claims: TypeError: Cannot read properties of undefined (reading 'x')\n    at attempt (file:///scripts/check-claims.mjs:2273:11)\n",
          ),
      },
    });
    assert.equal(row(r, "check-claims-online").result, "FAIL");
    assert.match(
      row(r, "check-claims-online").detail,
      /not a network skip: check-claims: TypeError: Cannot read properties of undefined/,
    );
    assert.equal(r.code, 1);
    // An unchecked list with no summary line, or a summary with no list, is not the "could not run" exit either.
    const half = await judge([], {
      overrides: {
        "--online": () => answer(2, "unchecked [online] npm: HTTP 503\n", "check-claims: boom\n"),
      },
    });
    assert.equal(row(half, "check-claims-online").result, "FAIL");
  });

  test("the proof page answers 404: the live verify of the demo vault is a FAIL that names the URL", async () => {
    const r = await judge([], { ledger: 404 });
    const got = row(r, "live-verify-demo-vault");
    assert.equal(got.result, "FAIL");
    assert.match(
      got.detail,
      /^README\.md:\d+ says to download the ledger from the proof page, but https:\/\/probarion\.xyz\/proof\/demo\.vaults\.probarion\.testnet\/ledger\.jsonl answered HTTP 404/,
    );
    assert.equal(r.code, 1);
    for (const status of [403, 410]) {
      assert.equal(
        row(await judge([], { ledger: status }), "live-verify-demo-vault").result,
        "FAIL",
      );
    }
  });

  test("the proof page answers 503 or 429, or the request fails: that live verify is SKIPPED", async () => {
    for (const ledger of [503, 429, "throw"]) {
      const r = await judge([], { ledger });
      const got = row(r, "live-verify-demo-vault");
      assert.equal(got.result, "SKIPPED", String(ledger));
      assert.match(got.detail, /^could not download https:\/\/probarion\.xyz\/proof\//);
      assert.equal(r.code, 0);
    }
  });

  test("the MCP demo: PASS only when its 6 steps answered as expected or with a note", async () => {
    const demo = (code, stdout) => ({ overrides: { "bin.js demo": () => answer(code, stdout) } });
    const notes = await judge(
      [],
      demo(
        0,
        "  result: note. No paid spend among the vault's first 50\n\n  result: note. The mandate has no use left\n\nDone: 6 steps, 4 as expected, 2 notes. Nothing was signed or sent.\n",
      ),
    );
    assert.equal(row(notes, "mcp-demo").result, "PASS");
    assert.match(
      row(notes, "mcp-demo").detail,
      /4 as expected, 2 notes\. Nothing was signed or sent\. note\. No paid spend among the vault's first 50; note\. The mandate has no use left$/,
    );
    // The verify on the public ledger skipped: exit 0, yet not a PASS.
    const skipped = (why) =>
      `Step 6 of 6. verify\n  ledger: could not download https://probarion.xyz/proof/demo.vaults.probarion.testnet/ledger.jsonl (${why})\n  result: skipped. verify needs the vault's ledger; it was not run\n\nDone: 6 steps, 5 as expected, 1 skipped. Nothing was signed or sent.\n`;
    const down = await judge([], demo(0, skipped("fetch failed")));
    assert.equal(row(down, "mcp-demo").result, "SKIPPED");
    assert.match(row(down, "mcp-demo").detail, /5 as expected, 1 skipped.*\(fetch failed\)/);
    const slow = await judge([], demo(0, skipped("The operation was aborted due to timeout")));
    assert.equal(row(slow, "mcp-demo").result, "SKIPPED");
    const gone = await judge([], demo(0, skipped("HTTP 404")));
    assert.equal(row(gone, "mcp-demo").result, "FAIL");
    assert.match(row(gone, "mcp-demo").detail, /\(HTTP 404\); README\.md:\d+ says the demo runs/);
    assert.equal(gone.code, 1);
    const noMandate = await judge(
      [],
      demo(
        0,
        "  result: note. The vault has no mandate\n  result: skipped. No mandate to dry-run\nDone: 6 steps, 4 as expected, 1 note, 1 skipped. Nothing was signed or sent.\n",
      ),
    );
    assert.equal(row(noMandate, "mcp-demo").result, "FAIL");
    // A network skip of the verify does not cover a second skip for another reason.
    const twoSkips = await judge(
      [],
      demo(
        0,
        "  result: skipped. No mandate to dry-run\n" +
          "  ledger: could not download https://probarion.xyz/proof/demo.vaults.probarion.testnet/ledger.jsonl (fetch failed)\n" +
          "  result: skipped. verify needs the vault's ledger; it was not run\n" +
          "Done: 6 steps, 4 as expected, 2 skipped. Nothing was signed or sent.\n",
      ),
    );
    assert.equal(row(twoSkips, "mcp-demo").result, "FAIL");
    const differs = await judge(
      [],
      demo(
        1,
        "  result: differs. check_spend answered ok for 6 USDC\nDone: 6 steps, 5 as expected, 1 differs. Nothing was signed or sent.\n",
      ),
    );
    assert.equal(row(differs, "mcp-demo").result, "FAIL");
    const fetchFailed = await judge(
      [],
      demo(
        1,
        "  result: failed. list_mandates answered: fetch failed\nDone: 6 steps, 5 as expected, 1 failed. Nothing was signed or sent.\n",
      ),
    );
    assert.equal(row(fetchFailed, "mcp-demo").result, "SKIPPED");
    const short = await judge(
      [],
      demo(0, "Done: 5 steps, 5 as expected. Nothing was signed or sent.\n"),
    );
    assert.equal(row(short, "mcp-demo").result, "FAIL");
  });

  test("the MCP demo runs with an empty home folder in the temp folder, so its server finds no keys file", async () => {
    const r = await judge([], {
      env: { HOME: "/home/someone", USERPROFILE: "C:\\Users\\someone", HOMEPATH: "\\Users\\x" },
    });
    const demo = r.calls.filter((c) => c.args.at(-1) === "demo" && c.args[0].includes("mcp"));
    assert.equal(demo.length, 1);
    const env = demo[0].env;
    assert.equal(env.HOME, join(r.tmp, "empty-home"));
    assert.equal(env.USERPROFILE, join(r.tmp, "empty-home"));
    assert.ok(!("HOMEPATH" in env) && !("HOMEDRIVE" in env));
    assert.equal(env.PATH, process.env.PATH ?? "");
    // The other steps keep the home they were given.
    const other = r.calls.find((c) => c.args[0] === "scripts/check-claims.mjs");
    assert.equal(other.env.HOME, "/home/someone");
  });

  test("examples/402: the row FAILs when test/pay-per-call.test.ts did not run, or a test of it was skipped", async () => {
    const without = PAY_PER_CALL_RUN.split("\n")
      .filter((l) => !l.includes("pay-per-call"))
      .join("\n");
    const gone = await judge([], {
      overrides: { "example-402 run test": () => answer(0, without) },
    });
    assert.equal(row(gone, "test-examples-402").result, "FAIL");
    assert.match(
      row(gone, "test-examples-402").detail,
      /the run lists no test of test\/pay-per-call\.test\.ts/,
    );
    const skipped = PAY_PER_CALL_RUN.replace(
      ` ${OK} test/pay-per-call.test.ts > pay per call under a mandate of 20 uses > a paid`,
      ` ${SKIP} test/pay-per-call.test.ts > pay per call under a mandate of 20 uses > a paid`,
    );
    const skip = await judge([], {
      overrides: { "example-402 run test": () => answer(0, skipped) },
    });
    assert.equal(row(skip, "test-examples-402").result, "FAIL");
    assert.match(row(skip, "test-examples-402").detail, /1 of the 2 tests of .* did not pass/);
    const ok = await judge([]);
    assert.match(
      row(ok, "test-examples-402").detail,
      /test\/pay-per-call\.test\.ts: all 2 of its tests passed, none skipped/,
    );
  });

  test("a package row names the README's dated count next to today's", async () => {
    const r = await judge([], {
      overrides: {
        "@probarion/sdk run test": () =>
          answer(0, " Test Files  40 passed (40)\n      Tests  801 passed | 2 skipped (803)\n"),
        "@probarion/core run test": () =>
          answer(0, " Test Files  40 passed (40)\n      Tests  806 passed (806)\n"),
      },
    });
    assert.equal(row(r, "test-packages-sdk").result, "PASS");
    assert.match(
      row(r, "test-packages-sdk").detail,
      /README\.md:\d+ \(as of 2026-11-09\) gives 782; 801 pass now, so that dated count has drifted$/,
    );
    assert.match(
      row(r, "test-packages-core").detail,
      /806 passed, the count README\.md:\d+ \(as of 2026-11-09\) gives$/,
    );
  });

  test("a README snippet that names a key, or an offline one that reaches the network, FAILs and is not run", async () => {
    const line = "const report = await runChecks(snapshot);";
    assert.ok(README.includes(line));
    const r = await judge(["--offline", "--quick"], {
      readFile: (rel) => {
        const text = read(rel);
        return rel === "README.md"
          ? text.replace(line, `${line} await fetch("https://example.com/");`)
          : text;
      },
    });
    const got = row(r, "readme-step-2-tamper");
    assert.equal(got.result, "FAIL");
    assert.match(
      got.detail,
      /^not run: the snippet at README\.md:\d+ holds "fetch", and this step runs offline/,
    );
    assert.ok(!r.calls.some((c) => c.args[0] === "--input-type=module"), "the snippet did not run");
    assert.equal(r.code, 1);
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

  test("the README snippets the judge runs import only fs and the built packages, and hold no key", () => {
    const steps = {
      "readme-step-2-tamper": ["Watch the verifier catch a one-field edit.", true],
      "readme-step-4-check-spend": ["Ask the vault itself.", false],
    };
    for (const [id, [marker, offline]] of Object.entries(steps)) {
      const ex = readmeExample(README, marker);
      assert.equal(snippetProblem(ex.script, { imports: SNIPPET_IMPORTS[id], offline }), null, id);
    }
    const two = { imports: SNIPPET_IMPORTS["readme-step-2-tamper"], offline: true };
    const four = { imports: SNIPPET_IMPORTS["readme-step-4-check-spend"], offline: false };
    const sdk = 'import { Probarion } from "./packages/sdk/dist/index.js";\n';
    for (const [script, opts, why] of [
      [`${sdk}new Probarion({ vault: "v", agentKey: k });`, four, /holds "agentKey"/],
      [`${sdk}const k = "ed25519:abc";`, four, /holds "ed25519:"/],
      [`${sdk}console.log(process.env.X);`, four, /holds "process\.env"/],
      [
        `${sdk}await import("node:child_process");`,
        four,
        /holds "child_process"|holds "import\s*\("/,
      ],
      ['import { spawn } from "node:child_process";', four, /imports "node:child_process"/],
      ['import { request } from "node:https";', two, /imports "node:https"/],
      ['import "./packages/cli/dist/bin.js";', two, /imports "\.\/packages\/cli\/dist\/bin\.js"/],
      [
        'import { writeFileSync } from "node:fs";\nwriteFileSync("x", "y");',
        two,
        /holds "writeFile"/,
      ],
      [
        'import { readFileSync } from "node:fs";\nawait fetch("u");',
        two,
        /holds "fetch", and this step runs offline/,
      ],
      [`${sdk}new Probarion({ network: "testnet" });`, two, /imports "\.\/packages\/sdk/],
    ]) {
      assert.match(snippetProblem(script, opts) ?? "", why, script);
    }
    // A live snippet may read the network; it still may not name a key.
    assert.equal(snippetProblem(`${sdk}await fetch("https://rpc");`, four), null);
  });

  test("the live verifies read the chain with an empty, downloaded or committed ledger, and send nothing", async () => {
    const r = await judge([]);
    const live = r.calls.filter((c) => c.args.includes("--network"));
    assert.equal(live.length, 4);
    const at = (c, flag) => c.args[c.args.indexOf(flag) + 1];
    for (const c of live) {
      assert.ok(c.args.includes("--ledger"));
      assert.equal(c.args[1], "verify");
    }
    // Three testnet vaults, and the one mainnet vault with its committed ledger, its two invoices and the
    // repository's evidence and records.
    assert.deepEqual(
      live.map((c) => `${at(c, "--network")} ${at(c, "--vault")}`),
      [
        "testnet demo.vaults.probarion.testnet",
        "testnet v0.probarion.testnet",
        "testnet canary.vaults.probarion.testnet",
        "mainnet v0.probarion.near",
      ],
    );
    const mainnet = live[3];
    assert.equal(at(mainnet, "--ledger"), MAINNET_V0_LEDGER);
    const invoices = mainnet.args.flatMap((a, i) =>
      a === "--invoice" ? [mainnet.args[i + 1]] : [],
    );
    assert.deepEqual(invoices, MAINNET_V0_INVOICES);
    assert.ok(!mainnet.args.includes("--invoices"), "named invoice files, not whole folders");
    // S1's invoice for its two attested decisions and S2's for its one; the ledger is S2's copy, the whole ledger.
    assert.deepEqual(MAINNET_V0_INVOICES, [
      "docs/evidence/mainnet-v0/s1-2026-11-13/invoice-INV-M002.txt",
      "docs/evidence/mainnet-v0/s2-2026-11-13/invoice-INV-M003.txt",
    ]);
    assert.equal(
      MAINNET_V0_LEDGER,
      "docs/evidence/mainnet-v0/s2-2026-11-13/ledger-2026-11-13.jsonl",
    );
    assert.equal(at(mainnet, "--evidence"), "docs/evidence");
    assert.equal(at(mainnet, "--proof"), "docs/mainnet-proof.json");
    // The committed ledger and the invoices are the ones the README's mainnet verify command passes.
    assert.ok(README.includes(`--ledger ${MAINNET_V0_LEDGER}`));
    for (const f of MAINNET_V0_INVOICES) assert.ok(README.includes(`--invoice ${f}`), f);
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

describe("A8 with the committed invoices", () => {
  const run = (code, rep) => ({ code, report: rep, stderr: "", timedOut: false });

  test("the run: PASS when check e says A8 passes on the 5 attested decisions, the same as the committed run", async () => {
    const got = row(await judge(["--offline", "--quick"]), A8_RUN.id);
    assert.equal(got.result, "PASS", got.detail);
    // An offline step: --offline runs it, with no network.
    assert.equal(planSteps(ROOT).find((s) => s.id === A8_RUN.id)?.kind, "offline");
    assert.match(
      got.detail,
      /A8 \(request binding and mandate match\) passes for 5 of 5 attested decisions \(seq 10, 11, 12, 13, 15\), from 6 invoice files read; same as the committed run in docs\/evidence\/demo-vault\/verify-a8-2026-11-12\.txt$/,
    );
    assert.equal(
      got.command,
      "node packages/cli/dist/bin.js verify --offline docs/evidence/demo-vault/snapshot-2026-11-12-video.json --invoices docs/evidence/demo-vault --json",
    );
    assert.equal(got.readme_ref.file, "docs/evidence/demo-vault/README.md");
    assert.ok(got.readme_ref.line > 0);
  });

  test("the run FAILs when A8 does not run, passes on fewer decisions, or check e fails", async () => {
    const fewer = `5 attested decisions pass A1–A7; A8 (request binding and mandate match) passes for 4 of 5 attested decisions (seq 10, 11, 12, 13); A8 not run for seq 15 (no invoice text supplied for invoice_hash ${"0".repeat(64)})`;
    const failing = a8Report({
      detail: "entry 15 fails A8: the request rebuilt from request_inputs",
    });
    failing.ok = false;
    failing.checks = failing.checks.map((c) => (c.id === "e" ? { ...c, status: "fail" } : c));
    const cases = [
      [
        answer(
          0,
          JSON.stringify(
            a8Report({ detail: "A8 not run (the request is not checked against the invoice)" }),
          ),
        ),
        /check e does not say "A8 \(request binding/,
      ],
      [answer(0, JSON.stringify(a8Report({ detail: fewer }))), /check e does not say/],
      [
        answer(1, JSON.stringify(failing)),
        /check e is fail, expected pass; exit code 1, expected 0/,
      ],
      [
        answer(1, "", "error: --invoices docs/evidence/demo-vault holds no .txt file\n"),
        /verify printed no report \(exit 1\): error: --invoices/,
      ],
    ];
    for (const [got, why] of cases) {
      const r = await judge(["--offline", "--quick"], { overrides: { "--invoices": () => got } });
      assert.equal(row(r, A8_RUN.id).result, "FAIL");
      assert.match(row(r, A8_RUN.id).detail, why);
      assert.equal(r.code, 1);
    }
  });

  test("the run FAILs when the committed run is missing or says another result", async () => {
    const edited = (rel, from, to) => (r) => (r === rel ? read(r).replace(from, to) : read(r));
    const cases = [
      [
        edited(A8_RUN.committed, "entries 17, anchors 12", "entries 15, anchors 11"),
        /entries 17, anchors 12 now; entries 15, anchors 11 in the committed run/,
      ],
      [
        edited(A8_RUN.committed, "passes for 5 of 5", "passes for 4 of 5"),
        /the committed run does not say "A8 \(request binding/,
      ],
      [(r) => (r === A8_RUN.committed ? null : read(r)), /verify-a8-2026-11-12\.txt is missing/],
    ];
    for (const [readFile, why] of cases) {
      const r = await judge(["--offline", "--quick"], { readFile });
      assert.equal(row(r, A8_RUN.id).result, "FAIL");
      assert.match(row(r, A8_RUN.id).detail, why);
    }
  });

  test("matchA8: the invoice files A8 checks must be those of exactly the attested decisions", () => {
    assert.equal(matchA8(run(0, a8Report()), A8_RUN.seqs).result, "PASS");
    const short = a8Report();
    short.invoices = short.invoices.filter((f) => !f.attested_seqs.includes(15));
    assert.deepEqual(matchA8(run(0, short), A8_RUN.seqs), {
      result: "FAIL",
      detail: "the invoice files A8 checks are for seq 10, 11, 12, 13, not seq 10, 11, 12, 13, 15",
    });
    const none = a8Report();
    delete none.invoices;
    assert.match(matchA8(run(0, none), A8_RUN.seqs).detail, /are for seq none, not seq 10/);
  });

  test("the committed run is an offline A8 run on the filmed snapshot, its command on the first line", () => {
    const text = read(A8_RUN.committed);
    assert.equal(
      text.split("\n")[0],
      `$ node packages/cli/dist/bin.js verify --offline ${A8_RUN.snapshot} --invoices ${A8_RUN.invoices}`,
    );
    assert.deepEqual(parseVerifyText(text), { checks: ALL_PASS, entries: 17, anchors: 12 });
    assert.ok(text.includes(a8Passes(A8_RUN.seqs)));
    assert.ok(text.includes("\nRESULT: PASS\n"));
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
      /has 3 entries, fewer than the committed 17/,
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

  test("renderRow prints a SKIPPED row's detail whole up to 500 characters, so its command is not cut", () => {
    const detail = withCommand(
      "--offline: this step reads NEAR testnet",
      `node ${"x".repeat(420)}`,
    );
    const text = renderRow({
      n: 14,
      claim: "c",
      readme_ref: { file: "README.md", line: 1, quote: "q" },
      result: "SKIPPED",
      ms: 0,
      detail,
    });
    assert.ok(text.includes(detail));
    assert.ok(
      !renderRow({
        ...{ n: 1, claim: "c", ms: 0, detail },
        readme_ref: { file: "README.md", line: 1 },
        result: "FAIL",
      }).includes(detail),
    );
  });

  test("withCommand adds the command once", () => {
    assert.equal(
      withCommand("the network is down (x)", "pnpm a"),
      "the network is down (x); run `pnpm a`",
    );
    assert.equal(withCommand("known skip; run `pnpm a`", "pnpm a"), "known skip; run `pnpm a`");
  });

  test("testFileResult: every test of the file passed; a skip, a todo, a failure or no test at all is not", () => {
    const f = "test/pay-per-call.test.ts";
    const ok = ` ${OK} ${f} > s > a 2ms\n ${OK} ${f} > s > b 1ms\n ${OK} test/other.test.ts > x 1ms\n`;
    assert.deepEqual(testFileResult(ok, f), {
      ok: true,
      detail: `${f}: all 2 of its tests passed, none skipped`,
    });
    for (const mark of [SKIP, TODO, FAILED]) {
      const v = testFileResult(` ${OK} ${f} > s > a 2ms\n ${mark} ${f} > s > b\n`, f);
      assert.equal(v.ok, false, mark);
      assert.match(v.detail, /1 of the 2 tests of test\/pay-per-call\.test\.ts did not pass/);
    }
    assert.equal(testFileResult(` ${OK} test/other.test.ts > x 1ms\n`, f).ok, false);
    assert.equal(
      testFileResult(` ${OK} test/x/${f} > x 1ms\n`, f).ok,
      false,
      "another file of the same name",
    );
  });

  test("readmeCountNote and passedOf: the README's dated count beside today's", () => {
    assert.equal(passedOf("Tests  801 passed | 2 skipped (803)"), 801);
    assert.equal(passedOf("Tests  1 failed | 10 passed (11)"), 10);
    assert.equal(passedOf("Tests  2 skipped (2)"), null);
    const text = "x\nAs of 2026-11-09 it runs 1,200 in `a`\nand 30 in `b`.";
    assert.equal(
      readmeCountNote(text, "1,200 in `a`", 1200),
      "1200 passed, the count README.md:2 (as of 2026-11-09) gives",
    );
    assert.equal(
      readmeCountNote(text, "30 in `b`", 31),
      "README.md:3 (as of 2026-11-09) gives 30; 31 pass now, so that dated count has drifted",
    );
    assert.equal(readmeCountNote(text, "MCP server: five tools", 3), null, "no count in the quote");
  });

  test("demoCounts reads the MCP demo's last line, plural words too", () => {
    assert.deepEqual(demoCounts("Done: 6 steps, 6 as expected. Nothing was signed or sent."), {
      steps: 6,
      total: 6,
      counts: { "as expected": 6, note: 0, skipped: 0, differs: 0, failed: 0 },
    });
    assert.deepEqual(
      demoCounts(
        "Done: 6 steps, 2 as expected, 2 notes, 1 skipped, 1 differs. Nothing was signed or sent.",
      ).counts,
      { "as expected": 2, note: 2, skipped: 1, differs: 1, failed: 0 },
    );
    assert.equal(
      demoCounts("Done: 6 steps, 4 as expected, 2 differ. Nothing was signed or sent.").counts
        .differs,
      2,
    );
    assert.equal(demoCounts("Done: 6 steps, 6 maybe. Nothing was signed or sent."), null);
    assert.equal(demoCounts(undefined), null);
  });

  test("downloadOutcome: a network error, 429 or 5xx is SKIPPED; any other status is a FAIL", () => {
    const url = "https://probarion.xyz/proof/v/ledger.jsonl";
    assert.equal(downloadOutcome(url, { text: "{}" }, 1), null);
    assert.equal(downloadOutcome(url, { problem: "fetch failed" }, 1).result, "SKIPPED");
    assert.equal(downloadOutcome(url, { problem: "HTTP 502", status: 502 }, 1).result, "SKIPPED");
    assert.equal(downloadOutcome(url, { problem: "HTTP 429", status: 429 }, 1).result, "SKIPPED");
    assert.deepEqual(downloadOutcome(url, { problem: "HTTP 404", status: 404 }, 516), {
      result: "FAIL",
      detail: `README.md:516 says to download the ledger from the proof page, but ${url} answered HTTP 404`,
    });
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
    assert.match(wf, /^ {2}push:\n {4}branches: \[main\]\n/m);
    assert.match(wf, /^ {2}schedule:\n {4}- cron: "[^"]+"\n/m);
    assert.match(wf, /run: pnpm judge --offline --quick\n/);
    assert.match(wf, /run: pnpm install --frozen-lockfile\n/);
  });

  test("judge.yml cannot write, reach a secret, run on a fork's code with secrets, publish or deploy", () => {
    const text = wf.replace(/\r\n/g, "\n");
    const jobs = text.slice(text.indexOf("\njobs:"));
    assert.ok(!/write/i.test(text), "no write anywhere, in a comment or a permission");
    assert.equal((text.match(/permissions:/g) ?? []).length, 1, "one permissions block");
    assert.ok(!/^\s+permissions:/m.test(jobs), "no job-level permissions");
    assert.ok(!/secrets/i.test(text), "no secrets, toJSON(secrets) included");
    assert.ok(!/pull_request_target|workflow_run/.test(text), "no trigger that runs with secrets");
    assert.ok(
      !/\b(publish|deploy|npx|release)\b/i.test(text),
      "no publish, deploy, npx or release",
    );
    assert.ok(!/id-token|GITHUB_TOKEN|github\.token/i.test(text), "no token");
    // pnpm/action-setup exactly as ci-workflow.test.mjs wants it: no with: block, the version from packageManager.
    const code = text
      .split("\n")
      .filter((l) => !/^\s*#/.test(l) && l.trim() !== "")
      .map((l) => l.replace(/\s+#.*$/, ""));
    const at = code.map((l, i) => (/pnpm\/action-setup@/i.test(l) ? i : -1)).filter((i) => i >= 0);
    assert.equal(at.length, 1, "one pnpm/action-setup step");
    assert.match(code[at[0]], /^ {6}- uses: pnpm\/action-setup@[0-9a-f]{40}$/);
    assert.match(code[at[0] + 1], /^ {6}- /, "the next step follows at once: no with: block");
  });
});

describe("the scripts the judge runs by name", () => {
  const scripts = (rel) => JSON.parse(read(rel)).scripts;

  test("pnpm judge runs scripts/judge.mjs and nothing else, so it cannot run the root test or a deploy", () => {
    assert.equal(scripts("package.json").judge, "node scripts/judge.mjs");
  });

  test("eval:check and the 402 demo run what the judge expects, and the 402 tests take --reporter", () => {
    assert.equal(scripts("package.json")["eval:check"], "pnpm --filter @probarion/web eval:check");
    assert.equal(scripts("apps/web/package.json")["eval:check"], "tsx scripts/eval.ts check");
    assert.equal(scripts("examples/402/package.json").demo, "tsx src/run-demo.ts");
    assert.equal(scripts("examples/402/package.json").test, "vitest run");
    for (const p of ["core", "sdk", "cli", "mcp"]) {
      assert.equal(scripts(`packages/${p}/package.json`).test, "vitest run", p);
    }
  });
});
