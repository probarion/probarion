import { describe, expect, it } from "vitest";
import { LIVE_CHECK } from "@/lib/site/facts";
import recordedJson from "@/lib/site/live-check-recorded.json";
import { LiveCheckError, OTHER_PK, type RecordedFile } from "./live-check";
import {
  type Answer,
  agentKeyFor,
  amountLine,
  answerFromRecorded,
  explain,
  failureKind,
  hintText,
  nextAnswer,
  payeeShown,
  type Shown,
  sentenceText,
  verdictText,
  verdictTone,
  verdictWord,
} from "./live-check-view";

const recorded = recordedJson as unknown as RecordedFile;
const { copy, codes } = LIVE_CHECK;
const injectedIds = new Set(
  LIVE_CHECK.scenarios.filter((x) => "injected" in x).map((x) => x.id as string),
);

describe("answerFromRecorded", () => {
  it("is the recorded verdict and mandate of the scenario, marked as recorded", () => {
    const a = answerFromRecorded(recorded, "hijack");
    expect(a.verdict).toEqual({ ok: false, code: "OverPerPayment", wouldHold: false });
    expect(a.mandate?.id).toBe(1);
    expect(a.recorded).toBe(true);
    expect(answerFromRecorded(recorded, "nomandate").mandate).toBeNull();
  });

  it("carries the request it answers", () => {
    expect(answerFromRecorded(recorded, "hijack").request).toEqual({
      mandateId: 1,
      units: 50_000_000n,
      key: "agent",
      scenario: "hijack",
    });
    expect(answerFromRecorded(recorded, "nomandate").request.mandateId).toBe(999);
    expect(answerFromRecorded(recorded, "otherkey").request.key).toBe("other");
  });
});

describe("explain", () => {
  const normal = answerFromRecorded(recorded, "normal");
  const hijack = answerFromRecorded(recorded, "hijack");

  it("names the amount of its own request and the mandate's payee when the contract would pay", () => {
    expect(explain(normal, false, copy, codes)).toBe(
      "Inside the mandate. 2 USDC would go to probarion-payee.testnet, the payee the owner signed, whatever the prompt said.",
    );
  });

  it("adds, for a hijacked prompt, where the money would still go", () => {
    const s = explain(hijack, true, copy, codes);
    expect(s).toContain(codes.OverPerPayment);
    expect(s).toContain("At 5 USDC or less it would still go to probarion-payee.testnet");
    expect(s).not.toContain("{");
  });

  it("adds the tail only when the contract refused the hijack for being over the limit", () => {
    for (const code of ["MandateExpired", "Frozen", "NotAgent", "NoMandate", "MandateInactive"]) {
      const a = { ...hijack, verdict: { ok: false, code, wouldHold: false } };
      const s = explain(a, true, copy, codes);
      expect(s, code).toBe(codes[code]);
      expect(s, code).not.toContain("At 5 USDC");
    }
    expect(explain(hijack, true, copy, codes)).toContain("At 5 USDC or less");
  });

  it("looks a code up as its own key, never as something every object has", () => {
    for (const code of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const a = { ...hijack, verdict: { ok: false, code, wouldHold: false } };
      expect(explain(a, false, copy, codes), code).toBe(`The contract refused it with ${code}.`);
    }
  });

  it("says what the contract said for a code it has no sentence for", () => {
    const a = { ...hijack, verdict: { ok: false, code: "SomethingNew", wouldHold: false } };
    expect(explain(a, false, copy, codes)).toBe("The contract refused it with SomethingNew.");
  });

  it("says held when the contract would hold it", () => {
    const a = { ...normal, verdict: { ok: true, code: null, wouldHold: true } };
    expect(explain(a, false, copy, codes)).toBe(copy.held);
  });

  it("does not name a payee it could not read", () => {
    const a: Answer = { ...normal, mandate: undefined };
    const s = explain(a, false, copy, codes);
    expect(s).toBe(
      "Inside the mandate. 2 USDC would be paid to the payee the owner signed, whatever the prompt said.",
    );
    const refused = { ...hijack, mandate: undefined };
    expect(explain(refused, true, copy, codes)).toBe(codes.OverPerPayment);
  });
});

