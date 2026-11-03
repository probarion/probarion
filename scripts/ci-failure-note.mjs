#!/usr/bin/env node
// Explains a failed CI job where a reader looks first: on the run page, on the pull request and in the
// job summary, instead of at the bottom of a long log.
//
//   node scripts/ci-failure-note.mjs <job-id>
//
// Each gate step of a job tees its output to $RUNNER_TEMP/gate-<n>-<name>.log, numbered in the order the
// steps run, under `set -o pipefail` so the step keeps the command's exit status. When a gate fails, the
// steps after it are skipped, so the highest-numbered log is the gate that failed. The job's last step,
// `if: failure()`, runs this script, which takes the last 60 lines of that log and
//   - prints them as ONE `::error title=<job-id> failed::` workflow command, with % encoded as %25,
//     \r as %0D and \n as %0A (the encoding GitHub's toolkit uses), and
//   - appends them to $GITHUB_STEP_SUMMARY in a fenced block.
// It reads only those two variables and the log files, and prints no environment variable. It exits 0
// whenever it explains something: the job has failed already, and this step only says why.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const TAIL_LINES = 60;
export const MAX_LINE = 400;
const GATE_LOG = /^gate-(\d+)-([a-z0-9-]+)\.log$/;
const JOB_ID = /^[a-z0-9][a-z0-9-]*$/;
// ANSI escape sequences (colours, cursor moves), which tools print even into a pipe.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

/** A workflow command's message: % first, so that the %0A this adds is not encoded again. */
export function encodeData(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** A workflow command's property value (title=…): the message encoding, plus : and ,. */
export function encodeProperty(text) {
  return encodeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** The last `count` lines of a log, without colour codes, line-ending \r or over-long lines. */
export function tail(text, count = TAIL_LINES) {
  const lines = text.replace(ANSI, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines
    .slice(-count)
    .map((line) => line.replace(/\r$/, ""))
    .map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} …` : line));
}

/** The gate log with the highest number in `dir`, as { file, gate }, or null when no gate ran. */
export function lastGateLog(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const logs = names
    .map((file) => ({ file, m: GATE_LOG.exec(file) }))
    .filter(({ m }) => m)
    .map(({ file, m }) => ({ file, n: Number(m[1]), gate: m[2] }))
    .sort((a, b) => b.n - a.n);
  return logs.length > 0 ? { file: join(dir, logs[0].file), gate: logs[0].gate } : null;
}

/** A Markdown code fence longer than any run of backticks in `lines`. */
function fenceFor(lines) {
  const longest = Math.max(0, ...lines.flatMap((l) => (l.match(/`+/g) ?? []).map((r) => r.length)));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The annotation line and the step-summary Markdown for a failed job. `log` is null when the job failed
 * before its first gate (in a checkout, toolchain or cache step).
 */
export function explain(job, log) {
  if (!log) {
    const message = `${job} failed before its first gate step ran: see the first failed step's log.`;
    return {
      annotation: `::error title=${encodeProperty(`${job} failed`)}::${encodeData(message)}`,
      summary: `### ${job} failed\n\n${message}\n`,
    };
  }
  const lines = tail(log.text);
  const head =
    lines.length === 0
      ? `Gate "${log.gate}" failed with no output.`
      : `Gate "${log.gate}" failed. The last ${lines.length === 1 ? "line" : `${lines.length} lines`} of its output:`;
  const fence = fenceFor(lines);
  return {
    annotation: `::error title=${encodeProperty(`${job} failed`)}::${encodeData([head, ...lines].join("\n"))}`,
    summary: `### ${job} failed: ${log.gate}\n\n${head}\n\n${fence}text\n${lines.join("\n")}\n${fence}\n`,
  };
}

/** Runs the script; `env` holds RUNNER_TEMP and GITHUB_STEP_SUMMARY, `print` writes one line. */
export function main(argv, env = process.env, print = console.log) {
  const job = argv[0];
  if (argv.length !== 1 || !JOB_ID.test(job ?? "")) {
    console.error("usage: ci-failure-note.mjs <job-id>   (lower-case letters, digits and -)");
    return 2;
  }
  const found = env.RUNNER_TEMP ? lastGateLog(env.RUNNER_TEMP) : null;
  const log = found ? { gate: found.gate, text: readFileSync(found.file, "utf8") } : null;
  const { annotation, summary } = explain(job, log);
  print(annotation);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
