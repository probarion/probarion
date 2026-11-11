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
 * case whose answer fails a check gets no file. A model call that fails is written as a failed call, which the replay
 * decides rules-only, as the SDK does. Either way the run exits 1. Then run `pnpm eval` (offline) to write the
 * results, and hand the files back for review. The loop is recordCases (src/lib/eval/record.ts), tested with the
 * SDK's NEAR AI test double.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { envValue, NearAiProposer } from "@probarion/sdk";
import { REPO_ROOT } from "../src/lib/eval/dataset";
import { parseOnly, recordCases } from "../src/lib/eval/record";

const apiKey = envValue(process.env, "NEARAI_API_KEY");
if (apiKey === undefined) {
  process.stderr.write("NEARAI_API_KEY is not set. eval:record is run by the OWNER only.\n");
  process.exit(2);
}

const only = parseOnly(process.argv);
if (!only.ok) {
  process.stderr.write(`${only.error}\n`);
  process.exit(2);
}

// One proposer for the run: the model is resolved once, from NEARAI_MODEL or the catalog.
const proposer = new NearAiProposer({ apiKey, model: envValue(process.env, "NEARAI_MODEL") });
const tally = await recordCases({
  root: REPO_ROOT,
  proposer,
  apiKey,
  only: only.only,
  clock: { now: () => new Date(), ms: () => performance.now() },
  write: (path, body) => {
    const at = join(REPO_ROOT, path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, body);
  },
  // recordCases redacts the key from every line before it calls this.
  say: (line) => process.stdout.write(`${line}\n`),
});
process.stdout.write(
  `recorded ${tally.written} answers and ${tally.callFailed} failed calls; ${tally.failed} cases got no file. Next: pnpm eval (offline) writes eval/results from them.\n`,
);
if (tally.failed > 0 || tally.callFailed > 0) process.exitCode = 1;
