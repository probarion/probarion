import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  encodeData,
  encodeProperty,
  explain,
  lastGateLog,
  MAX_LINE,
  main,
  TAIL_LINES,
  tail,
} from "./ci-failure-note.mjs";

const SCRIPT = fileURLToPath(new URL("./ci-failure-note.mjs", import.meta.url));
const ESC = String.fromCharCode(27);

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ci-failure-note-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Decodes a workflow command message the way the runner does. */
const decode = (text) =>
  text
    .replace(/%0A/g, "\n")
    .replace(/%0D/g, "\r")
    .replace(/%3A/g, ":")
    .replace(/%2C/g, ",")
    .replace(/%25/g, "%");

test("the message encoding: % first, then \\r and \\n, so a literal %0A survives a round trip", () => {
  assert.equal(encodeData("a%b\r\nc\nd"), "a%25b%0D%0Ac%0Ad");
  assert.equal(encodeData("100%0A"), "100%250A");
  assert.equal(decode(encodeData("100%0A\nnext")), "100%0A\nnext");
  assert.equal(encodeData("::error::x"), "::error::x");
  assert.equal(encodeProperty("ts failed: 1, 2%"), "ts failed%3A 1%2C 2%25");
});

test("tail keeps the last 60 lines, without colour codes, CRs or over-long lines", () => {
  const log = `${Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
  const lines = tail(log);
  assert.equal(TAIL_LINES, 60);
  assert.equal(lines.length, 60);
  assert.equal(lines[0], "line 41");
  assert.equal(lines.at(-1), "line 100");
  assert.deepEqual(tail(`${ESC}[31mred${ESC}[39m\r\nplain\r\n`), ["red", "plain"]);
  assert.deepEqual(tail("progress 1\rprogress 2\n"), ["progress 1\rprogress 2"]);
  const long = tail(`${"x".repeat(MAX_LINE + 50)}\n`)[0];
  assert.equal(long, `${"x".repeat(MAX_LINE)} …`);
  assert.deepEqual(tail(""), []);
  assert.deepEqual(tail("only\n", 5), ["only"]);
});

test("the highest-numbered gate log is the one that failed; other files are ignored", () => {
  withTemp((dir) => {
    assert.equal(lastGateLog(dir), null);
    assert.equal(lastGateLog(join(dir, "missing")), null);
    for (const name of ["gate-1-install.log", "gate-2-verify-ts.log", "gate-10-late.log"]) {
      writeFileSync(join(dir, name), name);
    }
    writeFileSync(join(dir, "gate-99-Upper.log"), "not a gate log");
    writeFileSync(join(dir, "other.log"), "");
    assert.deepEqual(lastGateLog(dir), { file: join(dir, "gate-10-late.log"), gate: "late" });
  });
});

test("one annotation line, decoding back to the gate and its last lines", () => {
  const text = `${Array.from({ length: 70 }, (_, i) => `out ${i + 1}`).join("\n")}\nerror: 50% of tests failed\n`;
  const { annotation, summary } = explain("rust-unit", { gate: "clippy", text });
  assert.ok(!annotation.includes("\n") && !annotation.includes("\r"), "one line");
  assert.ok(annotation.startsWith("::error title=rust-unit failed::"), annotation.slice(0, 40));
  const message = decode(annotation.slice("::error title=rust-unit failed::".length));
  const lines = message.split("\n");
  assert.equal(lines[0], 'Gate "clippy" failed. The last 60 lines of its output:');
  assert.equal(lines.length, 61);
  assert.equal(lines[1], "out 12");
  assert.equal(lines.at(-1), "error: 50% of tests failed");
  assert.match(summary, /^### rust-unit failed: clippy\n/);
  assert.match(summary, /\n```text\nout 12\n[\s\S]*\nerror: 50% of tests failed\n```\n$/);
});

test("the summary fence is longer than any backtick run in the log", () => {
  const { summary } = explain("ts", { gate: "verify-ts", text: "a ``` b\nc ```` d\n" });
  assert.match(summary, /\n`````text\na ``` b\nc ```` d\n`````\n$/);
});

test("a gate with no output, and a job that failed before its first gate, are still explained", () => {
  const empty = explain("ts", { gate: "install", text: "" });
  assert.equal(empty.annotation, '::error title=ts failed::Gate "install" failed with no output.');
  const none = explain("sandbox", null);
  assert.equal(
    none.annotation,
    "::error title=sandbox failed::sandbox failed before its first gate step ran: see the first failed step's log.",
  );
  assert.match(none.summary, /^### sandbox failed\n/);
});

test("main prints one annotation, appends the summary and prints no environment variable", () => {
  withTemp((dir) => {
    writeFileSync(join(dir, "gate-1-fmt.log"), "fmt ok\n");
    writeFileSync(join(dir, "gate-2-clippy.log"), "warning: unused\nerror: aborting\n");
    const summaryFile = join(dir, "summary.md");
    writeFileSync(summaryFile, "earlier\n");
    const printed = [];
    const env = {
      RUNNER_TEMP: dir,
      GITHUB_STEP_SUMMARY: summaryFile,
      SECRET_LOOKING: "s3cr3t-value",
      PATH: "/usr/bin",
    };
    assert.equal(
      main(["rust-unit"], env, (line) => printed.push(line)),
      0,
    );
    assert.equal(printed.length, 1);
    assert.equal(
      printed[0],
      '::error title=rust-unit failed::Gate "clippy" failed. The last 2 lines of its output:%0Awarning: unused%0Aerror: aborting',
    );
    const summary = readFileSync(summaryFile, "utf8");
    assert.ok(summary.startsWith("earlier\n### rust-unit failed: clippy\n"), summary);
    for (const value of Object.values(env).filter((v) => v !== dir && v !== summaryFile)) {
      assert.ok(!printed[0].includes(value) && !summary.includes(value), `printed ${value}`);
    }
  });
});

test("the script reads no environment variable but RUNNER_TEMP and GITHUB_STEP_SUMMARY", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const reads = [...source.matchAll(/\benv\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(reads)].sort(), ["GITHUB_STEP_SUMMARY", "RUNNER_TEMP"]);
  assert.ok(!/process\.env\.|printenv|JSON\.stringify\(env|Object\.\w+\(env/.test(source));
});

test("run as a script: one annotation on stdout, and a usage error for a bad job id", () => {
  withTemp((dir) => {
    writeFileSync(join(dir, "gate-1-verify-launch.log"), "FAIL test/x.test.ts\n");
    const run = (args) =>
      spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? "", RUNNER_TEMP: dir },
      });
    const ok = run(["ts"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(
      ok.stdout,
      '::error title=ts failed::Gate "verify-launch" failed. The last line of its output:%0AFAIL test/x.test.ts\n',
    );
    for (const bad of [[], ["TS"], ["ts", "extra"], ["ts,x"], ["-x"]]) {
      const result = run(bad);
      assert.equal(result.status, 2, `args ${JSON.stringify(bad)}`);
      assert.equal(result.stdout, "");
    }
  });
});
