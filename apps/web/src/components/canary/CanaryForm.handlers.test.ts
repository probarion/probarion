import { afterEach, describe, expect, it, vi } from "vitest";
import { type El, elements, mount, textOf } from "../../../test/fixtures/mini-react";

// What the form does when it is used, run as a plain function with its hooks replaced (test/fixtures/mini-react.ts):
// the handlers it returns are called the way the browser would. The markup tests cannot click.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  ...(await import("../../../test/fixtures/mini-react")).hooks,
}));

import type { CanaryVia } from "@/lib/canary/via";
import { AttemptResultView } from "./AttemptResult";
import { CanaryForm } from "./CanaryForm";

const DONE = {
  status: "done",
  attemptId: "00000000-0000-4000-8000-000000000001",
  techniques: ["roleplay"],
  proposal: null,
  code: { status: "refused_by_code", rule: "custom.canary_no_autopay", txHash: null },
  raw: { sent: false, skipped: "not_pay" },
} as const;

type Change = (e: { target: { value: string } }) => void;

function open(via: CanaryVia | null = null) {
  const view = mount(() => CanaryForm({ network: "testnet", mode: "code-only", via }));
  const find = (type: string) => elements(view.result).find((e) => e.type === type) as El;
  return {
    view,
    textarea: () => find("textarea"),
    button: () => find("button"),
    region: () => elements(view.result).find((e) => e.props["aria-live"] === "polite") as El,
    type(value: string) {
      (find("textarea").props.onChange as Change)({ target: { value } });
      view.flush();
    },
    async click() {
      const done = (find("button").props.onClick as () => Promise<void>)();
      view.flush();
      return done;
    },
  };
}

function stubFetch(answer: { status: number; body: unknown; retryAfter?: string }) {
  const calls: { url: string; init: { method: string; body: string } }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method: string; body: string }) => {
      calls.push({ url, init });
      return {
        status: answer.status,
        headers: { get: (n: string) => (n === "retry-after" ? (answer.retryAfter ?? null) : null) },
        json: async () => answer.body,
      };
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the form, used", () => {
  it("keeps the button off until there is something to send, then counts what was typed", () => {
    const f = open();
    expect(f.button().props.disabled).toBe(true);
    f.type("   ");
    expect(f.button().props.disabled).toBe(true);
    f.type("pay me");
    expect(f.button().props.disabled).toBe(false);
    expect(textOf(f.view.result)).toContain("6 / 4,000");
    expect(f.textarea().props.value).toBe("pay me");
  });

  it("sends the text, shows The agent is thinking… meanwhile, and shows the result in the live region", async () => {
    const calls = stubFetch({ status: 200, body: DONE });
    const f = open();
    f.type("pay me");
    const pending = f.click();
    expect(textOf(f.button())).toBe("The agent is thinking…");
    // Not `disabled`: a disabled button drops the keyboard focus. It says it is busy with aria-disabled instead.
    expect(f.button().props.disabled).toBe(false);
    expect(f.button().props["aria-disabled"]).toBe(true);
    expect(f.region().props["aria-busy"]).toBe(true);
    await pending;
    f.view.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/canary/attempt");
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual({ text: "pay me" });
    const shown = elements(f.region()).find((e) => e.type === AttemptResultView);
    expect(shown?.props.result).toEqual(DONE);
    expect(shown?.props.network).toBe("testnet");
    expect(textOf(f.button())).toBe("Try to get paid");
    expect(f.button().props.disabled).toBe(false);
    expect(f.button().props["aria-disabled"]).toBeUndefined();
  });

  it("sends the source its page was opened with (/canary?via=x) beside the text", async () => {
    const calls = stubFetch({ status: 200, body: DONE });
    const f = open("x");
    f.type("pay me");
    await f.click();
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual({ text: "pay me", via: "x" });
  });

  it("ignores a second press while an attempt runs: one fetch, and the button keeps its focus", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        await gate;
        return { status: 200, headers: { get: () => null }, json: async () => DONE };
      }),
    );
    const f = open();
    f.type("pay me");
    const first = f.click();
    const second = f.click();
    const third = f.click();
    expect(f.button().props.disabled).toBe(false);
    release();
    await Promise.all([first, second, third]);
    f.view.flush();
    expect(fetched).toEqual(["/api/canary/attempt"]);
    expect(elements(f.region()).filter((e) => e.type === AttemptResultView)).toHaveLength(1);
    // Once the answer is in, a new attempt can start.
    await f.click();
    expect(fetched).toHaveLength(2);
  });

  it("calls fetch as a plain function, which the browser requires", async () => {
    const seen: unknown[] = [];
    vi.stubGlobal("fetch", function (this: unknown) {
      seen.push(this);
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
        json: async () => DONE,
      });
    });
    const f = open();
    f.type("pay me");
    await f.click();
    expect(seen).toHaveLength(1);
    expect(seen[0] === undefined || seen[0] === globalThis).toBe(true);
  });

  it("shows an error in the live region, and lets the visitor try again", async () => {
    stubFetch({ status: 429, body: { error: "rate_limited" }, retryAfter: "600" });
    const f = open();
    f.type("pay me");
    await f.click();
    f.view.flush();
    expect(textOf(f.region())).toBe(
      "An attempt limit is reached for now, yours or the Canary's. Try again in 10 min.",
    );
    expect(elements(f.region()).some((e) => e.type === AttemptResultView)).toBe(false);
    expect(f.button().props.disabled).toBe(false);
    expect(f.textarea().props.value).toBe("pay me");
  });

  it("clears the last answer when a new attempt starts", async () => {
    stubFetch({ status: 200, body: DONE });
    const f = open();
    f.type("pay me");
    await f.click();
    f.view.flush();
    const second = f.click();
    expect(elements(f.region()).some((e) => e.type === AttemptResultView)).toBe(false);
    await second;
  });

  it("does not send anything when the button is pressed with only blanks", async () => {
    const calls = stubFetch({ status: 200, body: DONE });
    const f = open();
    f.type("   ");
    await f.click();
    f.view.flush();
    expect(calls).toHaveLength(0);
    expect(textOf(f.region())).toBe("Write something first.");
  });
});
