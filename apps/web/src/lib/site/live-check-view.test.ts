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
  hintParts,
  hintText,
  labelled,
  nextAnswer,
  payeeShown,
  rawPieces,
  type Shown,
  sentenceText,
  utcTime,
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
    const a = answerFromRecorded(recorded, "inflated");
    expect(a.verdict).toEqual({ ok: false, code: "OverPerPayment", wouldHold: false });
    // The hijack asks for 2 USDC: the contract allows it, to the mandate's own payee.
    expect(answerFromRecorded(recorded, "hijack").verdict).toEqual({
      ok: true,
      code: null,
      wouldHold: false,
    });
    expect(a.mandate?.id).toBe(1);
    expect(a.recorded).toBe(true);
    expect(answerFromRecorded(recorded, "nomandate").mandate).toBeNull();
  });

  it("carries the request it answers", () => {
    expect(answerFromRecorded(recorded, "inflated").request).toEqual({
      mandateId: 1,
      units: 50_000_000n,
      key: "agent",
      scenario: "inflated",
    });
    expect(answerFromRecorded(recorded, "hijack").request).toEqual({
      mandateId: 1,
      units: 2_000_000n,
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
  const inflated = answerFromRecorded(recorded, "inflated");
  // A hijacked prompt that asked for more than the limit: the tail says where the money would still go.
  const overHijack: Answer = { ...inflated, request: { ...inflated.request, scenario: "hijack" } };

  it("names the amount of its own request and the mandate's payee when the contract would pay", () => {
    expect(explain(normal, false, copy, codes)).toBe(
      "Inside the mandate. 2 USDC would go to probarion-payee.testnet, the payee the owner signed, whatever the prompt said.",
    );
  });

  it("says, for a hijacked prompt the contract allows, that only the mandate's payee is paid and why", () => {
    expect(explain(hijack, true, copy, codes)).toBe(
      "2 USDC would go only to probarion-payee.testnet, the mandate's payee: the request has no field for the attacker's address.",
    );
    // The same request without the hijack's invoice text is the normal invoice.
    expect(explain(hijack, false, copy, codes)).toBe(explain(normal, false, copy, codes));
  });

  it("adds, for a hijacked prompt over the limit, where the money would still go", () => {
    const s = explain(overHijack, true, copy, codes);
    expect(s).toContain(codes.OverPerPayment);
    expect(s).toContain("At 5 USDC or less it would still go to probarion-payee.testnet");
    expect(s).not.toContain("{");
  });

  it("adds the tail only when the contract refused the hijack for being over the limit", () => {
    for (const code of ["MandateExpired", "Frozen", "NotAgent", "NoMandate", "MandateInactive"]) {
      const a = { ...overHijack, verdict: { ok: false, code, wouldHold: false } };
      const s = explain(a, true, copy, codes);
      expect(s, code).toBe(codes[code]);
      expect(s, code).not.toContain("At 5 USDC");
    }
    expect(explain(overHijack, true, copy, codes)).toContain("At 5 USDC or less");
    expect(explain(inflated, false, copy, codes)).toBe(codes.OverPerPayment);
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
    const refused = { ...overHijack, mandate: undefined };
    expect(explain(refused, true, copy, codes)).toBe(codes.OverPerPayment);
    expect(explain({ ...hijack, mandate: undefined }, true, copy, codes)).toBe(
      "2 USDC would go only to the payee the owner signed: the request has no field for the attacker's address.",
    );
  });
});

describe("what the answer panel shows, by kind of state", () => {
  const normal = answerFromRecorded(recorded, "normal");
  const hijack = answerFromRecorded(recorded, "inflated");
  const injected = answerFromRecorded(recorded, "hijack");
  const nomandate = answerFromRecorded(recorded, "nomandate");
  const held: Answer = { ...normal, verdict: { ok: true, code: null, wouldHold: true } };
  const live: Answer = { ...normal, recorded: false, rpcHost: "rpc.testnet.fastnear.com" };
  const time = () => "12:00:00";
  const answer = (a: Answer): Shown => ({ kind: "answer", answer: a });
  const loading = (a: Answer): Shown => ({ kind: "loading", previous: a });
  const sentence = (s: Shown) => sentenceText(s, copy, codes, injectedIds);

  it("a live answer: the verdict word, its sentence, and where it came from, in UTC", () => {
    expect(verdictText(answer(live), copy)).toBe("Allow");
    expect(verdictTone(answer(live))).toBe("pay");
    expect(sentence(answer(live))).toBe(explain(live, false, copy, codes));
    expect(hintText(answer(live), copy, "v0.x", time)).toBe(
      `Answer from v0.x at block ${live.blockHeight}, 12:00:00 UTC. Raw: ${JSON.stringify(live.raw)}`,
    );
  });

  it("says warn, with its own tone, when the contract would hold for an approver", () => {
    expect(verdictText(answer(held), copy)).toBe("Warn: an approver decides");
    expect(verdictTone(answer(held))).toBe("hold");
    expect(verdictWord(held, copy)).toBe(copy.verdictHold);
  });

  it("a refusal is block, with the contract's code word for word, in the refuse tone", () => {
    expect(verdictText(answer(hijack), copy)).toBe("Block: OverPerPayment");
    expect(verdictTone(answer(hijack))).toBe("refuse");
    expect(verdictWord(nomandate, copy)).toBe("Block: NoMandate");
  });

  it("never shows a bare allow for the hijacked prompt: its headline says the attacker gets 0", () => {
    expect(verdictText(answer(injected), copy, injectedIds)).toBe("Allow. The attacker gets 0.");
    expect(verdictWord(injected, copy, true)).toBe(copy.verdictInjected);
    // The headline says the attacker gets 0; the sentence under it says why, and does not say it twice.
    expect(sentence(answer(injected))).toContain("no field for the attacker's address");
    expect(sentence(answer(injected))).not.toContain("attacker gets 0");
    // The normal invoice, the same request, is a plain allow.
    expect(verdictText(answer(normal), copy, injectedIds)).toBe("Allow");
    // A recorded fallback for the hijack says it too.
    const s: Shown = { kind: "failed", fallback: injected, reason: "transport" };
    expect(verdictText(s, copy, injectedIds)).toBe("Allow. The attacker gets 0.");
  });

  it("an inflated invoice is no hijack: its refusal has no tail", () => {
    expect(sentence(answer(hijack))).toBe(codes.OverPerPayment);
    expect(sentence(answer(normal))).not.toContain("At 5 USDC");
  });

  it("loading keeps the previous answer, described with the amount it was asked with", () => {
    // The controls may now hold 50 USDC: the previous answer says 2 USDC, as it was asked.
    const s = loading(normal);
    expect(sentence(s)).toContain("2 USDC would go to");
    expect(sentence(s)).not.toContain("50 USDC");
    expect(hintText(s, copy, "v0.x", time)).toBe("Asking v0.x…");
  });

  it("while asking, the headline says it is asking, in no verdict's tone, whatever was answered before", () => {
    // The previous verdict would read as the answer to the request that is out (the panel is also aria-busy then).
    for (const previous of [normal, hijack, held, null]) {
      const s: Shown = { kind: "loading", previous };
      expect(verdictText(s, copy)).toBe(copy.waiting);
      expect(verdictTone(s)).toBe("none");
    }
    expect(copy.waiting).toBe("Asking the testnet");
  });

  it("a recorded fallback says so and keeps the recorded request", () => {
    const s: Shown = { kind: "failed", fallback: hijack, reason: "transport" };
    expect(verdictText(s, copy)).toBe("Block: OverPerPayment");
    expect(verdictTone(s)).toBe("refuse");
    expect(sentence(s)).toBe(`${copy.failed} ${explain(hijack, false, copy, codes)}`);
    expect(hintText(s, copy, "v0.x", time)).toContain("Recorded answer from ");
  });

  it("a host that answered with something unreadable says so, not that no host answered", () => {
    const s: Shown = { kind: "failed", fallback: hijack, reason: "answer" };
    expect(sentence(s)).toBe(`${copy.failedAnswer} ${explain(hijack, false, copy, codes)}`);
    expect(sentence(s)).not.toContain("No RPC host answered");
    expect(verdictText(s, copy)).toBe("Block: OverPerPayment");
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

describe("hintParts: the line under the verdict, with its raw answer apart", () => {
  const normal = answerFromRecorded(recorded, "normal");
  const hijack = answerFromRecorded(recorded, "hijack");
  const live: Answer = { ...hijack, recorded: false, rpcHost: "rpc.testnet.fastnear.com" };
  const time = () => "19:01:00";
  const states: Shown[] = [
    { kind: "answer", answer: live },
    { kind: "answer", answer: normal },
    { kind: "loading", previous: normal },
    { kind: "loading", previous: null },
    { kind: "failed", fallback: hijack, reason: "transport" },
    { kind: "failed", fallback: hijack, reason: "answer" },
    { kind: "failed", fallback: null, reason: "transport" },
    { kind: "failed", fallback: normal, reason: "badAmount" },
  ];

  it("joins back to hintText in every state", () => {
    for (const s of states) {
      const p = hintParts(s, copy, "v0.x", time);
      expect(`${p.lead}${p.raw ?? ""}${p.tail}`).toBe(hintText(s, copy, "v0.x", time));
    }
  });

  it("gives a live answer's words, then its raw answer as the contract sent it", () => {
    expect(hintParts({ kind: "answer", answer: live }, copy, "v0.x", time)).toEqual({
      lead: `Answer from v0.x at block ${live.blockHeight}, 19:01:00 UTC. Raw: `,
      raw: JSON.stringify(live.raw),
      tail: "",
    });
  });

  it("dates a recorded answer, with its raw answer apart", () => {
    const p = hintParts({ kind: "answer", answer: normal }, copy, "v0.x", time);
    expect(p.lead).toBe(
      `Recorded answer from ${normal.at.slice(0, 10)}, block ${normal.blockHeight}. Raw: `,
    );
    expect(p.raw).toBe(JSON.stringify(normal.raw));
  });

  it("has no raw answer while asking, for a text that is not an amount, or with no answer", () => {
    expect(hintParts({ kind: "loading", previous: normal }, copy, "v0.x", time)).toEqual({
      lead: "Asking v0.x…",
      raw: null,
      tail: "",
    });
    for (const s of states.slice(6)) {
      expect(hintParts(s, copy, "v0.x", time)).toEqual({ lead: "", raw: null, tail: "" });
    }
  });

  it("never fills a slot that the raw answer itself holds", () => {
    const odd: Answer = { ...live, raw: { code: "{vault}" } };
    const p = hintParts({ kind: "answer", answer: odd }, copy, "v0.x", time);
    expect(p.raw).toBe('{"code":"{vault}"}');
  });

  it("keeps a template with no raw slot whole", () => {
    const plain = {
      ...copy,
      answeredAt: "Answer from {vault} at block {block}.",
    } as unknown as typeof copy;
    expect(hintParts({ kind: "answer", answer: live }, plain, "v0.x", time)).toEqual({
      lead: `Answer from v0.x at block ${live.blockHeight}.`,
      raw: null,
      tail: "",
    });
  });
});

describe("rawPieces", () => {
  it("cuts a raw answer after the commas between its members, and joins back to it", () => {
    const raw = '{"ok":false,"code":"OverPerPayment","would_hold":false}';
    expect(rawPieces(raw)).toEqual([
      '{"ok":false,',
      '"code":"OverPerPayment",',
      '"would_hold":false}',
    ]);
    expect(rawPieces(raw).join("")).toBe(raw);
  });

  it("leaves a comma inside a string, an escaped quote included, where it is", () => {
    const raw = JSON.stringify({ a: 'x,"y,z', b: 1 });
    expect(rawPieces(raw)).toEqual([`${JSON.stringify({ a: 'x,"y,z' }).slice(0, -1)},`, '"b":1}']);
    expect(rawPieces(raw).join("")).toBe(raw);
  });

  it("gives a raw answer with no comma as one piece, and nothing for an empty one", () => {
    expect(rawPieces("null")).toEqual(["null"]);
    expect(rawPieces("")).toEqual([]);
  });
});

describe("labelled", () => {
  it("cuts the method and the RPC lines into a label and a value at the first colon", () => {
    expect(labelled(copy.method)).toEqual({
      label: "Method",
      value: "`check_spend` (a view: nothing is signed and nothing is paid)",
    });
    expect(labelled("RPC: rpc.testnet.fastnear.com")).toEqual({
      label: "RPC",
      value: "rpc.testnet.fastnear.com",
    });
  });

  it("keeps a line with no label whole", () => {
    expect(labelled("check_spend")).toEqual({ label: "", value: "check_spend" });
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

describe("utcTime", () => {
  it("gives an ISO time in UTC, to the second, whatever the browser's zone", () => {
    expect(utcTime("2026-11-13T19:00:20.123Z")).toBe("19:00:20");
    expect(utcTime("2026-11-14T02:30:00+07:00")).toBe("19:30:00");
    expect(utcTime("not a time")).toBe("not a time");
  });
});
