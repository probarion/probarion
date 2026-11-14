import { describe, expect, it, vi } from "vitest";
import type { TelegramState } from "@/app/console/[vault]/alerts/actions";
import { elements, mount, textOf } from "../../../test/fixtures/mini-react";

// The click, held to the real handler: the component is run as a plain function with its hooks replaced
// (test/fixtures/mini-react.ts) and the handler it returned is called the way the browser would.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  ...(await import("../../../test/fixtures/mini-react")).hooks,
}));

import { TelegramConnect } from "./TelegramConnect";

const LINK = "https://t.me/ProbarionBot?start=0123456789abcdef0123456789abcdef";

function open(connect: () => Promise<TelegramState>) {
  const view = mount(() => TelegramConnect({ connect }));
  const button = () => {
    const b = elements(view.result).find((e) => e.type === "button");
    if (!b) throw new Error("no button");
    return b;
  };
  const click = async () => {
    const pending = (button().props.onClick as () => Promise<void>)();
    view.flush();
    await pending;
    view.flush();
  };
  return { view, button, click };
}

describe("TelegramConnect's button", () => {
  it("asks the server for a link when it is clicked, and shows it as a link that opens in a new tab", async () => {
    const connect = vi.fn(async (): Promise<TelegramState> => ({ ok: true, link: LINK }));
    const { view, click } = open(connect);
    await click();
    expect(connect).toHaveBeenCalledTimes(1);
    const link = elements(view.result).find((e) => e.props.href === LINK);
    expect(link).toBeDefined();
    expect(textOf(link)).toBe(LINK.replace("https://", ""));
    expect(textOf(view.result)).toContain("press Start");
  });

  it("says why when the server has no link to give, in its own words", async () => {
    const { view, click } = open(async () => ({
      ok: false,
      error: "Telegram alerts are not set up on this server.",
    }));
    await click();
    expect(textOf(view.result)).toContain("Telegram alerts are not set up on this server.");
    expect(elements(view.result).some((e) => typeof e.props.href === "string")).toBe(false);
  });

  it("says a plain sentence, never the exception, when the call itself fails", async () => {
    const { view, click } = open(async () => {
      throw new Error("Failed to fetch https://internal.example/secret");
    });
    await click();
    const text = textOf(view.result);
    // It may have made a link all the same, so the sentence says only that no answer came.
    expect(text).toContain(
      "The console got no answer. Making another link is harmless: try again.",
    );
    expect(text).not.toContain("internal.example");
  });

  it("shows it is working while the call is out, and lets the button be used again after", async () => {
    let finish: (s: TelegramState) => void = () => {};
    const { view, button } = open(
      () => new Promise<TelegramState>((resolve) => (finish = resolve)),
    );
    const pending = (button().props.onClick as () => Promise<void>)();
    view.flush();
    expect(textOf(button())).toBe("Making the link…");
    // Busy, not disabled: the button keeps the focus while the call is out.
    expect(button().props["aria-disabled"]).toBe(true);
    expect(button().props.disabled ?? false).toBe(false);
    finish({ ok: true, link: LINK });
    await pending;
    view.flush();
    expect(textOf(button())).toBe("Create a Telegram link");
    expect(button().props["aria-disabled"]).toBeUndefined();
    expect(button().props.disabled ?? false).toBe(false);
  });

  it("asks once when it is pressed again while the call is out", async () => {
    let finish: (s: TelegramState) => void = () => {};
    const connect = vi.fn(() => new Promise<TelegramState>((resolve) => (finish = resolve)));
    const { view, button } = open(connect);
    const press = () => (button().props.onClick as () => Promise<void>)();
    const first = press();
    const second = press(); // before the render that shows the first
    view.flush();
    const third = press();
    finish({ ok: true, link: LINK });
    await Promise.all([first, second, third]);
    view.flush();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(textOf(view.result)).toContain("press Start");
  });

  it("offers Try again when the call itself failed; it asks again under its own label while the main button waits", async () => {
    let calls = 0;
    let finish: (s: TelegramState) => void = () => {};
    const { view, click } = open(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("offline"));
      return new Promise<TelegramState>((resolve) => (finish = resolve));
    });
    await click();
    const buttons = () => elements(view.result).filter((e) => e.type === "button");
    const retry = () => {
      const b = buttons()[1];
      if (!b) throw new Error("no Try again");
      return b;
    };
    expect(textOf(retry())).toBe("Try again");
    const pending = (retry().props.onClick as () => Promise<void>)();
    view.flush();
    // Try again stays where it is, busy; the main button keeps its own label and waits.
    expect(textOf(retry())).toBe("Trying again…");
    expect(retry().props["aria-disabled"]).toBe(true);
    expect(textOf(buttons()[0])).toBe("Create a Telegram link");
    expect(buttons()[0]?.props["aria-disabled"]).toBe(true);
    finish({ ok: true, link: LINK });
    await pending;
    view.flush();
    expect(calls).toBe(2);
    expect(textOf(view.result)).toContain("press Start");
    expect(buttons()).toHaveLength(1);
  });

  it("offers no Try again for the server's own refusal: its words say what to do", async () => {
    const { view, click } = open(async () => ({
      ok: false,
      error: "This vault already has 20 alerts. Remove one first.",
    }));
    await click();
    expect(textOf(view.result)).toContain("Remove one first.");
    expect(elements(view.result).filter((e) => e.type === "button")).toHaveLength(1);
  });

  it("hands the focus from Try again to the main button before the notice that holds it gives way", async () => {
    let calls = 0;
    const { view, click } = open(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return { ok: true, link: LINK };
    });
    await click();
    const buttons = () => elements(view.result).filter((e) => e.type === "button");
    // mini-react attaches no refs: the test puts the two buttons in them, Try again focused.
    const retry: { ownerDocument?: { activeElement: unknown } } = {};
    retry.ownerDocument = { activeElement: retry };
    let seen = "";
    const main = {
      focus: vi.fn(() => {
        // Whatever the button has set by now is drawn: the notice must still be the old one.
        view.flush();
        seen = textOf(view.result);
      }),
    };
    (buttons()[0]?.props.ref as { current: unknown }).current = main;
    (buttons()[1]?.props.ref as { current: unknown }).current = retry;
    const tryAgain = buttons()[1];
    if (!tryAgain) throw new Error("no Try again");
    await (tryAgain.props.onClick as () => Promise<void>)();
    expect(main.focus).toHaveBeenCalledTimes(1);
    expect(seen).toContain("The console got no answer.");
    expect(seen).not.toContain("press Start");
    view.flush();
    expect(textOf(view.result)).toContain("press Start");
  });
});
