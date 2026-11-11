/**
 * OWNER-RUN ONLY. Records one NEAR AI Cloud answer, with its attestation evidence, for each eval case that reaches the
 * model step, so the model replay runs offline after it (eval/README.md). It uses NEAR AI credit for each case's chat
 * completion and sends no NEAR transaction. The API key is read from the environment, only ever sent as
 * the Authorization header, and never printed or written: a file that would contain it is refused.
 *
 *   pnpm eval:record                 every case that reaches the model step
 *   pnpm eval:record -- --only I-01  some cases (comma-separated ids), to record them again
 *
 * Each answer is checked with A1-A7 (checkAttestation) and A8 (checkRequestBinding) before its file is written; a
 * case whose answer fails a check gets no file, and the run exits 1. Then run `pnpm eval` (offline) to write the
 * results, and hand the files back for review.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { envValue, NearAiProposer, redactSecrets } from "@probarion/sdk";
import { CASES } from "../src/lib/eval/cases";
import { REPO_ROOT } from "../src/lib/eval/dataset";
import { recordAnswer, recordedPath } from "../src/lib/eval/recorded";
import { prepareCase } from "../src/lib/eval/run";

const apiKey = envValue(process.env, "NEARAI_API_KEY");
if (apiKey === undefined) {
  process.stderr.write("NEARAI_API_KEY is not set. eval:record is run by the OWNER only.\n");
  process.exit(2);
}

/** Everything printed goes through this, so a credential an error or a response echoes never reaches the terminal. */
const clean = (text: string): string => redactSecrets(text, [apiKey]);
const say = (text: string) => process.stdout.write(clean(`${text}\n`));

const onlyAt = process.argv.indexOf("--only");
const only =
  onlyAt === -1
    ? null
    : new Set(
        (process.argv[onlyAt + 1] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
      );
const unknown = only === null ? [] : [...only].filter((id) => !CASES.some((c) => c.id === id));
if (unknown.length > 0) {
  process.stderr.write(`no such case: ${unknown.join(", ")}\n`);
  process.exit(2);
}

// One proposer for the run: the model is resolved once, from NEARAI_MODEL or the catalog.
const proposer = new NearAiProposer({ apiKey, model: envValue(process.env, "NEARAI_MODEL") });
let failed = 0;
let written = 0;
for (const c of CASES) {
  if (only !== null && !only.has(c.id)) continue;
  const p = await prepareCase(REPO_ROOT, c);
  if (p.stage !== "cycle" || p.candidate === null) {
    say(`${c.id}: skipped, the pipeline stops before the model step (${p.stage})`);
    continue;
  }
  try {
    const { answer, ok } = await recordAnswer(p, proposer, {
      now: () => new Date(),
      ms: () => performance.now(),
    });
    const failedChecks = [
      ...answer.offline_check.checks.filter((x) => !x.pass).map((x) => `${x.id}: ${x.detail}`),
      ...(answer.request_binding_check.pass ? [] : [`A8: ${answer.request_binding_check.detail}`]),
    ];
    if (!ok) {
      failed += 1;
      say(`${c.id}: NOT written, a check failed: ${failedChecks.join("; ")}`);
      continue;
    }
    const json = `${JSON.stringify(answer, null, 2)}\n`;
    if (json.includes(apiKey))
      throw new Error("the API key appears in the answer; refusing to write it");
    const at = join(REPO_ROOT, recordedPath(c.id));
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, json);
    written += 1;
    say(
      `${c.id}: ${answer.model} proposed ${answer.proposal.action} (amount ${answer.proposal.amount ?? "null"}), A1-A8 PASS, ${answer.latency_ms} ms, wrote ${recordedPath(c.id)}`,
    );
  } catch (error) {
    failed += 1;
    // NearAiError messages are already redacted; clean() is the second, independent line of defence.
    say(`${c.id}: failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
say(
  `recorded ${written} answers, ${failed} failed. Next: pnpm eval (offline) writes eval/results from them.`,
);
if (failed > 0) process.exitCode = 1;