describe("what the answer panel shows, by kind of state", () => {
  const normal = answerFromRecorded(recorded, "normal");
  const hijack = answerFromRecorded(recorded, "hijack");
  const nomandate = answerFromRecorded(recorded, "nomandate");
  const held: Answer = { ...normal, verdict: { ok: true, code: null, wouldHold: true } };
  const live: Answer = { ...normal, recorded: false, rpcHost: "rpc.testnet.fastnear.com" };
  const time = () => "12:00:00";
  const answer = (a: Answer): Shown => ({ kind: "answer", answer: a });
  const loading = (a: Answer): Shown => ({ kind: "loading", previous: a });
  const sentence = (s: Shown) => sentenceText(s, copy, codes, injectedIds);

  it("a live answer: the verdict word, its sentence, and where it came from", () => {
    expect(verdictText(answer(live), copy)).toBe("Would pay");
    expect(verdictTone(answer(live))).toBe("pay");
    expect(sentence(answer(live))).toBe(explain(live, false, copy, codes));
    expect(hintText(answer(live), copy, "v0.x", time)).toBe(
      `Answer from v0.x at block ${live.blockHeight}, 12:00:00. Raw: ${JSON.stringify(live.raw)}`,
    );
  });

  it("says held, with its own tone, when the contract would hold", () => {
    expect(verdictText(answer(held), copy)).toBe("Held for a person");
    expect(verdictTone(answer(held))).toBe("hold");
    expect(verdictWord(held, copy)).toBe(copy.verdictHold);
  });

  it("a refusal shows the contract's code word for word, in the refuse tone", () => {
    expect(verdictText(answer(hijack), copy)).toBe("OverPerPayment");
    expect(verdictTone(answer(hijack))).toBe("refuse");
    expect(verdictWord(nomandate, copy)).toBe("NoMandate");
  });

  it("a hijacked request gets the tail, because its own request is the hijack scenario", () => {
    expect(sentence(answer(hijack))).toContain("At 5 USDC or less");
    expect(sentence(answer(normal))).not.toContain("At 5 USDC");
  });

  it("loading keeps the previous answer, described with the amount it was asked with", () => {
    // The controls may now hold 50 USDC: the previous answer says 2 USDC, as it was asked.
    const s = loading(normal);
    expect(sentence(s)).toContain("2 USDC would go to");
    expect(sentence(s)).not.toContain("50 USDC");
    expect(verdictText(s, copy)).toBe("Would pay");
    expect(hintText(s, copy, "v0.x", time)).toBe("Asking v0.x…");
  });

  it("a recorded fallback says so and keeps the recorded request", () => {
    const s: Shown = { kind: "failed", fallback: hijack, reason: "transport" };
    expect(verdictText(s, copy)).toBe("OverPerPayment");
    expect(verdictTone(s)).toBe("refuse");
    expect(sentence(s)).toBe(`${copy.failed} ${explain(hijack, true, copy, codes)}`);
    expect(hintText(s, copy, "v0.x", time)).toContain("Recorded answer from ");
  });

  it("a host that answered with something unreadable says so, not that no host answered", () => {
    const s: Shown = { kind: "failed", fallback: hijack, reason: "answer" };
    expect(sentence(s)).toBe(`${copy.failedAnswer} ${explain(hijack, true, copy, codes)}`);
    expect(sentence(s)).not.toContain("No RPC host answered");
    expect(verdictText(s, copy)).toBe("OverPerPayment");
    expect(hintText(s, copy, "v0.x", time)).toContain("Recorded answer from ");
    const bare: Shown = { kind: "failed", fallback: null, reason: "answer" };
    expect(sentence(bare)).toBe(copy.failedAnswerNoRecord);
    expect(sentence(bare)).not.toContain("No RPC host answered");
    expect(verdictText(bare, copy)).toBe(copy.noAnswer);
  });

  it("asking again after a failure with no recorded answer shows that it is asking", () => {
    const s: Shown = { kind: "loading", previous: null };
    expect(verdictText(s, copy)).toBe(copy.waiting);
    expect(verdictTone(s)).toBe("none");
    expect(sentence(s)).toBe("");
    expect(hintText(s, copy, "v0.x", time)).toBe("Asking v0.x…");
  });

  it("no answer and nothing recorded for these fields", () => {
    const s: Shown = { kind: "failed", fallback: null, reason: "transport" };
    expect(verdictText(s, copy)).toBe(copy.noAnswer);
    expect(verdictTone(s)).toBe("none");
    expect(sentence(s)).toBe(copy.failedNoRecord);
    expect(hintText(s, copy, "v0.x", time)).toBe("");
  });

  it("a text that is not an amount: its own title, a neutral tone, no old answer in the hint", () => {
    for (const fallback of [normal, null]) {
      const s: Shown = { kind: "failed", fallback, reason: "badAmount" };
      expect(verdictText(s, copy)).toBe(copy.notAmountTitle);
      expect(verdictTone(s)).toBe("none");
      expect(sentence(s)).toBe(copy.badAmount);
      expect(hintText(s, copy, "v0.x", time)).toBe("");
    }
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

describe("failureKind", () => {
  it("is transport when no host answered, and answer when a host answered with something else", () => {
    expect(failureKind(new LiveCheckError("transport", "x"))).toBe("transport");
    expect(failureKind(new LiveCheckError("rpc", "x"))).toBe("answer");
    expect(failureKind(new LiveCheckError("contract", "x"))).toBe("answer");
    expect(failureKind(new TypeError("fetch failed"))).toBe("transport");
    expect(failureKind("boom")).toBe("transport");
  });
});

describe("payeeShown", () => {
  const normal = answerFromRecorded(recorded, "normal");
  const stale = { ...normal, mandate: undefined };

  it("is the recorded payee of the chosen mandate, whatever answer is on screen", () => {
    // A payee never changes on chain: the controls point at mandate 2, the answer is still mandate 1's.
    const two = payeeShown(recorded, 2, normal);
    expect(two).toMatchObject({ type: "intents", chain: "base" });
    expect(payeeShown(recorded, 1, stale)).toEqual({
      type: "near",
      account_id: "probarion-payee.testnet",
    });
  });

  it("is none for a mandate the record knows is not there", () => {
    expect(payeeShown(recorded, 999, normal)).toBeNull();
  });

  it("falls back to the answer's own mandate only when the answer is for this id", () => {
    const bare = { ...recorded, mandates: {} };
    expect(payeeShown(bare, 1, normal)).toEqual(normal.mandate?.payee);
    expect(payeeShown(bare, 2, normal)).toBeUndefined();
    expect(payeeShown(bare, 1, null)).toBeUndefined();
    expect(payeeShown(bare, 1, stale)).toBeUndefined();
  });
});

describe("agentKeyFor", () => {
  const key = "ed25519:5errZXjDMXpk51BLypA3hBRUfBfh9v4bHeyU9vRmzYFK";

  it("is the agent key the chosen mandate names", () => {
    expect(agentKeyFor(recorded, 1)).toBe(key);
    expect(agentKeyFor(recorded, 2)).toBe(key);
    const other = {
      ...recorded,
      mandates: {
        ...recorded.mandates,
        "2": { ...(recorded.mandates["2"] as object), agent_pk: "ed25519:Other" },
      },
    };
    expect(agentKeyFor(other, 2)).toBe("ed25519:Other");
    expect(agentKeyFor(other, 1)).toBe(key);
  });

  it("falls back to mandate 1's key for an id with no mandate, and to the other key with none at all", () => {
    expect(agentKeyFor(recorded, 999)).toBe(key);
    expect(agentKeyFor({ ...recorded, mandates: {} }, 1)).toBe(OTHER_PK);
  });
});

describe("amountLine", () => {
  it("shows the units and the USDC amount for an amount", () => {
    expect(amountLine("2", copy)).toBe('amount: "2000000",  // 2 USDC');
  });

  it("quotes a text that is not an amount as it was typed, and says so", () => {
    expect(amountLine("1,5", copy)).toBe('amount: "1,5",  // not an amount');
    expect(amountLine('a"b', copy)).toBe('amount: "a\\"b",  // not an amount');
  });
});
