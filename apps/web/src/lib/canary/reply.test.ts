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

  it("says how many minutes until the address may try again, rounded up from Retry-After", () => {
    const say = (s: number | null) =>
      text(describeReply(429, { error: "rate_limited", detail: "Try again in 61 s" }, s));
    expect(say(61)).toBe("You have used your attempts for now. Try again in 2 min.");
    expect(say(600)).toBe("You have used your attempts for now. Try again in 10 min.");
    expect(say(60)).toBe("You have used your attempts for now. Try again in 1 min.");
    expect(say(1)).toBe("You have used your attempts for now. Try again in 1 min.");
    expect(say(0)).toBe("You have used your attempts for now. Try again in 1 min.");
    expect(say(null)).toBe(REPLY_TEXT.rateLimitedLater);
  });

  it("says when the day's model budget comes back, in hours and minutes or in minutes", () => {
    const say = (s: number | null) => text(describeReply(429, { error: "budget" }, s));
    expect(say(600)).toBe("Today's model budget is used up. Try again in 10 min.");
    expect(say(5400)).toBe("Today's model budget is used up. Try again in 1 h 30 min.");
    expect(say(3601)).toBe("Today's model budget is used up. Try again in 1 h 1 min.");
    expect(say(7200)).toBe("Today's model budget is used up. Try again in 2 h 0 min.");
    expect(say(59)).toBe("Today's model budget is used up. Try again in 1 min.");
    expect(say(null)).toBe(REPLY_TEXT.budgetLater);
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
    expect(r).toEqual({
      kind: "error",
      text: "Another attempt is running. Try again in a few seconds.",
    });
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
      text: "You have used your attempts for now. Try again in 2 min.",
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
      text: "You have used your attempts for now. Try again in 6 min.",
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
