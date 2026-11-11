/**
 * The 20-invoice eval, offline. Nothing is sent and no key is read.
 *
 *   pnpm --filter @probarion/web eval:generate   writes the dataset under eval/ from src/lib/eval/cases.ts
 *   pnpm --filter @probarion/web eval            runs both runs and writes eval/results
 *   pnpm --filter @probarion/web eval:check      reruns everything and fails if a committed file differs
 *
 * The model replay runs once eval/recorded holds answers (the OWNER records them with eval:record).
 */
import { datasetFiles, driftedFiles, REPO_ROOT, writeFiles } from "../src/lib/eval/dataset";
import { buildResults, resultFiles } from "../src/lib/eval/report";

const command = process.argv[2] ?? "";

async function results(): Promise<Map<string, Uint8Array>> {
  const files = resultFiles(await buildResults(REPO_ROOT));
  return new Map([...files].map(([path, body]) => [path, new TextEncoder().encode(body)]));
}

if (command === "generate") {
  writeFiles(REPO_ROOT, datasetFiles());
  process.stdout.write("wrote the eval dataset under eval/\n");
} else if (command === "run") {
  const dataset = driftedFiles(REPO_ROOT, datasetFiles());
  if (dataset.length > 0) {
    process.stderr.write(
      `the committed dataset differs from cases.ts (${dataset.join(", ")}): run eval:generate first\n`,
    );
    process.exit(1);
  }
  const files = await results();
  writeFiles(REPO_ROOT, files);
  const latest = JSON.parse(new TextDecoder().decode(files.get("eval/results/latest.json"))) as {
    headline: unknown;
  };
  process.stdout.write(`wrote eval/results; headline ${JSON.stringify(latest.headline)}\n`);
} else if (command === "check") {
  const drifted = [
    ...driftedFiles(REPO_ROOT, datasetFiles()),
    ...driftedFiles(REPO_ROOT, await results()),
  ];
  if (drifted.length > 0) {
    process.stderr.write(
      `eval:check FAILED: these files differ from what the code gives now: ${drifted.join(", ")}\nRun eval:generate (dataset) or eval (results), review the change, and commit it. A recorded answer whose facts changed is reported per case as stale: the OWNER records it again.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    "eval:check passed: the dataset and the results match the committed files\n",
  );
} else {
  process.stderr.write("usage: tsx scripts/eval.ts generate | run | check\n");
  process.exit(2);
}
