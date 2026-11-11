#!/usr/bin/env node
// pnpm judge: the repository's claims, checked in one read-only command.
//
// For a hackathon screener, a judge or anyone reviewing Probarion. After `pnpm install --frozen-lockfile`,
// `pnpm judge` builds the four packages, then runs each check README.md asks a reader to run, each mapped to the
// README line whose claim it proves, and prints one row per step:
//
//   PASS            the claim holds
//   EXPECTED-FAIL   the check fails by design, exactly as the README says it does (and in no other way)
//   SKIPPED         not run here, with the reason and the command that runs it
//   FAIL            the claim does not hold, or an expected failure changed in either direction
//
// It writes judge-report.json at the repository root (gitignored) and exits 0 only when no step failed.
//
//   pnpm judge              every step: offline, live read-only testnet reads, and the package tests
//   pnpm judge --offline    no network at all: the live steps are SKIPPED
//   pnpm judge --quick      without the package tests
//   pnpm judge --json       the report as JSON on stdout, the table on stderr
//
// Read-only. It signs and sends nothing and needs no key: its child processes get no PROBARION_* variable and
// no other variable whose name looks like a secret, the MCP demo runs with an empty home folder (so its
// server finds no keys file there), and a README snippet that names a key, or an offline one that reaches the
// network, is refused before it runs. It writes judge-report.json, the packages' dist folders (the build step)
// and a temp folder that holds each step's log and the downloaded ledger. It does not run `pnpm verify`,
// `verify:ts` or the root `pnpm test`.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPORT_FILE = "judge-report.json";
export const RESULTS = ["PASS", "EXPECTED-FAIL", "SKIPPED", "FAIL"];

const CLI = "packages/cli/dist/bin.js";
const MCP = "packages/mcp/dist/bin.js";
const DEMO_VAULT = "demo.vaults.probarion.testnet";
const LEDGER_URL = `https://probarion.xyz/proof/${DEMO_VAULT}/ledger.jsonl`;
const PROBE_RPCS = ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"];
const STEP_TIMEOUT_MS = 5 * 60_000;
const TEST_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT = 16 * 1024 * 1024;

export const USAGE = `Usage: pnpm judge [--offline] [--quick] [--json]

Builds the four packages and runs each check README.md asks a reader to run, each mapped to the README
line it proves. One row per step: PASS, EXPECTED-FAIL (fails by design, exactly as the README says),
SKIPPED (with the reason) or FAIL. Writes ${REPORT_FILE} at the repository root.

  --offline   no network at all: the live read-only testnet steps are SKIPPED
  --quick     skip the package test suites (about 4 of the 6 minutes a full run takes here)
  --json      print the report as JSON on stdout and the table on stderr; for clean JSON run
              \`node scripts/judge.mjs --json\` or \`pnpm -s judge --json\`

Read-only: it signs and sends nothing, and its child processes get no key.
Exit codes: 0 no step failed, 1 a step failed, 2 usage error.
`;

/** The flags, or the usage problem. */
export function parseArgs(argv) {
  const flags = { offline: false, quick: false, json: false, help: false };
  for (const a of argv) {
    if (a === "--offline") flags.offline = true;
    else if (a === "--quick") flags.quick = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--") continue;
    else return { problem: `unknown argument ${JSON.stringify(a)}` };
  }
  return flags;
}

/** A variable a child process must not get: Probarion's own, NEAR AI Cloud's, and anything named like a secret. */
const SECRET_NAME = /^(PROBARION_|NEARAI_)|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|_KEYS?$|^KEY_/i;

/** The environment of every child process: no key of any kind, and no colour codes in the output. */
export function childEnv(env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || SECRET_NAME.test(name) || /^FORCE_COLOR$/i.test(name)) continue;
    out[name] = value;
  }
  out.NO_COLOR = "1";
  return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC and BEL is the point of this pattern
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g;
const plain = (text) => String(text ?? "").replace(ANSI, "");
const linesOf = (text) =>
  plain(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd());
const lastLine = (text) =>
  linesOf(text)
    .filter((l) => l.trim() !== "")
    .pop() ?? "";
const oneLine = (text, max = 300) => {
  const flat = plain(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Words that say a live step met the network rather than a wrong answer. */
const NETWORK_ERROR =
  /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|socket hang up|UND_ERR|AbortError|TimeoutError|timed out|aborted due to timeout|Too Many Requests|HTTP (429|5\d\d)|Service Unavailable|Bad Gateway|Gateway Timeout/i;
export const looksLikeNetworkError = (text) => NETWORK_ERROR.test(plain(text));

// ---------------------------------------------------------------------------------------------
// README references: each step quotes the line whose claim it proves, and finds its line number at run time

/** Where `quote` starts in `text` (any run of whitespace matches any other), or -1. */
function quoteIndex(text, quote) {
  if (typeof text !== "string") return -1;
  const words = quote.trim().split(/\s+/).map(escapeRe);
  return new RegExp(words.join("\\s+")).exec(text)?.index ?? -1;
}

/** The 1-based line where `quote` starts in `text` (any run of whitespace matches any other), or null. */
export function locate(text, quote) {
  const at = quoteIndex(text, quote);
  return at < 0 ? null : text.slice(0, at).split("\n").length;
}

/** The bash snippet and the text block README.md shows after the bold step title `marker`. */
export function readmeExample(readme, marker) {
  const start = typeof readme === "string" ? readme.indexOf(marker) : -1;
  if (start < 0) return { problem: `README.md has no step "${marker}"` };
  const before = readme.slice(0, start).split("\n").length;
  const rest = readme.slice(start);
  const fence = /^([ \t]*)```(\w*)[ \t]*\r?\n([\s\S]*?)^\1```[ \t]*$/gm;
  let script = null;
  let scriptLine = null;
  for (const m of rest.matchAll(fence)) {
    const line = before + rest.slice(0, m.index).split("\n").length - 1;
    const body = m[3]
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => (l.startsWith(m[1]) ? l.slice(m[1].length) : l.trimStart()));
    if (script === null) {
      if (m[2] !== "bash") continue;
      const code = body.join("\n").trim();
      const js = /^node --input-type=module -e '\n?([\s\S]*?)'\s*$/.exec(code);
      if (!js)
        return { problem: `the first bash block after "${marker}" is not a node -e snippet` };
      script = js[1];
      scriptLine = line + 1;
    } else if (m[2] === "text") {
      while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
      return { script, scriptLine, output: body.map((l) => l.trimEnd()), outputLine: line + 1 };
    } else {
      break;
    }
  }
  return { problem: `README.md shows no snippet and output after "${marker}"` };
}

const OWNER_TX_MARKER = "Print an owner transaction without signing it.";

/** What each README snippet the judge runs may import: Node's fs and the built packages, nothing else. */
export const SNIPPET_IMPORTS = {
  "readme-step-2-tamper": ["node:fs", "./packages/core/dist/index.js"],
  "readme-step-4-check-spend": ["./packages/sdk/dist/index.js", "./packages/core/dist/index.js"],
};

/** Splits a shell command line into words, keeping quoted words whole. */
const shellWords = (s) =>
  [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

/**
 * The CLI commands of the first bash block after `marker`, each with the `# error:` line the README puts after
 * it (null when it shows none). Only `node packages/cli/dist/bin.js mandate ...` commands are taken: the owner
 * transaction printers, which sign nothing.
 */
export function readmeCliRuns(readme, marker) {
  const start = typeof readme === "string" ? readme.indexOf(marker) : -1;
  if (start < 0) return { problem: `README.md has no step "${marker}"` };
  const rest = readme.slice(start);
  const m = /^([ \t]*)```bash[ \t]*\r?\n([\s\S]*?)^\1```/m.exec(rest);
  if (!m) return { problem: `README.md shows no bash block after "${marker}"` };
  const first = readme.slice(0, start + m.index).split("\n").length + 1;
  const runs = [];
  let pending = null;
  const lines = m[2].replace(/\r\n?/g, "\n").split("\n");
  for (const [i, raw] of lines.entries()) {
    const text = raw.trim();
    if (pending !== null) {
      pending.text = `${pending.text} ${text.replace(/\\$/, "").trim()}`;
      if (!text.endsWith("\\")) {
        runs.push(pending);
        pending = null;
      }
      continue;
    }
    if (text.startsWith("node ")) {
      pending = { text: text.replace(/\\$/, "").trim(), line: first + i, error: null };
      if (!text.endsWith("\\")) {
        runs.push(pending);
        pending = null;
      }
    } else if (text.startsWith("# error:") && runs.length > 0) {
      runs[runs.length - 1].error = text.slice(2);
    }
  }
  if (runs.length === 0) return { problem: `the bash block after "${marker}" has no node command` };
  const out = [];
  for (const run of runs) {
    const words = shellWords(run.text);
    if (words[0] !== "node" || words[1] !== CLI || words[2] !== "mandate") {
      return { problem: `README.md:${run.line} is not a \`node ${CLI} mandate\` command` };
    }
    out.push({ args: words.slice(1), line: run.line, error: run.error });
  }
  return { runs: out };
}

/** The arguments with --out-dir set to `dir`: the printed args file goes to a temp folder, not the clone. */
export function withOutDir(args, dir) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out-dir") i += 1;
    else if (!args[i].startsWith("--out-dir=")) out.push(args[i]);
  }
  return [...out, "--out-dir", dir];
}

