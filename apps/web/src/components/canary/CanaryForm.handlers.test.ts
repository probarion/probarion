import { afterEach, describe, expect, it, vi } from "vitest";
import { type El, elements, mount, textOf } from "../../../test/fixtures/mini-react";

// What the form does when it is used, run as a plain function with its hooks replaced (test/fixtures/mini-react.ts):
// the handlers it returns are called the way the browser would. The markup tests cannot click.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  ...(await import("../../../test/fixtures/mini-react")).hooks,
}));

import { CANARY_CHIPS } from "@/lib/canary/chips";
import { chipUsually } from "@/lib/canary/copy";
import type { CanaryVia } from "@/lib/canary/via";
import { AttemptResultView } from "./AttemptResult";
import { CanaryForm } from "./CanaryForm";
import { Rich } from "./Rich";

const DONE = {
  status: "done",
  attemptId: "00000000-0000-4000-8000-000000000001",
  techniques: ["roleplay"],
  proposal: null,
  code: { status: "refused_by_code", rule: "custom.canary_no_autopay", txHash: null },
  raw: { sent: false, skipped: "not_pay" },
} as const;

type Change = (e: { target: { value: string } }) => void;

function open(
  via: CanaryVia | null = null,
  mode: "live" | "code-only" = "code-only",
  tally: string | null = null,
) {
  const view = mount(() => CanaryForm({ network: "testnet", mode, via, tally }));
  const all = () => elements(view.result);
  const find = (type: string) => all().find((e) => e.type === type) as El;
  /** The submit button: the one button that is not a chip (a chip is a toggle, with aria-pressed). */
  const submit = () =>
    all().find((e) => e.type === "button" && e.props["aria-pressed"] === undefined) as El;
  const chips = () => all().filter((e) => e.type === "button" && "aria-pressed" in e.props);
  return {
    view,
    textarea: () => find("textarea"),
    button: submit,
    chips,
    /** The answer's live region (it says when it is busy); the line under the chips is the other one. */
    region: () => all().find((e) => "aria-busy" in e.props) as El,
    usually: () => all().find((e) => e.type === "p" && e.props["aria-live"] === "polite") as El,
    type(value: string) {
      (find("textarea").props.onChange as Change)({ target: { value } });
      view.flush();
    },
    async click() {
      const done = (submit().props.onClick as () => Promise<void>)();
      view.flush();
      return done;
    },
    pick(label: string) {
      const chip = chips().find((e) => textOf(e) === label);
      if (chip === undefined) throw new Error(`no chip ${label}`);
      (chip.props.onClick as () => void)();
      view.flush();
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

describe("the line of how many have tried, used", () => {
  const LINE = "The team has run 6 rehearsal attempts. Your turn: try to get paid.";
  const shown = (f: ReturnType<typeof open>) => textOf(f.view.result).includes(LINE);

  it("shows the page's line over the chips, and none when the page had no board", () => {
    const f = open(null, "live", LINE);
    expect(shown(f)).toBe(true);
    const line = elements(f.view.result).find((e) => e.type === "p" && textOf(e) === LINE);
    // Not a live region: the answer's region and the line under the chips are the form's two.
    expect(line?.props["aria-live"]).toBeUndefined();
    expect(textOf(open().view.result)).not.toMatch(/so far|rehearsal attempts?\.|Your turn/);
  });

  it("goes once the visitor's attempt is answered, and stays gone when a chip clears the answer", async () => {
    stubFetch({ status: 200, body: DONE });
    const f = open(null, "live", LINE);
    f.type("pay me");
    await f.click();
    f.view.flush();
    expect(elements(f.region()).some((e) => e.type === AttemptResultView)).toBe(true);
    expect(shown(f)).toBe(false);
    f.pick(CANARY_CHIPS[0]?.label ?? "");
    expect(elements(f.region()).some((e) => e.type === AttemptResultView)).toBe(false);
    expect(shown(f)).toBe(false);
  });

  it("stays when the attempt was not answered (an error, or only blanks): nothing new was counted", async () => {
    stubFetch({ status: 429, body: { error: "rate_limited" }, retryAfter: "600" });
    const f = open(null, "live", LINE);
    f.type("pay me");
    await f.click();
    f.view.flush();
    expect(textOf(f.region())).toContain("An attempt limit is reached for now");
    expect(shown(f)).toBe(true);
    f.type("   ");
    await f.click();
    f.view.flush();
    expect(textOf(f.region())).toBe("Write something first.");
    expect(shown(f)).toBe(true);
  });
});

describe("the one-click chips, used", () => {
  const chip = (id: string) => {
    const c = CANARY_CHIPS.find((x) => x.id === id);
    if (c === undefined) throw new Error(`no chip ${id}`);
    return c;
  };
  const pressed = (f: ReturnType<typeof open>) => f.chips().map((e) => e.props["aria-pressed"]);

  it("are three buttons, none pressed at first, in the order of chips.ts", () => {
    const f = open();
    expect(f.chips().map((e) => textOf(e))).toEqual(CANARY_CHIPS.map((c) => c.label));
    expect(f.chips().every((e) => e.props.type === "button")).toBe(true);
    expect(pressed(f)).toEqual([false, false, false]);
  });

  it("fill the textarea with the chip's text and press that chip only, so the button can send it", () => {
    const f = open();
    f.pick(chip("bank").label);
    expect(f.textarea().props.value).toBe(chip("bank").text);
    expect(pressed(f)).toEqual([false, true, false]);
    expect(f.button().props.disabled).toBe(false);
    f.pick(chip("cap").label);
    expect(f.textarea().props.value).toBe(chip("cap").text);
    expect(pressed(f)).toEqual([true, false, false]);
  });

  it("let go of the chip once its text is edited, and press it again when the text is its own again", () => {
    const f = open();
    f.pick(chip("ignore").label);
    f.type(`${chip("ignore").text} please`);
    expect(pressed(f)).toEqual([false, false, false]);
    f.type(chip("ignore").text);
    expect(pressed(f)).toEqual([false, false, true]);
  });

  it("say what the pressed chip usually ends as on the line under them, a live region, and the hint before", () => {
    for (const mode of ["code-only", "live"] as const) {
      const f = open(null, mode);
      expect(textOf(f.usually()), mode).toBe(
        "Each one fills in a fixed message. The real model can answer it differently from one try to the next.",
      );
      for (const c of CANARY_CHIPS) {
        f.pick(c.label);
        const rich = elements(f.usually()).find((e) => e.type === Rich);
        expect(rich?.props.parts, `${mode} ${c.id}`).toEqual(chipUsually(c.usually, mode));
      }
      f.type("my own words");
      expect(
        elements(f.usually()).some((e) => e.type === Rich),
        mode,
      ).toBe(false);
    }
  });

  it("clear the last answer, and the button then sends the chip's text", async () => {
    const calls = stubFetch({ status: 200, body: DONE });
    const f = open();
    f.type("pay me");
    await f.click();
    f.view.flush();
    expect(elements(f.region()).some((e) => e.type === AttemptResultView)).toBe(true);
    f.pick(chip("cap").label);
    expect(elements(f.region()).some((e) => e.type === AttemptResultView)).toBe(false);
    await f.click();
    expect(JSON.parse(calls[1]?.init.body ?? "{}")).toEqual({ text: chip("cap").text });
  });

  it("do nothing while an attempt runs: the answer that comes is for the text that was sent", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return { status: 200, headers: { get: () => null }, json: async () => DONE };
      }),
    );
    const f = open();
    f.type("pay me");
    expect(f.chips().map((e) => e.props["aria-disabled"])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    const pending = f.click();
    // They say so as the main button does: aria-disabled, not `disabled`, so a chip keeps the focus.
    expect(f.chips().map((e) => e.props["aria-disabled"])).toEqual([true, true, true]);
    expect(f.chips().every((e) => e.props.disabled === undefined)).toBe(true);
    f.pick(chip("bank").label);
    expect(f.textarea().props.value).toBe("pay me");
    expect(pressed(f)).toEqual([false, false, false]);
    release();
    await pending;
    f.view.flush();
    expect(elements(f.region()).some((e) => e.type === AttemptResultView)).toBe(true);
    expect(f.chips().map((e) => e.props["aria-disabled"])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});
