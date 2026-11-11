// The committed eval results (eval/results) are what the runner gives now from the committed dataset and recordings,
// offline: this is `pnpm eval:check` inside the web suite, with no network (test/setup/no-network.ts). It also holds
// the runner's mirror of the pipeline's owner-wait rule to pipeline.ts itself, and every committed recording to
// A1-A8.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "@/lib/eval/dataset";
import { RECORDED_DIR } from "@/lib/eval/recorded";
import { buildResults, RESULTS, type Results, resultFiles } from "@/lib/eval/report";
import { type SdkOutcome, waitsForOwnerMirror } from "@/lib/eval/run";
import { OWNER_CONFIRMS_RULE } from "@/lib/payables/owner-confirms";
import { invoiceStatusOf, waitsForOwner } from "@/lib/payables/pipeline";

let results: Results;
beforeAll(async () => {
  results = await buildResults(REPO_ROOT);
}, 60_000);

const committed = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
const recordings = existsSync(join(REPO_ROOT, RECORDED_DIR))
  ? readdirSync(join(REPO_ROOT, RECORDED_DIR)).filter((f) => f.endsWith(".json"))
  : [];

describe("the committed eval results", () => {
  it("are what the runner gives now, byte for byte (eval:check)", () => {
    for (const [path, body] of resultFiles(results)) expect(committed(path), path).toBe(body);
  });

  it("move no money wrongly in either run", () => {
    const latest = JSON.parse(committed(RESULTS.json)) as Results;
    expect(latest.headline.money_moved_wrongly.rules_only).toBe("0/20");
    expect(["0/20", "not recorded"]).toContain(latest.headline.money_moved_wrongly.model_replay);
  });

  it("report the model replay as not recorded exactly when no answer is committed", () => {
    expect("summary" in results.runs.model_replay).toBe(recordings.length > 0);
  });

  it.skipIf(recordings.length === 0)(
    "replay every committed recording with A1-A8 passing and the facts unchanged",
    () => {
      const replay = results.runs.model_replay;
      if (!("summary" in replay)) throw new Error("unreachable: the replay runs with recordings");
      for (const file of recordings) {
        const id = file.slice(0, -".json".length);
        const r = replay.cases.find((x) => x.id === id);
        expect(r?.model?.status, id).toBe("replayed");
      }
    },
  );
});

describe("the runner's mirror of the pipeline", () => {
  it("answers waitsForOwner as pipeline.ts does, for every outcome shape", () => {
    const statuses: SdkOutcome["status"][] = ["refused_by_code", "held", "paid"];
    const codes = [OWNER_CONFIRMS_RULE, "custom.invoice_number_duplicate", "model.refused", null];
    const owners = ["pass", "hold", "refuse", null] as const;
    for (const status of statuses)
      for (const code of codes)
        for (const owner of owners)
          for (const spendId of [null, 0]) {
            const o: SdkOutcome = { status, code, spendId, txHash: null };
            expect(waitsForOwnerMirror(o, owner), JSON.stringify({ o, owner })).toBe(
              waitsForOwner(o, owner),
            );
          }
  });

  it("gives every case the invoice status pipeline.ts would give its outcome", () => {
    const runs = [results.runs.rules_only, results.runs.model_replay].flatMap((r) =>
      "summary" in r ? [r] : [],
    );
    for (const run of runs) {
      for (const r of run.cases.filter((x) => x.stage === "cycle")) {
        const sent = r.spend !== "none";
        const sdk = r.sdk as NonNullable<typeof r.sdk>;
        const o: SdkOutcome = {
          status: sdk.status === "sent" ? (r.spend === "would_pay" ? "paid" : "held") : sdk.status,
          code: sdk.code,
          spendId: sent ? 0 : null,
          txHash: null,
        };
        const owner =
          r.decision?.rules.find((x) => x.id === OWNER_CONFIRMS_RULE)?.outcome ?? "pass";
        const status = waitsForOwner(o, owner) ? "awaiting_owner" : invoiceStatusOf(o);
        expect(r.invoice_status, `${run.mode} ${r.id}`).toBe(status);
      }
    }
  });
});
