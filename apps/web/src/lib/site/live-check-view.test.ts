import { describe, expect, it } from "vitest";
import { LIVE_CHECK } from "@/lib/site/facts";
import recordedJson from "@/lib/site/live-check-recorded.json";
import type { RecordedFile } from "./live-check";
import { answerFromRecorded, explain, nextAnswer, type Shown } from "./live-check-view";

const recorded = recordedJson as unknown as RecordedFile;
const { copy, codes } = LIVE_CHECK;

describe("answerFromRecorded", () => {
  it("is the recorded verdict and mandate of the scenario, marked as recorded", () => {
    const a = answerFromRecorded(recorded, "hijack");
    expect(a.verdict).toEqual({ ok: false, code: "OverPerPayment", wouldHold: false });
    expect(a.mandate?.id).toBe(1);
    expect(a.recorded).toBe(true);
    expect(answerFromRecorded(recorded, "nomandate").mandate).toBeNull();
  });
});

describe("explain", () => {
  const normal = answerFromRecorded(recorded, "normal");
  const hijack = answerFromRecorded(recorded, "hijack");

  it("names the amount and the mandate's payee when the contract would pay", () => {
    expect(explain(normal, 2_000_000n, false, copy, codes)).toBe(
      "Inside the mandate. 2 USDC would go to probarion-payee.testnet, the payee the owner signed, whatever the prompt said.",
    );
  });

  it("adds, for a hijacked prompt, where the money would still go", () => {
    const s = explain(hijack, 50_000_000n, true, copy, codes);
    expect(s).toContain(codes.OverPerPayment);
    expect(s).toContain("At 5 USDC or less it would still go to probarion-payee.testnet");
    expect(s).not.toContain("{");
  });

  it("says what the contract said for a code it has no sentence for", () => {
    const a = { ...hijack, verdict: { ok: false, code: "SomethingNew", wouldHold: false } };
    expect(explain(a, 1n, false, copy, codes)).toBe("The contract refused it with SomethingNew.");
  });

  it("says held when the contract would hold it", () => {
    const a = { ...normal, verdict: { ok: true, code: null, wouldHold: true } };
    expect(explain(a, 1n, false, copy, codes)).toBe(copy.held);
  });
});

describe("nextAnswer", () => {
  const a: Shown = { kind: "answer", answer: answerFromRecorded(recorded, "normal") };
  const b: Shown = { kind: "answer", answer: answerFromRecorded(recorded, "hijack") };

  it("takes the answer to the latest request", () => {
    expect(nextAnswer(a, 2, { seq: 2, shown: b })).toBe(b);
  });

  it("drops an answer to an older request that arrives late", () => {
    expect(nextAnswer(b, 3, { seq: 2, shown: a })).toBe(b);
  });
});
