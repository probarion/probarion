// The OWNER's recorder (scripts/eval-record.ts) apart from the real key and the file system: the --only parser, the
// refusal to write a file that holds the key, the redaction of what it prints, and a failed model call recorded as
// one, which the replay decides rules-only as Probarion.modelStep does. The key here is a made-up sentinel and the
// model is the SDK's NEAR AI test double; nothing reaches NEAR AI Cloud.
import { NearAiError, NearAiProposer } from "@probarion/sdk";
import { createFakeNearAi, FAKE_NEARAI_BASE_URL } from "@probarion/sdk/testing";
import { describe, expect, it } from "vitest";
import { CASES } from "@/lib/eval/cases";
import { REPO_ROOT } from "@/lib/eval/dataset";
import { EVAL_NOW } from "@/lib/eval/mandates";
import { parseOnly, recordCases } from "@/lib/eval/record";
import { type Proposer, type Recording, recordedPath, replayAnswer } from "@/lib/eval/recorded";
import { buildResults } from "@/lib/eval/report";
import { prepareCase } from "@/lib/eval/run";

/** Not a key: a sentinel the recorder must never write or print. */
const SENTINEL = "probarion-eval-sentinel-not-a-key-7f3a91";

const clock = () => {
  let t = 0;
  return { now: () => EVAL_NOW, ms: () => (t += 250) };
};

/** The test double, answering with the facts' amount, and with `reasoning` as given. */
function doubleProposer(reasoning: string): NearAiProposer {
  return new NearAiProposer({
    apiKey: SENTINEL,
    baseUrl: FAKE_NEARAI_BASE_URL,
    fetch: createFakeNearAi({
      respond: (request: { messages: { role: string; content: string }[] }) => {
        const user = request.messages.find((m) => m.role === "user")?.content ?? "";
        const facts = JSON.parse(/^facts: (.*)$/m.exec(user)?.[1] ?? "null") as {
          amount: string;
        } | null;
        return JSON.stringify({
          action: "pay",
          mandate_id: 1,
          amount: facts?.amount ?? null,
          payee_hint: null,
          reasoning,
          confidence: 0.9,
        });
      },
    }).fetch,
    now: () => EVAL_NOW,
    sleep: async () => {},
  });
}

/** Runs the recorder over `ids` and keeps what it would write and print. */
async function record(proposer: Proposer, ids: string[]) {
  const written = new Map<string, string>();
  const said: string[] = [];
  const tally = await recordCases({
    root: REPO_ROOT,
    proposer,
    apiKey: SENTINEL,
    only: new Set(ids),
    clock: clock(),
    write: (path, body) => written.set(path, body),
    say: (line) => said.push(line),
  });
  return { tally, written, said: said.join("\n") };
}

describe("parseOnly", () => {
  it("is null without --only, and the named cases with it", () => {
    expect(parseOnly(["node", "eval-record.ts"])).toEqual({ ok: true, only: null });
    expect(parseOnly(["node", "eval-record.ts", "--only", "I-01, C-02"])).toEqual({
      ok: true,
      only: new Set(["I-01", "C-02"]),
    });
  });

  it("refuses an id that is not a case, and --only with no id (the script exits 2)", () => {
    expect(parseOnly(["node", "eval-record.ts", "--only", "I-01,X-99"])).toEqual({
      ok: false,
      error: "no such case: X-99",
    });
    expect(parseOnly(["node", "eval-record.ts", "--only"])).toMatchObject({ ok: false });
    expect(parseOnly(["node", "eval-record.ts", "--only", " , "])).toMatchObject({ ok: false });
  });
});

describe("recordCases", () => {
  it("writes the answer of a case the model answered, after A1-A8 pass", async () => {
    const { tally, written } = await record(doubleProposer("test double"), ["C-01"]);
    expect(tally).toEqual({ written: 1, callFailed: 0, failed: 0 });
    const body = written.get(recordedPath("C-01")) ?? "";
    expect(JSON.parse(body)).toMatchObject({ case: "C-01", offline_check: { ok: true } });
  });

  it("writes no file and prints no key when the answer holds the key", async () => {
    const { tally, written, said } = await record(doubleProposer(`echo ${SENTINEL}`), ["C-01"]);
    expect(tally).toEqual({ written: 0, callFailed: 0, failed: 1 });
    expect(written.size).toBe(0);
    expect(said).not.toContain(SENTINEL);
    expect(said).toContain("C-01: NOT written");
  });

  it("records a failed call as a failure without the key, and prints no key", async () => {
    const failing: Proposer = {
      resolvedModel: "test-double/private-tee-model",
      propose: async () => {
        throw new NearAiError(`invalid model proposal: the reply quoted ${SENTINEL}`);
      },
    };
    const { tally, written, said } = await record(failing, ["I-05"]);
    expect(tally).toEqual({ written: 0, callFailed: 1, failed: 0 });
    expect(said).not.toContain(SENTINEL);
    const body = written.get(recordedPath("I-05")) ?? "";
    expect(body).not.toContain(SENTINEL);
    const failure = JSON.parse(body) as Recording;
    expect(failure).toMatchObject({
      case: "I-05",
      model: "test-double/private-tee-model",
      failure: { error: "NearAiError" },
    });
    expect("evidence" in failure).toBe(false);

    // The replay decides the case as Probarion.modelStep does when propose() throws: rules-only, model.unavailable.
    const c = CASES.find((x) => x.id === "I-05");
    if (c === undefined) throw new Error("no case I-05");
    const replay = await replayAnswer(await prepareCase(REPO_ROOT, c), failure);
    expect(replay).toMatchObject({ status: "call_failed", proposal: null, attestationOk: false });
    const results = await buildResults(REPO_ROOT, {
      recorded: (id) => (id === "I-05" ? failure : null),
    });
    if (!("summary" in results.runs.model_replay)) throw new Error("the replay did not run");
    const i05 = results.runs.model_replay.cases.find((x) => x.id === "I-05");
    expect(i05?.model?.status).toBe("call_failed");
    expect(i05?.decision?.decided_by).toBe("rules-only");
    expect(i05).toMatchObject({ outcome: "hold", waits_for: "owner" });
    expect(results.runs.model_replay.summary.model).toMatchObject({
      call_failed: "1/19",
      model_fooled: "0/0",
    });
  });

  it("reports a failure recorded for other facts than the code reads now as stale", async () => {
    const failing: Proposer = {
      resolvedModel: null,
      propose: async () => {
        throw new NearAiError("POST /chat/completions: HTTP 503");
      },
    };
    const { written } = await record(failing, ["C-01"]);
    const failure = JSON.parse(written.get(recordedPath("C-01")) ?? "") as Recording;
    if (!("failure" in failure)) throw new Error("not a failure record");
    failure.facts = { ...failure.facts, amount: "121000000" };
    const c = CASES.find((x) => x.id === "C-01");
    if (c === undefined) throw new Error("no case C-01");
    expect((await replayAnswer(await prepareCase(REPO_ROOT, c), failure)).status).toBe("stale");
  });
});
