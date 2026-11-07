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
    expect(text).toContain("The link could not be made. Try again in a minute.");
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
    expect(button().props.disabled).toBe(true);
    finish({ ok: true, link: LINK });
    await pending;
    view.flush();
    expect(textOf(button())).toBe("Create a Telegram link");
    expect(button().props.disabled).toBe(false);
  });
});