/** Whether `actual` printed exactly `expected`, line for line (trailing spaces and blank lines aside). */
export function compareLines(actual, expected) {
  const got = linesOf(actual);
  while (got.length > 0 && got[got.length - 1] === "") got.pop();
  const n = Math.max(got.length, expected.length);
  for (let i = 0; i < n; i++) {
    if (got[i] !== expected[i]) {
      return {
        same: false,
        detail: `line ${i + 1}: printed ${JSON.stringify(got[i] ?? "(nothing)")}, README.md shows ${JSON.stringify(expected[i] ?? "(nothing)")}`,
      };
    }
  }
  return { same: true };
}

/**
 * Words a README snippet the judge runs may not hold: a key or the environment that could carry one, a child
 * process, another way to load code, or a file write. An offline snippet may also not reach the network.
 */
const SNIPPET_REFUSED =
  /agentKey|ledgerKey|ed25519:|secp256k1:|PROBARION_|process\.env|child_process|\bimport\s*\(|\brequire\s*\(|\beval\s*\(|\bFunction\s*\(|\bspawn|\bexec(?:Sync|File)?\s*\(|writeFile|appendFile|\bunlink|\brmSync\b|\brm\s*\(|\bmkdir/;
const SNIPPET_OFFLINE_REFUSED =
  /\bfetch\b|https?:\/\/|\bnetwork\s*:|\bnew Probarion\b|node:(?:net|http|https|http2|tls|dgram|dns)\b/;

/**
 * Why the judge must not run this README snippet, or null. It runs only snippets that import nothing but
 * `imports` and hold none of the refused words. That catches a plain README edit that gives a step a key or puts
 * the network in an offline step. It is a deny-list, not a sandbox: obfuscated code can get past it, so a change to
 * a README snippet still needs review.
 */
export function snippetProblem(script, { imports, offline }) {
  if (typeof script !== "string") return "is not text";
  for (const m of script.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g)) {
    if (!imports.includes(m[1]))
      return `imports "${m[1]}", which is not one of ${imports.join(", ")}`;
  }
  const bad =
    SNIPPET_REFUSED.exec(script) ?? (offline ? SNIPPET_OFFLINE_REFUSED.exec(script) : null);
  return bad ? `holds "${bad[0]}"${offline ? ", and this step runs offline" : ""}` : null;
}

/**
 * Whether every test of `file` passed in a vitest run with the verbose reporter, which prints one line per test:
 * a mark (a check for a pass), then `<file> > <suite> > <test>`. A file that printed no test did not run.
 */
/** The mark vitest prints before a test that passed (U+2713, a check mark). */
const VITEST_PASS = String.fromCharCode(0x2713);

export function testFileResult(output, file) {
  const prefix = `${file} > `;
  const lines = linesOf(output)
    .map((l) => l.trim())
    .filter((l) => l.slice(l.indexOf(" ") + 1).startsWith(prefix));
  if (lines.length === 0) return { ok: false, detail: `the run lists no test of ${file}` };
  const notPassed = lines.filter((l) => !l.startsWith(`${VITEST_PASS} `));
  if (notPassed.length > 0) {
    return {
      ok: false,
      detail: `${notPassed.length} of the ${lines.length} tests of ${file} did not pass: ${oneLine(notPassed[0], 160)}`,
    };
  }
  return { ok: true, detail: `${file}: all ${lines.length} of its tests passed, none skipped` };
}

/**
 * The README's test count next to the count that passed now. The README dates its counts ("As of <date>"), so a
 * count that has grown since is said, not failed. Null when the quote gives no count.
 */
export function readmeCountNote(readme, quote, passed) {
  const want = /^(\d[\d,]*) /.exec(quote);
  if (!want || typeof readme !== "string" || passed === null) return null;
  const n = Number(want[1].replace(/,/g, ""));
  const at = quoteIndex(readme, quote);
  const before = at < 0 ? "" : readme.slice(0, at);
  const date = [...before.matchAll(/As of (\d{4}-\d{2}-\d{2})/g)].pop()?.[1];
  const where = `README.md:${at < 0 ? "?" : before.split("\n").length}${date ? ` (as of ${date})` : ""}`;
  return passed === n
    ? `${passed} passed, the count ${where} gives`
    : `${where} gives ${n}; ${passed} pass now, so that dated count has drifted`;
}

/** The number of passed tests in a vitest summary line ("Tests  801 passed | 2 skipped (803)"), or null. */
export const passedOf = (testsLine) => {
  const m = /(\d+) passed/.exec(testsLine ?? "");
  return m ? Number(m[1]) : null;
};

/** The MCP demo's outcome words, as its last line counts them ("2 notes", "2 differ" in the plural). */
const DEMO_OUTCOME = {
  "as expected": "as expected",
  note: "note",
  notes: "note",
  skipped: "skipped",
  differs: "differs",
  differ: "differs",
  failed: "failed",
};

/** The counts in the MCP demo's `Done:` line, or null when the line is not one. */
export function demoCounts(done) {
  const m = /^Done: (\d+) steps, (.+)\. Nothing was signed or sent\.$/.exec(done ?? "");
  if (!m) return null;
  const counts = { "as expected": 0, note: 0, skipped: 0, differs: 0, failed: 0 };
  for (const part of m[2].split(", ")) {
    const p = /^(\d+) (as expected|notes?|skipped|differs?|failed)$/.exec(part);
    if (!p) return null;
    counts[DEMO_OUTCOME[p[2]]] += Number(p[1]);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { steps: Number(m[1]), total, counts };
}

/**
 * What a run of the MCP demo means. PASS only when each of its 6 steps answered as expected or with a note
 * (README step 5 allows a note once the mandate's uses run out; the notes are in the detail). A step skipped
 * because the public ledger could not be downloaded over the network is SKIPPED; a step skipped for another
 * reason (the proof page answered 404, the vault has no mandate), or one that differs, is a FAIL, since then
 * the README's tour did not happen. A failed step is SKIPPED when it failed on the network, else FAIL.
 */
export function mcpDemoOutcome(r, readmeLine) {
  const lines = linesOf(r.stdout).map((l) => l.trim());
  const done = lines.filter((l) => l.startsWith("Done: ")).pop();
  const said = (outcome) =>
    lines.filter((l) => l.startsWith(`result: ${outcome}`)).map((l) => l.slice("result: ".length));
  const c = demoCounts(done);
  if (c === null || c.steps !== 6 || c.total !== 6) {
    if (r.timedOut || (r.code !== 0 && looksLikeNetworkError(r.all))) {
      return {
        result: "SKIPPED",
        detail: `the network failed: ${oneLine(done ?? lastLine(r.all), 200)}`,
      };
    }
    return {
      result: "FAIL",
      detail: `exit ${r.code}; ${done ? `${done} is not 6 steps, each counted once` : oneLine(lastLine(r.all), 200)}`,
    };
  }
  const claim = `README.md:${readmeLine ?? "?"}`;
  if (c.counts.differs > 0) {
    return { result: "FAIL", detail: `exit ${r.code}; ${done} ${said("differs").join("; ")}` };
  }
  if (c.counts.failed > 0) {
    const why = said("failed");
    if (looksLikeNetworkError(why.join("\n"))) {
      return { result: "SKIPPED", detail: `the network failed: ${done} ${why.join("; ")}` };
    }
    return { result: "FAIL", detail: `exit ${r.code}; ${done} ${why.join("; ")}` };
  }
  if (c.counts.skipped > 0) {
    const ledger = lines.find((l) => l.startsWith("ledger: could not download "));
    const why = ledger ?? said("skipped").join("; ");
    // Only the verify step skips for the network; a second skip has another reason.
    if (ledger !== undefined && looksLikeNetworkError(ledger) && c.counts.skipped === 1) {
      return { result: "SKIPPED", detail: `the network failed: ${done} ${ledger}` };
    }
    return {
      result: "FAIL",
      detail: `${done} ${why}; ${claim} says the demo runs every step, verify on the public ledger among them`,
    };
  }
  if (r.code !== 0) return { result: "FAIL", detail: `exit ${r.code}; ${done}` };
  const notes = said("note");
  return { result: "PASS", detail: notes.length > 0 ? `${done} ${notes.join("; ")}` : done };
}

/**
 * What `check-claims --online` means. Exit 2 is SKIPPED only when it is the "could not run" exit: at least one
 * `unchecked [online]` line and the summary that counts them. Any other exit 2 (a crash in a check) is a FAIL.
 */
export function checkClaimsOnlineOutcome(r) {
  const last = lastLine(r.stdout);
  if (r.code === 0 && last.startsWith("check-claims: ok.")) return { result: "PASS", detail: last };
  const lines = linesOf(r.stdout);
  const unchecked = lines.filter((l) => l.startsWith("unchecked [online]"));
  const couldNot = lines.find((l) => /^check-claims: \d+ online check\(s\) could not run/.test(l));
  if (r.code === 2 && unchecked.length > 0 && couldNot !== undefined) {
    return {
      result: "SKIPPED",
      detail: `an endpoint did not answer, so ${unchecked.length} online check(s) could not run: ${unchecked.slice(0, 3).join("; ")}`,
    };
  }
  if (r.code === 2) {
    const err = linesOf(r.stderr).filter((l) => l.trim() !== "");
    const why = err.find((l) => l.startsWith("check-claims:")) ?? err.pop() ?? last;
    return {
      result: "FAIL",
      detail: `exit 2 with no list of the checks that could not run, so it is not a network skip: ${oneLine(why, 200)}`,
    };
  }
  const problems = lines.filter((l) => /^\S+:\d+ \[/.test(l));
  return {
    result: "FAIL",
    detail: `exit ${r.code}; ${[...problems.slice(0, 3), last].join("; ")}`,
  };
}

/**
 * What a download of the public ledger means. A network error, a timeout, 429 or 5xx is SKIPPED: the network or
 * the site is having trouble. Any other answer than 200 (404, 403, 410) is a FAIL: the README says the proof
 * page is public and serves the ledger.
 */
export function downloadOutcome(url, got, readmeLine) {
  if (!("problem" in got)) return null;
  if (got.status === undefined || got.status === 429 || got.status >= 500) {
    return { result: "SKIPPED", detail: `could not download ${url}: ${got.problem}` };
  }
  return {
    result: "FAIL",
    detail: `README.md:${readmeLine ?? "?"} says to download the ledger from the proof page, but ${url} answered ${got.problem}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The verifier: what each snapshot and vault must answer

export const CHECK_IDS = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
export const ALL_PASS = Object.fromEntries(CHECK_IDS.map((id) => [id, "pass"]));

/**
 * The committed snapshots under docs/evidence and the test fixture of README step 2, each with the verdict the
 * README gives it. `exit` is the CLI's exit code (0 pass, 1 a check fails, 2 unproven), `checks` every check's
 * status, and `why` a part of the detail a failing check must give: a check that fails for another reason, or
 * that starts to pass, is a FAIL of this step. `committed` is the live run the snapshot was written by; its
 * statuses and counts must be the same offline.
 */
export const SNAPSHOTS = [
  {
    id: "verify-fixture",
    file: "packages/core/test/fixtures/valid-snapshot.json",
    title: "verify --offline: the README's test fixture passes a to i",
    ref: {
      file: "README.md",
      quote: "The CLI runs the same checks over the same fixture, offline, and exits 0",
    },
    expect: { exit: 0, checks: ALL_PASS },
  },
  {
    id: "verify-demo-snapshot",
    file: "docs/evidence/demo-vault/snapshot-2026-11-09.json",
    committed: "docs/evidence/demo-vault/verify-2026-11-09.txt",
    title: "verify --offline: demo vault snapshot passes a to i",
    ref: {
      file: "README.md",
      quote: "so a live `verify` reads the chain and passes checks a to i",
    },
    expect: { exit: 0, checks: ALL_PASS },
  },
  {
    id: "verify-402-snapshot-1109",
    file: "docs/evidence/402-vault/snapshot-2026-11-09.json",
    committed: "docs/evidence/402-vault/verify-2026-11-09.txt",
    title: "verify --offline: 402 vault snapshot (21 calls) passes a to i",
    ref: { file: "README.md", quote: "and a live `verify` passes checks a to i" },
    expect: { exit: 0, checks: ALL_PASS },
  },
  {
    id: "verify-402-snapshot-1111",
    file: "docs/evidence/402-vault/snapshot-2026-11-11.json",
    committed: "docs/evidence/402-vault/verify-2026-11-11.txt",
    title: "verify --offline: 402 negotiation snapshot passes a to i",
    ref: {
      file: "docs/evidence/402-vault/README.md",
      quote: "read the chain after the run: checks a to i pass",
    },
    expect: { exit: 0, checks: ALL_PASS },
  },
  {
    id: "verify-canary-snapshot",
    file: "docs/evidence/canary-vault/snapshot-2026-11-10.json",
    committed: "docs/evidence/canary-vault/verify-2026-11-10.txt",
    title: "verify --offline: Canary snapshot fails c only, by design",
    ref: {
      file: "README.md",
      quote: "so that run checks the chain's 4 anchors against an empty ledger",
    },
    expect: {
      exit: 1,
      checks: { ...ALL_PASS, c: "fail" },
      why: { c: "the ledger has 0" },
      reason:
        "the run of 2026-11-10 had no ledger (the app keeps the Canary's ledger private), so the chain's anchors are checked against an empty ledger",
    },
  },
  {
    id: "verify-canary-snapshot-1111",
    file: "docs/evidence/canary-vault/snapshot-2026-11-11.json",
    committed: "docs/evidence/canary-vault/verify-2026-11-11.txt",
    title: "verify --offline: Canary snapshot with its published ledger passes a to i",
    ref: {
      file: "README.md",
      quote: "With it, a live `verify` on 2026-11-11 passed checks a to i",
    },
    expect: { exit: 0, checks: ALL_PASS },
  },
  {
    id: "verify-mainnet-v0-snapshot",
    file: "docs/evidence/mainnet-v0/snapshot-2026-11-11.json",
    committed: "docs/evidence/mainnet-v0/verify-2026-11-11.txt",
    title: "verify --offline: mainnet v0 snapshot passes a to h, i skips (no factory)",
    ref: {
      file: "docs/evidence/mainnet-v0/README.md",
      quote: "checks a to h pass, and check i skips, because this vault has no factory",
    },
    expect: { exit: 0, checks: { ...ALL_PASS, i: "skip" } },
  },
];

/** The vaults read live, read-only, each with its verdict. */
export const LIVE_VAULTS = {
  v0: {
    exit: 1,
    checks: { ...ALL_PASS, d: "fail", h: "fail", i: "skip" },
    why: { d: "not a decision in the ledger", h: "no burn event" },
    reason:
      "the smoke run sent its spends with the agent key alone, so the vault has no ledger: d finds spends with no decision, h no burn event",
  },
  canary: {
    exit: 1,
    checks: { ...ALL_PASS, c: "fail" },
    why: { c: "the ledger has 0" },
    reason:
      "run without the ledger: c fails on an empty ledger, and d passing shows no spend was ever created",
  },
  demo: { exit: 0, checks: ALL_PASS },
};

const statusCounts = (checks) => {
  const counts = new Map();
  for (const c of checks) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  return [...counts].map(([s, n]) => `${n} ${s}`).join(", ");
};

/**
 * What one verify run means against its expectation: PASS or EXPECTED-FAIL when it answered exactly as expected,
 * FAIL otherwise, including an expected failure that now passes or fails in another way.
 */
export function matchVerify(expect, run) {
  const report = run.report;
  if (report === null || typeof report !== "object" || !Array.isArray(report.checks)) {
    const why = lastLine(run.stderr);
    return {
      result: "FAIL",
      detail: `verify printed no report (exit ${run.code})${why ? `: ${why}` : ""}`,
    };
  }
  const got = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
  const diffs = [];
  for (const [id, status] of Object.entries(expect.checks)) {
    if (got[id] !== status)
      diffs.push(`check ${id} is ${got[id] ?? "missing"}, expected ${status}`);
  }
  for (const id of Object.keys(got)) {
    if (!(id in expect.checks)) diffs.push(`check ${id} (${got[id]}) is not in the expectation`);
  }
  for (const [id, text] of Object.entries(expect.why ?? {})) {
    const c = report.checks.find((x) => x.id === id);
    if (c && c.status === expect.checks[id] && !String(c.detail).includes(text)) {
      diffs.push(`check ${id} is ${c.status} for another reason: ${oneLine(c.detail, 160)}`);
    }
  }
  if (run.code !== expect.exit) diffs.push(`exit code ${run.code}, expected ${expect.exit}`);
  const counts = `${statusCounts(report.checks)}; entries ${report.entries}, anchors ${report.anchors}`;
  if (diffs.length > 0) {
    return {
      result: "FAIL",
      detail: `differs from the expectation: ${diffs.join("; ")} (${counts})`,
    };
  }
  if (expect.exit === 0) return { result: "PASS", detail: `${counts}; RESULT: PASS` };
  const failing = report.checks
    .filter((c) => c.status === "fail")
    .map((c) => `${c.id} (${oneLine(c.detail, 110)})`);
  return {
    result: "EXPECTED-FAIL",
    detail: `fails exactly as the README says: ${failing.join("; ")}; ${counts}. Why: ${expect.reason}`,
  };
}

/** Each check's status and the counts in a committed `probarion verify` text output. */
export function parseVerifyText(text) {
  const checks = {};
  for (const m of plain(text).matchAll(/^([a-i])\s+[a-z-]+\s+(PASS|FAIL|UNPROVEN|SKIP)\b/gm)) {
    checks[m[1]] = m[2].toLowerCase();
  }
  const counts = /entries (\d+), anchors (\d+)/.exec(plain(text));
  return {
    checks,
    entries: counts ? Number(counts[1]) : null,
    anchors: counts ? Number(counts[2]) : null,
  };
}

/** How an offline report differs from the committed live run that wrote its snapshot; empty when it does not. */
export function compareCommitted(report, text) {
  const was = parseVerifyText(text);
  const diffs = [];
  if (Object.keys(was.checks).length === 0) return ["the committed output lists no checks"];
  for (const c of report.checks ?? []) {
    if (was.checks[c.id] !== c.status) {
      diffs.push(`check ${c.id} is ${c.status} offline, ${was.checks[c.id] ?? "missing"} live`);
    }
  }
  if (was.entries !== report.entries || was.anchors !== report.anchors) {
    diffs.push(
      `entries ${report.entries}, anchors ${report.anchors} offline; entries ${was.entries}, anchors ${was.anchors} live`,
    );
  }
  return diffs;
}

/** The committed snapshots under docs/evidence (snapshot-*.json), as repository paths. */
export function evidenceSnapshots(root) {
  const base = join(root, "docs", "evidence");
  const out = [];
  if (!existsSync(base)) return out;
  for (const dir of readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(base, dir.name)).sort()) {
      if (/^snapshot-.*\.json$/.test(f)) out.push(`docs/evidence/${dir.name}/${f}`);
    }
  }
  return out.sort();
}

/** The snapshot steps: every row of SNAPSHOTS, then any committed snapshot it does not list, expected to pass. */
export function snapshotPlan(root) {
  const listed = new Set(SNAPSHOTS.map((s) => s.file));
  const extra = evidenceSnapshots(root)
    .filter((f) => !listed.has(f))
    .map((file) => {
      const dir = file.split("/").slice(0, 3).join("/");
      const date = /snapshot-(.*)\.json$/.exec(file)?.[1];
      const committed = `${dir}/verify-${date}.txt`;
      return {
        id: `verify-${file.split("/")[2]}-${date}`,
        file,
        committed: existsSync(join(root, committed)) ? committed : undefined,
        title: `verify --offline: ${file.split("/").slice(2).join("/")} passes a to i`,
        ref: { file: `${dir}/README.md`, quote: `npx probarion verify --offline ${file}` },
        expect: { exit: 0, checks: ALL_PASS },
      };
    });
  return [...SNAPSHOTS, ...extra];
}

// ---------------------------------------------------------------------------------------------
// The steps

/** Runs the CLI's verify with --json, and reads its report. */
async function verifyRun(ctx, args) {
  const r = await ctx.node([CLI, "verify", ...args, "--json"]);
  let report = null;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    report = null;
  }
  return { code: r.code, report, stderr: r.stderr, timedOut: r.timedOut };
}

function snapshotStep(s) {
  return {
    id: s.id,
    kind: "offline",
    needs: "build",
    title: s.title,
    ref: s.ref,
    expected: s.expect.exit === 0 ? "PASS" : "EXPECTED-FAIL",
    command: `node ${CLI} verify --offline ${s.file} --json`,
    run: async (ctx) => {
      const run = await verifyRun(ctx, ["--offline", s.file]);
      const verdict = matchVerify(s.expect, run);
      if (verdict.result === "FAIL" || s.committed === undefined) return verdict;
      const text = ctx.readFile(s.committed);
      if (text === null) return { result: "FAIL", detail: `${s.committed} is missing` };
      const diffs = compareCommitted(run.report, text);
      if (diffs.length > 0) {
        return {
          result: "FAIL",
          detail: `the offline result differs from the committed live run ${s.committed}: ${diffs.join("; ")}`,
        };
      }
      return { ...verdict, detail: `${verdict.detail}; same as the live run in ${s.committed}` };
    },
  };
}

/**
 * The README's own snippet, run as written, and its output compared with the README's line for line. A snippet
 * that imports anything but `imports`, or holds a refused word (see snippetProblem), is a FAIL and does not run.
 */
function readmeSnippetStep({ id, kind, marker, title, expectedNote, imports }) {
  return {
    id,
    kind,
    needs: "build",
    title,
    ref: { file: "README.md", quote: marker },
    expected: "PASS",
    command: `node --input-type=module -e '<the README snippet after "${marker}">'`,
    run: async (ctx) => {
      const ex = readmeExample(ctx.readFile("README.md"), marker);
      if ("problem" in ex) return { result: "FAIL", detail: ex.problem };
      const refused = snippetProblem(ex.script, { imports, offline: kind === "offline" });
      if (refused !== null) {
        return {
          result: "FAIL",
          detail: `not run: the snippet at README.md:${ex.scriptLine} ${refused}. The judge runs a README snippet only when it imports ${imports.join(" or ")} and holds no key${kind === "offline" ? " and no network call" : ""}; review the snippet, then scripts/judge.mjs`,
        };
      }
      const r = await ctx.node(["--input-type=module", "-e", ex.script]);
      const cmp = compareLines(r.stdout, ex.output);
      if (r.code === 0 && cmp.same) {
        return {
          result: "PASS",
          detail: `the snippet at README.md:${ex.scriptLine} printed the ${ex.output.length} lines README.md:${ex.outputLine} shows, exactly${expectedNote ? `: ${expectedNote}` : ""}`,
        };
      }
      if (kind === "live" && (r.timedOut || looksLikeNetworkError(r.stderr))) {
        return {
          result: "SKIPPED",
          detail: `the network failed: ${oneLine(lastLine(r.stderr), 200)}`,
        };
      }
      return {
        result: "FAIL",
        detail: `exit ${r.code}; ${cmp.same ? oneLine(lastLine(r.stderr), 200) : cmp.detail}`,
      };
    },
  };
}

/** A live verify of a vault, read-only, with the ledger at `ledgerPath` (a missing file is an empty ledger). */
async function liveVerify(ctx, vault, ledgerPath, expect) {
  const run = await verifyRun(ctx, [
    "--network",
    "testnet",
    "--vault",
    vault,
    "--ledger",
    ledgerPath,
  ]);
  if (run.report === null && (run.timedOut || looksLikeNetworkError(run.stderr))) {
    return {
      result: "SKIPPED",
      detail: `the network failed: ${oneLine(lastLine(run.stderr), 200)}`,
    };
  }
  return matchVerify(expect, run);
}

/** The ledger entries' `link` values, in order, or null when the text is not a JSON Lines ledger. */
export function ledgerLinks(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  try {
    return lines.map((l) => {
      const link = JSON.parse(l).link;
      if (typeof link !== "string") throw new Error("no link");
      return link;
    });
  } catch {
    return null;
  }
}

/** Whether the committed ledger is the start of the live one: the same entries, by hash-chain link. */
export function ledgerPrefix(committedText, liveText) {
  const was = ledgerLinks(committedText);
  const now = ledgerLinks(liveText);
  if (was === null) return { ok: false, detail: "the committed ledger is not a JSON Lines ledger" };
  if (now === null) return { ok: false, detail: "the live ledger is not a JSON Lines ledger" };
  if (now.length < was.length) {
    return {
      ok: false,
      detail: `the live ledger has ${now.length} entries, fewer than the committed ${was.length}`,
    };
  }
  const k = was.findIndex((link, i) => now[i] !== link);
  if (k >= 0)
    return { ok: false, detail: `entry ${k} of the committed ledger differs from the live one` };
  return {
    ok: true,
    detail: `its first ${was.length} entries are the committed ledger's, link for link`,
  };
}

/** Every step, in order. */
export function planSteps(root = ROOT) {
  // A package's vitest run. A quote that starts with a count is the README's dated count, said next to today's.
  // `mustPass` is a test file whose every test must pass: the run then uses the verbose reporter, which lists
  // each test with its file.
  const vitest = (pkg, dir, title, quote, { mustPass } = {}) => {
    const args = ["--filter", pkg, "run", "test", ...(mustPass ? ["--reporter=verbose"] : [])];
    return {
      id: `test-${dir.replace(/\//g, "-")}`,
      kind: "test",
      needs: "build",
      title,
      ref: { file: "README.md", quote },
      expected: "PASS",
      command: `pnpm ${args.join(" ")}`,
      run: async (ctx) => {
        const r = await ctx.pnpm(args, { timeoutMs: TEST_TIMEOUT_MS });
        const lines = linesOf(r.stdout);
        const files = lines.find((l) => /^\s*Test Files\s/.test(l))?.trim();
        const tests = lines.find((l) => /^\s*Tests\s/.test(l))?.trim();
        const summary = [tests, files]
          .filter(Boolean)
          .join("; ")
          .replace(/\s{2,}/g, " ");
        if (r.code === 0 && tests) {
          const file = mustPass ? testFileResult(r.stdout, mustPass) : null;
          if (file !== null && !file.ok) {
            return { result: "FAIL", detail: `${file.detail}; ${summary}` };
          }
          const count = readmeCountNote(ctx.readFile("README.md"), quote, passedOf(tests));
          return {
            result: "PASS",
            detail: [summary, file?.detail, count].filter(Boolean).join("; "),
          };
        }
        return {
          result: "FAIL",
          detail: r.timedOut
            ? `timed out after ${TEST_TIMEOUT_MS / 60_000} min; ${summary}`
            : `exit ${r.code}; ${summary || oneLine(lastLine(r.all), 200)}`,
        };
      },
    };
  };

  return [
    {
      id: "build",
      kind: "build",
      title: "the four packages build from source (core, sdk, cli, mcp)",
      ref: { file: "README.md", quote: "Install and build." },
      expected: "PASS",
      command: "pnpm --filter ./packages/* run build",
      run: async (ctx) => {
        const r = await ctx.pnpm(["--filter", "./packages/*", "run", "build"]);
        const built = ["core", "sdk", "cli", "mcp"].filter((p) =>
          ctx.exists(join(ctx.root, "packages", p, "dist", "index.js")),
        );
        if (r.code === 0 && built.length === 4) {
          return {
            result: "PASS",
            detail:
              "core, sdk, cli and mcp built into packages/*/dist; README step 1's `pnpm build` also builds apps/web and apps/extension, not built here (run `pnpm build`)",
          };
        }
        return {
          result: "FAIL",
          detail: `exit ${r.code}; built: ${built.join(", ") || "none"}; ${oneLine(lastLine(r.all), 200)}`,
        };
      },
    },
    {
      id: "check-claims",
      kind: "offline",
      title: "README.md and AGENTS.md claims match the repository",
      ref: { file: "README.md", quote: "Check this README against the repository." },
      expected: "PASS",
      command: "node scripts/check-claims.mjs",
      run: async (ctx) => {
        const r = await ctx.node(["scripts/check-claims.mjs"]);
        const last = lastLine(r.stdout);
        if (r.code === 0 && last.startsWith("check-claims: ok."))
          return { result: "PASS", detail: last };
        const problems = linesOf(r.stdout).filter((l) => /^\S+:\d+ \[/.test(l));
        return {
          result: "FAIL",
          detail: `exit ${r.code}; ${[...problems.slice(0, 3), last].join("; ")}`,
        };
      },
    },
    readmeSnippetStep({
      id: "readme-step-2-tamper",
      kind: "offline",
      marker: "Watch the verifier catch a one-field edit.",
      title: "a one-field edit is caught: first broken entry 2",
      expectedNote: "checks a to i pass as recorded, and after one edit a, b and d fail at entry 2",
      imports: SNIPPET_IMPORTS["readme-step-2-tamper"],
    }),
    ...snapshotPlan(root).map(snapshotStep),
    {
      id: "readme-step-6-owner-tx",
      kind: "offline",
      needs: "build",
      title: "an owner tx is printed for review, not signed; a bad address refused",
      ref: { file: "README.md", quote: OWNER_TX_MARKER },
      expected: "PASS",
      command: `node ${CLI} mandate create ... (the README's two commands, with --out-dir <tmp>)`,
      run: async (ctx) => {
        const runs = readmeCliRuns(ctx.readFile("README.md"), OWNER_TX_MARKER);
        if ("problem" in runs) return { result: "FAIL", detail: runs.problem };
        const outDir = join(ctx.tmp, "probarion-tx");
        const seen = [];
        for (const run of runs.runs) {
          const r = await ctx.node(withOutDir(run.args, outDir));
          if (run.error === null) {
            const printed = linesOf(r.stdout).find((l) =>
              /^near contract call-function as-transaction \S+ \w+ file-args /.test(l),
            );
            if (r.code !== 0 || !r.stdout.startsWith("OWNER SIGNS:") || printed === undefined) {
              return {
                result: "FAIL",
                detail: `README.md:${run.line}: exit ${r.code}; ${oneLine(lastLine(r.all), 200)}`,
              };
            }
            seen.push(
              `README.md:${run.line} printed "${printed.split(" file-args ")[0]}" for the owner to sign`,
            );
          } else {
            const said = lastLine(r.stderr);
            if (r.code === 0 || said !== run.error) {
              return {
                result: "FAIL",
                detail: `README.md:${run.line}: exit ${r.code}, printed ${JSON.stringify(said)}, README.md says ${JSON.stringify(run.error)}`,
              };
            }
            seen.push(`README.md:${run.line} refused, exit ${r.code}: ${said}`);
          }
        }
        return { result: "PASS", detail: `${seen.join("; ")}. Nothing was signed or sent` };
      },
    },
    {
      id: "example-402-demo",
      kind: "offline",
      needs: "build",
      title: "402 demo offline: a walk-away, a negotiated sale, a refusal",
      ref: {
        file: "README.md",
        quote: "shows a walk-away, a negotiated sale and a refusal offline in about a second",
      },
      expected: "PASS",
      command: "pnpm --filter @probarion/example-402 run demo",
      run: async (ctx) => {
        const r = await ctx.pnpm(["--filter", "@probarion/example-402", "run", "demo"]);
        const lines = linesOf(r.stdout);
        const ok = lines.find((l) => l.trim() === "All three calls ended as expected.");
        const took = lines.find((l) => l.startsWith("Demo finished in"));
        if (r.code === 0 && ok)
          return { result: "PASS", detail: [ok, took].filter(Boolean).join(" ") };
        return { result: "FAIL", detail: `exit ${r.code}; ${oneLine(lastLine(r.all), 200)}` };
      },
    },
    {
      id: "eval-check",
      kind: "offline",
      needs: "build",
      title: "the 20-invoice eval reruns offline and matches eval/",
      ref: { file: "README.md", quote: "reruns the 20-invoice eval offline" },
      expected: "PASS",
      command: "pnpm eval:check",
      run: async (ctx) => {
        const r = await ctx.pnpm(["eval:check"]);
        const ok = linesOf(r.all).find((l) => l.startsWith("eval:check passed"));
        if (r.code === 0 && ok) return { result: "PASS", detail: ok };
        return { result: "FAIL", detail: `exit ${r.code}; ${oneLine(lastLine(r.all), 300)}` };
      },
    },
    {
      id: "check-claims-online",
      kind: "live",
      title: "cited txs, vault keys and code, site, store and npm match",
      ref: {
        file: "README.md",
        quote: "adds read-only checks of the chain, the site, the store and npm",
      },
      expected: "PASS",
      command: "node scripts/check-claims.mjs --online",
      run: async (ctx) =>
        checkClaimsOnlineOutcome(await ctx.node(["scripts/check-claims.mjs", "--online"])),
    },
    readmeSnippetStep({
      id: "readme-step-4-check-spend",
      kind: "live",
      marker: "Ask the vault itself.",
      title: "v0 vault, keyless: check_spend 2 USDC ok, 6 OverPerPayment",
      imports: SNIPPET_IMPORTS["readme-step-4-check-spend"],
    }),
    {
      id: "live-verify-demo-vault",
      kind: "live",
      needs: "build",
      title: "live verify of the demo vault's public ledger passes a to i",
      ref: { file: "README.md", quote: "To verify it live, download the ledger file from" },
      expected: "PASS",
      command: `curl -o <tmp>/ledger.jsonl ${LEDGER_URL}; node ${CLI} verify --network testnet --vault ${DEMO_VAULT} --ledger <tmp>/ledger.jsonl --json`,
      run: async (ctx) => {
        const got = await ctx.download(LEDGER_URL);
        const failed = downloadOutcome(LEDGER_URL, got, ctx.ref.line);
        if (failed !== null) return failed;
        const path = join(ctx.tmp, "demo-ledger.jsonl");
        writeFileSync(path, got.text);
        const v = await liveVerify(ctx, DEMO_VAULT, path, LIVE_VAULTS.demo);
        if (v.result !== "PASS") return v;
        const committed = "docs/evidence/demo-vault/ledger-2026-11-09.jsonl";
        const prefix = ledgerPrefix(ctx.readFile(committed) ?? "", got.text);
        if (!prefix.ok)
          return { result: "FAIL", detail: `${v.detail}; but ${committed}: ${prefix.detail}` };
        return {
          result: "PASS",
          detail: `${v.detail}; the live ledger: ${prefix.detail} (${committed})`,
        };
      },
    },
    {
      id: "live-verify-v0",
      kind: "live",
      needs: "build",
      title: "live verify of v0.probarion.testnet fails d and h, by design",
      ref: {
        file: "README.md",
        quote: "`verify --vault v0.probarion.testnet` prints `RESULT: FAIL`",
      },
      expected: "EXPECTED-FAIL",
      command: `node ${CLI} verify --network testnet --vault v0.probarion.testnet --ledger <tmp>/no-ledger.jsonl --json`,
      run: (ctx) =>
        liveVerify(ctx, "v0.probarion.testnet", join(ctx.tmp, "no-ledger.jsonl"), LIVE_VAULTS.v0),
    },
    {
      id: "live-verify-canary",
      kind: "live",
      needs: "build",
      title: "live verify of the Canary: c fails by design, d shows no spend",
      ref: {
        file: "README.md",
        quote:
          "The live `verify` of 2026-11-10, run without the ledger, passes check f (no full-access key) and fails check c",
      },
      expected: "EXPECTED-FAIL",
      command: `node ${CLI} verify --network testnet --vault canary.vaults.probarion.testnet --ledger <tmp>/no-ledger.jsonl --json`,
      run: (ctx) =>
        liveVerify(
          ctx,
          "canary.vaults.probarion.testnet",
          join(ctx.tmp, "no-ledger.jsonl"),
          LIVE_VAULTS.canary,
        ),
    },
    {
      id: "mcp-demo",
      kind: "live",
      needs: "build",
      title: "MCP demo, keyless: the five tools on the demo vault, nothing signed",
      ref: { file: "README.md", quote: "Give an AI agent the vault." },
      expected: "PASS",
      command: `node ${MCP} demo`,
      run: async (ctx) => {
        // The demo's MCP server would load ~/.probarion/<vault>/keys.json when it exists: give it an empty home.
        const home = join(ctx.tmp, "empty-home");
        mkdirSync(home, { recursive: true });
        const { HOMEDRIVE: _drive, HOMEPATH: _path, ...env } = ctx.env;
        const r = await ctx.node([MCP, "demo"], {
          timeoutMs: 8 * 60_000,
          env: { ...env, HOME: home, USERPROFILE: home },
        });
        return mcpDemoOutcome(r, ctx.ref.line);
      },
    },
    vitest(
      "@probarion/core",
      "packages/core",
      "@probarion/core tests pass",
      "806 in `@probarion/core`",
    ),
    vitest(
      "@probarion/sdk",
      "packages/sdk",
      "@probarion/sdk tests pass",
      "782 in `@probarion/sdk`",
    ),
    vitest("probarion", "packages/cli", "CLI (probarion) tests pass", "341 in the CLI"),
    vitest(
      "@probarion/mcp",
      "packages/mcp",
      "@probarion/mcp tests pass",
      "MCP server `@probarion/mcp`: five tools",
    ),
    vitest(
      "@probarion/example-402",
      "examples/402",
      "examples/402 tests pass, the 21-call run among them",
      "You see `test/pay-per-call.test.ts` pass",
      { mustPass: "test/pay-per-call.test.ts" },
    ),
    {
      id: "test-apps-web",
      kind: "known-skip",
      title: "web console tests: not run here, too long",
      ref: { file: "README.md", quote: "8,349 in the web console" },
      expected: "SKIPPED",
      command: "pnpm --filter @probarion/web test",
      detail:
        "known skip: the web console's suite takes many minutes on its own; run `pnpm --filter @probarion/web test`",
    },
    {
      id: "test-rust",
      kind: "known-skip",
      title: "Rust unit, property and sandbox tests: need Rust",
      ref: { file: "README.md", quote: "`pnpm verify` ran 301 Rust tests" },
      expected: "SKIPPED",
      command: "pnpm verify:rust",
      detail:
        "known skip: needs the pinned Rust toolchain (rust-toolchain.toml); run `pnpm verify:rust`. The sandbox tests need Linux and run in CI (`pnpm test:sandbox`)",
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Running

/** Kills a child and everything it started. */
function killTree(child) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

const ACTIVE = new Set();

/** Runs one command with no shell input; resolves with its exit code and output, never rejects. */
export function execCommand(cmd, args, { cwd, env, timeoutMs = STEP_TIMEOUT_MS, shell = false }) {
  return new Promise((done) => {
    const started = performance.now();
    let stdout = "";
    let stderr = "";
    let all = "";
    let timedOut = false;
    let settled = false;
    let timer;
    let child;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child !== undefined) ACTIVE.delete(child);
      if (error) {
        stderr += error;
        all += error;
      }
      done({ code, stdout, stderr, all, timedOut, ms: Math.round(performance.now() - started) });
    };
    try {
      // With a shell (pnpm from PATH on Windows), the command is one string: no word in it needs quoting.
      const line = shell ? [cmd, ...args].map(shellWord).join(" ") : cmd;
      child = spawn(line, shell ? [] : args, {
        cwd,
        env,
        shell,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      finish(null, `${e instanceof Error ? e.message : String(e)}\n`);
      return;
    }
    ACTIVE.add(child);
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const take = (chunk, which) => {
      const text = chunk.toString("utf8");
      if (all.length < MAX_OUTPUT) all += text;
      if (which === "out" && stdout.length < MAX_OUTPUT) stdout += text;
      if (which === "err" && stderr.length < MAX_OUTPUT) stderr += text;
    };
    child.stdout.on("data", (c) => take(c, "out"));
    child.stderr.on("data", (c) => take(c, "err"));
    child.on("error", (e) => finish(null, `${e.message}\n`));
    child.on("close", (code) => finish(code));
  });
}

function shellWord(word) {
  if (/^[\w@./*:=+-]+$/.test(word)) return word;
  throw new Error(`judge: ${JSON.stringify(word)} would need quoting for the shell`);
}

/** How to start pnpm: the one that runs this script when there is one, else pnpm from PATH. */
export function pnpmLauncher(env = process.env, platform = process.platform) {
  const execPath = env.npm_execpath ?? "";
  const base = (execPath.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (/^pnpm\.(c?js|mjs)$/.test(base)) {
    return { cmd: process.execPath, pre: [execPath], shell: false };
  }
  if (base === "pnpm.exe" || (base === "pnpm" && platform !== "win32")) {
    return { cmd: execPath, pre: [], shell: false };
  }
  // pnpm.cmd on Windows runs only through cmd.exe.
  return { cmd: "pnpm", pre: [], shell: platform === "win32" };
}

async function probeNetwork(fetchImpl) {
  let reason = "no RPC host answered";
  for (const url of PROBE_RPCS) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "judge", method: "status", params: [] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true, host: url };
      reason = `${url} answered HTTP ${res.status}`;
    } catch (e) {
      reason = `${url}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { ok: false, reason };
}

/** The file at `url`, or why not: with the HTTP status when the site answered, without it on a network error. */
async function download(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (res.status !== 200) return { problem: `HTTP ${res.status}`, status: res.status };
    return { text: await res.text() };
  } catch (e) {
    return { problem: e instanceof Error ? e.message : String(e) };
  }
}

function gitInfo(root) {
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const commit = git(["rev-parse", "HEAD"]);
  const status = commit === null ? null : git(["status", "--porcelain"]);
  return { commit, dirty: status === null ? null : status !== "" };
}

/** Why a step does not run, or null when it runs. */
async function gate(step, flags, failed, network) {
  if (step.kind === "known-skip") return { result: "SKIPPED", detail: step.detail };
  if (step.needs !== undefined && failed.has(step.needs)) {
    return { result: "SKIPPED", detail: `not run: the ${step.needs} step failed` };
  }
  if (step.kind === "test" && flags.quick) {
    return { result: "SKIPPED", detail: `--quick: not run; run \`${step.command}\`` };
  }
  if (step.kind === "live") {
    if (flags.offline)
      return { result: "SKIPPED", detail: "--offline: this step reads NEAR testnet" };
    const net = await network();
    if (!net.ok) return { result: "SKIPPED", detail: `the network is down (${net.reason})` };
  }
  return null;
}

/** The exit code of a run: 0 when no step failed, 1 otherwise. */
export const exitCodeOf = (rows) => (rows.some((r) => r.result === "FAIL") ? 1 : 0);

export function countResults(rows) {
  return Object.fromEntries(RESULTS.map((r) => [r, rows.filter((x) => x.result === r).length]));
}

/** A SKIPPED row's detail with the command that runs the step, when the reason does not give it already. */
export function withCommand(detail, command) {
  if (typeof command !== "string" || detail.includes(command)) return detail;
  return `${detail}; run \`${command}\``;
}

const refText = (ref) => `${ref.file}${ref.line === null ? " (quote not found)" : `:${ref.line}`}`;

const columns = (n, result, ms, claim) =>
  `${String(n).padStart(3)}  ${result.padEnd(13)}  ${ms.padStart(10)}  ${claim}`;
const TABLE_HEAD = `${columns("#", "RESULT", "TIME", "CLAIM  [the README line it proves]")}\n`;

/**
 * One row of the table: number, result, time and claim with its README line; the detail on the next line, cut
 * at 200 characters, or at 400 for a SKIPPED row so that its command prints whole.
 */
export function renderRow(row) {
  const head = columns(
    row.n,
    row.result,
    `${row.ms} ms`,
    `${row.claim}  [${refText(row.readme_ref)}]`,
  );
  return `${head}\n${" ".repeat(7)}${oneLine(row.detail, row.result === "SKIPPED" ? 400 : 200)}\n`;
}

export function renderMarkdown(report) {
  const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\s+/g, " ");
  const rows = report.steps.map(
    (s) =>
      `| ${s.n} | ${s.result} | ${s.ms} | ${cell(s.claim)} | ${cell(refText(s.readme_ref))} | ${cell(oneLine(s.detail, 300))} |`,
  );
  return [
    `### pnpm judge ${report.flags.offline ? "--offline " : ""}${report.flags.quick ? "--quick " : ""}at ${report.commit ?? "an unknown commit"}`,
    "",
    "| # | Result | ms | Claim | README | Detail |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    report.summary,
    "",
  ].join("\n");
}

/**
 * Runs every step and returns the exit code. Everything outside the repository comes in through `io`, so the
 * tests run it with a fake exec and fetch, and no file is written but the report (through `writeReport`).
 */
export async function runJudge(argv, io) {
  const flags = parseArgs(argv);
  if ("problem" in flags) {
    io.err(`judge: ${flags.problem}\n\n${USAGE}`);
    return 2;
  }
  if (flags.help) {
    io.out(USAGE);
    return 0;
  }
  const root = io.root ?? ROOT;
  const env = childEnv(io.env ?? process.env);
  const exec = io.exec ?? execCommand;
  const fetchImpl = io.fetch ?? fetch;
  const pnpm = pnpmLauncher(io.env ?? process.env);
  const tmp = io.tmp ?? mkdtempSync(join(os.tmpdir(), "probarion-judge-"));
  const readFile = io.readFile ?? ((rel) => readRepoFile(root, rel));
  const table = flags.json ? io.err : io.out;
  const startedAt = new Date();
  const started = performance.now();
  const git = (io.git ?? gitInfo)(root);
  const steps = planSteps(root);
  const host = {
    node: process.version,
    os: { platform: os.platform(), release: os.release(), version: os.version(), arch: os.arch() },
  };

  let probe = null;
  const network = () => {
    probe ??= probeNetwork(fetchImpl);
    return probe;
  };

  const live = steps.filter((s) => s.kind === "live").length;
  const tests = steps.filter((s) => s.kind === "test").length;
  table(
    `pnpm judge: Probarion at ${git.commit?.slice(0, 7) ?? "an unknown commit"}${git.dirty ? " (uncommitted changes)" : ""}, Node ${host.node}, ${host.os.platform} ${host.os.release} ${host.os.arch}\n`,
  );
  table(
    `Read-only: signs and sends nothing, and no child process gets a key. ${steps.length} steps; ${live} read NEAR testnet${flags.offline ? " (skipped: --offline)" : ""}, ${tests} are package test suites${flags.quick ? " (skipped: --quick)" : ""}.\n`,
  );
  table(`Logs: ${tmp}\n\n${TABLE_HEAD}`);

  const rows = [];
  const failed = new Set();
  for (const [i, step] of steps.entries()) {
    const n = i + 1;
    const ref = {
      file: step.ref.file,
      line: locate(readFile(step.ref.file), step.ref.quote),
      quote: step.ref.quote,
    };
    const log = [];
    const record = async (cmd, args, opts = {}) => {
      const r = await exec(cmd, args, { cwd: root, env, ...opts });
      log.push(
        `$ ${[cmd, ...args].join(" ")}\n${r.all}\n[exit ${r.code}${r.timedOut ? ", timed out" : ""}, ${r.ms} ms]\n`,
      );
      return r;
    };
    const ctx = {
      root,
      tmp,
      flags,
      env,
      ref,
      readFile,
      node: (args, opts) => record(process.execPath, args, opts),
      pnpm: (args, opts) =>
        record(pnpm.cmd, [...pnpm.pre, ...args], { ...opts, shell: pnpm.shell }),
      download: (url) => download(fetchImpl, url),
      exists: io.exists ?? existsSync,
    };
    const t0 = performance.now();
    let outcome = await gate(step, flags, failed, network);
    if (outcome === null) {
      try {
        outcome = await step.run(ctx);
      } catch (e) {
        outcome = {
          result: "FAIL",
          detail: `the judge could not run this step: ${e instanceof Error ? e.message : e}`,
        };
      }
    }
    if (outcome.result === "SKIPPED") {
      outcome = { ...outcome, detail: withCommand(outcome.detail, step.command) };
    }
    if (ref.line === null) {
      outcome = {
        result: "FAIL",
        detail: `${ref.file} no longer says "${ref.quote}", the claim this step proves; ${outcome.detail}`,
      };
    }
    let logPath = null;
    if (log.length > 0) {
      logPath = join(tmp, `${String(n).padStart(2, "0")}-${step.id}.log`);
      try {
        (io.writeLog ?? writeFileSync)(logPath, log.join("\n"));
      } catch {
        logPath = null;
      }
    }
    if (outcome.result === "FAIL") failed.add(step.id);
    const row = {
      n,
      id: step.id,
      claim: step.title,
      readme_ref: ref,
      command: step.command,
      result: outcome.result,
      expected: step.expected,
      ms: Math.round(performance.now() - t0),
      detail: outcome.detail,
      log: logPath,
    };
    rows.push(row);
    table(renderRow(row));
  }

  const counts = countResults(rows);
  const exitCode = exitCodeOf(rows);
  const ms = Math.round(performance.now() - started);
  const summary = `judge: ${RESULTS.map((r) => `${counts[r]} ${r}`).join(", ")} in ${(ms / 1000).toFixed(1)} s. Nothing was signed or sent. Report: ${REPORT_FILE}. Exit ${exitCode}.`;
  const report = {
    tool: "pnpm judge",
    report_version: 1,
    commit: git.commit,
    dirty: git.dirty,
    node: host.node,
    os: host.os,
    flags: { offline: flags.offline, quick: flags.quick },
    started_at: startedAt.toISOString(),
    ms,
    ok: exitCode === 0,
    exit_code: exitCode,
    counts,
    summary,
    logs: tmp,
    steps: rows,
  };
  table(`\n${summary}\n`);
  try {
    (
      io.writeReport ??
      ((r) => writeFileSync(join(root, REPORT_FILE), `${JSON.stringify(r, null, 2)}\n`))
    )(report);
  } catch (e) {
    io.err(`judge: could not write ${REPORT_FILE}: ${e instanceof Error ? e.message : e}\n`);
  }
  const summaryFile = (io.env ?? process.env).GITHUB_STEP_SUMMARY;
  if (summaryFile && io.writeReport === undefined) {
    try {
      appendFileSync(summaryFile, renderMarkdown(report));
    } catch {
      // the job summary is a convenience
    }
  }
  if (flags.json) io.out(`${JSON.stringify(report, null, 2)}\n`);
  return exitCode;
}

function readRepoFile(root, rel) {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
}

/** True when node runs this file (not when a test imports it). */
function isMain() {
  try {
    return relative(resolve(process.argv[1] ?? ""), fileURLToPath(import.meta.url)) === "";
  } catch {
    return false;
  }
}

if (isMain()) {
  const stop = (signal) => {
    for (const child of ACTIVE) killTree(child);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  runJudge(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`judge: ${e instanceof Error ? e.stack : e}\n`);
      process.exitCode = 2;
    },
  );
}
