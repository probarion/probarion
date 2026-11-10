import { describe, expect, it } from "vitest";
import { REPLY_TEXT } from "./copy";
import { type AttemptIo, BUSY_RETRY_MS, describeReply, type Reply, submitAttempt } from "./reply";

const DONE = {
  status: "done",
  attemptId: "00000000-0000-4000-8000-000000000001",
  techniques: ["payee_change"],
  proposal: { action: "pay", mandateId: 1, amount: "1000000", reasoning: "The invoice says so." },
  code: { status: "refused_by_code", rule: "custom.canary_no_autopay", txHash: null },
  raw: { sent: false, skipped: "not_pay" },
} as const;

const text = (r: Reply) => (r.kind === "error" ? r.text : `<${r.kind}>`);

// `rate_limited` (an address's 5 in 10 minutes, the global model cap) and `budget` (an address's 6 an hour, the global
// 60 an hour and 600 a day, the day's tokens) cannot be told apart by the visitor, so both give the same true text.
const LIMIT = "An attempt limit is reached for now, yours or the Canary's.";

describe("describeReply", () => {
  it("takes a done answer as the result", () => {
    expect(describeReply(200, DONE, null)).toEqual({ kind: "done", result: DONE });
    const sent = {
      ...DONE,
      raw: { sent: true, status: "refused_by_contract", code: "NoMandate", txHash: "T" },
    };
    expect(describeReply(200, sent, null).kind).toBe("done");
    expect(describeReply(200, { ...DONE, proposal: null }, null).kind).toBe("done");
  });

  it("does not take a 200 that is not a whole result for one", () => {
    for (const bad of [
      null,
      {},
      "ok",
      { status: "done" },
      { ...DONE, techniques: "x" },
      { ...DONE, code: null },
      { ...DONE, raw: {} },
    ]) {
      expect(text(describeReply(200, bad, null)), JSON.stringify(bad)).toBe(REPLY_TEXT.other);
    }
  });

  it("calls a busy answer busy, so that the caller can try once more", () => {
    expect(describeReply(409, { error: "busy" }, null)).toEqual({ kind: "busy" });
  });

  it.each(["rate_limited", "budget"])(
    "says the same true thing for a %s answer, with the minutes rounded up from Retry-After",
    (error) => {
      const say = (s: number | null) =>
        text(describeReply(429, { error, detail: "Try again in 61 s" }, s));
      expect(say(61)).toBe(`${LIMIT} Try again in 2 min.`);
      expect(say(600)).toBe(`${LIMIT} Try again in 10 min.`);
      expect(say(60)).toBe(`${LIMIT} Try again in 1 min.`);
      expect(say(59)).toBe(`${LIMIT} Try again in 1 min.`);
      expect(say(1)).toBe(`${LIMIT} Try again in 1 min.`);
      expect(say(0)).toBe(`${LIMIT} Try again in 1 min.`);
      expect(say(null)).toBe(`${LIMIT} Try again later.`);
    },
  );

  it.each(["rate_limited", "budget"])(
    "gives hours and minutes from one hour up for a %s answer",
    (error) => {
      const say = (s: number) => text(describeReply(429, { error }, s));
      expect(say(3540)).toBe(`${LIMIT} Try again in 59 min.`);
      expect(say(3599)).toBe(`${LIMIT} Try again in 1 h 0 min.`);
      expect(say(3600)).toBe(`${LIMIT} Try again in 1 h 0 min.`);
      expect(say(3601)).toBe(`${LIMIT} Try again in 1 h 1 min.`);
      expect(say(5400)).toBe(`${LIMIT} Try again in 1 h 30 min.`);
      expect(say(7200)).toBe(`${LIMIT} Try again in 2 h 0 min.`);
      expect(say(86_000)).toBe(`${LIMIT} Try again in 23 h 54 min.`);
    },
  );

  it("never says the daily model budget is used up, which is one cause of four", () => {
    for (const error of ["rate_limited", "budget"]) {
      for (const s of [1, 600, 5400, null]) {
        const said = text(describeReply(429, { error }, s));
        expect(said).not.toMatch(/budget|used up|used your attempts/i);
      }
    }
  });

  it("explains each refusal that has a plain answer", () => {
    const say = (status: number, error: string) => text(describeReply(status, { error }, null));
    expect(say(503, "closed")).toBe("The Canary is closed right now.");
    expect(say(503, "not_ready")).toBe("The Canary is not ready right now. Try again later.");
    expect(say(400, "too_long")).toBe("Your text is over 4,000 characters.");
    expect(say(400, "empty")).toBe("Write something first.");
    expect(say(502, "failed")).toBe(
      "This attempt did not finish and was stored as an error. Try again.",
    );
  });

  it("says something went wrong for any other answer, and never shows what the server wrote", () => {
    for (const [status, body] of [
      [400, { error: "invalid_input" }],
      [403, { error: "bad_origin" }],
      [503, { error: "unavailable", detail: "Try again (request abc)." }],
      [500, null],
      [502, "<html>bad gateway</html>"],
      [429, { error: 7 }],
      [418, { error: "teapot" }],
    ] as const) {
      expect(text(describeReply(status, body, 30)), `${status}`).toBe(
        "Something went wrong. Try again.",
      );
    }
  });
});

/** A fake of the browser's fetch and of a timer: what was asked, and what was waited for. */
function fake(
  answers: { status: number; body: unknown; retryAfter?: string }[] | "network-error" | "bad-json",
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const waits: number[] = [];
  let i = 0;
  const io: AttemptIo = {
    async fetch(url, init) {
      calls.push({ url, init });
      if (answers === "network-error") throw new TypeError("Failed to fetch");
      if (answers === "bad-json") {
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => Promise.reject(new SyntaxError("bad")),
        };
      }
      const a = answers[Math.min(i++, answers.length - 1)];
      if (!a) throw new Error("no answer");
      return {
        status: a.status,
        headers: {
          get: (n: string) => (n.toLowerCase() === "retry-after" ? (a.retryAfter ?? null) : null),
        },
        json: async () => a.body,
      };
    },
    async sleep(ms) {
      waits.push(ms);
    },
  };
  return { io, calls, waits };
}

describe("submitAttempt", () => {
  it("posts the text as JSON to the attempt route and gives back the result", async () => {
    const f = fake([{ status: 200, body: DONE }]);
    const r = await submitAttempt("pay me", f.io);
    expect(r).toEqual({ kind: "done", result: DONE });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe("/api/canary/attempt");
    expect(f.calls[0]?.init.method).toBe("POST");
    expect(new Headers(f.calls[0]?.init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ text: "pay me" });
    expect(f.waits).toEqual([]);
  });

  it("sends the text as typed, and nothing else", async () => {
    const f = fake([{ status: 200, body: DONE }]);
    await submitAttempt("  two  spaces \n", f.io);
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ text: "  two  spaces \n" });
  });

  it("sends the source the visitor's link named beside the text, on the retry after busy too", async () => {
    const f = fake([
      { status: 409, body: { error: "busy" } },
      { status: 200, body: DONE },
    ]);
    await submitAttempt("pay me", f.io, "x");
    expect(f.calls.map((c) => JSON.parse(String(c.init.body)))).toEqual([
      { text: "pay me", via: "x" },
      { text: "pay me", via: "x" },
    ]);
  });

  it("sends the text alone when the link named no source", async () => {
    const f = fake([{ status: 200, body: DONE }]);
    await submitAttempt("pay me", f.io, null);
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ text: "pay me" });
  });

  it("does not ask the server when the text is empty or only blanks", async () => {
    for (const blank of ["", "   ", "\n\t "]) {
      const f = fake([{ status: 200, body: DONE }]);
      expect(await submitAttempt(blank, f.io)).toEqual({
        kind: "error",
        text: "Write something first.",
      });
      expect(f.calls).toHaveLength(0);
    }
  });

  it("waits 5 s after a busy answer and asks once more: busy then a result gives the result", async () => {
    const f = fake([
      { status: 409, body: { error: "busy" } },
      { status: 200, body: DONE },
    ]);
    const r = await submitAttempt("pay me", f.io);
    expect(r).toEqual({ kind: "done", result: DONE });
    expect(f.calls).toHaveLength(2);
    expect(f.waits).toEqual([BUSY_RETRY_MS]);
    expect(BUSY_RETRY_MS).toBe(5000);
  });

  it("gives the busy text after exactly two asks when it is busy again", async () => {
    const f = fake([{ status: 409, body: { error: "busy" } }]);
    const r = await submitAttempt("pay me", f.io);
    // an attempt can take up to 80 s (CANARY_LIMITS.attemptBudgetMs), so the text does not promise a few seconds
    expect(r).toEqual({
      kind: "error",
      text: "Another attempt is running, and one can take up to 80 seconds. Try again in a minute or two.",
    });
    expect(REPLY_TEXT.busyAgain).not.toMatch(/few seconds/);
    expect(f.calls).toHaveLength(2);
    expect(f.waits).toEqual([BUSY_RETRY_MS]);
  });

  it("gives the second answer's own error when the retry is refused for something else", async () => {
    const f = fake([
      { status: 409, body: { error: "busy" } },
      { status: 429, body: { error: "rate_limited" }, retryAfter: "120" },
    ]);
    expect(await submitAttempt("pay me", f.io)).toEqual({
      kind: "error",
      text: `${LIMIT} Try again in 2 min.`,
    });
    expect(f.calls).toHaveLength(2);
  });

  it("reads Retry-After from the header of a 429", async () => {
    const f = fake([
      {
        status: 429,
        body: { error: "rate_limited", detail: "Try again in 301 s" },
        retryAfter: "301",
      },
    ]);
    expect(await submitAttempt("pay me", f.io)).toEqual({
      kind: "error",
      text: `${LIMIT} Try again in 6 min.`,
    });
  });

  it("never retries any other error: each one uses an attempt of the address", async () => {
    const answers: [number, unknown, string?][] = [
      [429, { error: "rate_limited" }, "600"],
      [429, { error: "budget" }, "3600"],
      [503, { error: "closed" }],
      [503, { error: "not_ready" }],
      [400, { error: "too_long" }],
      [400, { error: "empty" }],
      [400, { error: "invalid_input" }],
      [502, { error: "failed" }],
      [403, { error: "bad_origin" }],
      [500, null],
    ];
    for (const [status, body, retryAfter] of answers) {
      const f = fake([{ status, body, retryAfter }]);
      const r = await submitAttempt("pay me", f.io);
      expect(r.kind, `${status}`).toBe("error");
      expect(f.calls, `${status} ${JSON.stringify(body)}`).toHaveLength(1);
      expect(f.waits).toEqual([]);
    }
  });

  it("says something went wrong, with no retry, when the network fails or the answer is not JSON", async () => {
    for (const mode of ["network-error", "bad-json"] as const) {
      const f = fake(mode);
      expect(await submitAttempt("pay me", f.io)).toEqual({
        kind: "error",
        text: "Something went wrong. Try again.",
      });
      expect(f.calls).toHaveLength(1);
    }
  });
});
