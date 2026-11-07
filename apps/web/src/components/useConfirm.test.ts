import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfirmOptions, ConfirmSource } from "@/lib/console/confirm-dialog";
import { type El, mount } from "../../test/fixtures/mini-react";

// The hook behind the dialog, run as a plain function with its hooks replaced (test/fixtures/mini-react.ts): the
// answer it gives, and where the focus goes back to once the dialog is gone.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  ...(await import("../../test/fixtures/mini-react")).hooks,
}));

import { useConfirm } from "./ConfirmDialog";

const OPTIONS: ConfirmOptions = {
  title: "Freeze vault",
  body: "Freeze?",
  actionLabel: "Freeze vault",
};
const element = (name: string) => ({ name, focus: vi.fn() });

/** The hook, mounted, and the owner's side of the dialog it renders. */
function setup() {
  const view = mount(() => useConfirm());
  const shown = () => (view.result.dialog as El).props.options as ConfirmOptions | null;
  const answer = (source: ConfirmSource) => {
    ((view.result.dialog as El).props.onSettle as (s: ConfirmSource) => void)(source);
    view.flush();
  };
  const ask = (options: ConfirmOptions, opener?: unknown) => {
    const answered = view.result.ask(options, opener as HTMLElement | undefined);
    view.flush();
    return answered;
  };
  return { view, shown, answer, ask };
}

afterEach(() => vi.unstubAllGlobals());

describe("useConfirm", () => {
  it("shows the question while it is open, and nothing before and after", async () => {
    vi.stubGlobal("document", { activeElement: null });
    const { shown, answer, ask } = setup();
    expect(shown()).toBeNull();
    const answered = ask(OPTIONS, element("opener"));
    expect(shown()).toEqual(OPTIONS);
    answer("action");
    expect(await answered).toBe(true);
    expect(shown()).toBeNull();
  });

  it("gives the focus back to the element it was told opened the question, not to whatever has it", async () => {
    const opener = element("the button that was clicked");
    const active = element("document.activeElement");
    vi.stubGlobal("document", { activeElement: active });
    const { answer, ask } = setup();
    const answered = ask(OPTIONS, opener);
    expect(opener.focus).not.toHaveBeenCalled(); // not while the dialog is still open
    answer("cancel-button");
    expect(await answered).toBe(false);
    expect(opener.focus).toHaveBeenCalledTimes(1);
    expect(active.focus).not.toHaveBeenCalled();
  });

  it("falls back to the element that had focus when no opener is passed", async () => {
    const active = element("document.activeElement");
    vi.stubGlobal("document", { activeElement: active });
    const { answer, ask } = setup();
    const answered = ask(OPTIONS);
    answer("escape");
    expect(await answered).toBe(false);
    expect(active.focus).toHaveBeenCalledTimes(1);
  });

  it("keeps the first question's opener when a second ask is turned away", async () => {
    const first = element("first opener");
    const second = element("second opener");
    vi.stubGlobal("document", { activeElement: null });
    const { shown, answer, ask } = setup();
    const a = ask(OPTIONS, first);
    const b = ask({ ...OPTIONS, title: "Withdraw" }, second);
    expect(await b).toBe(false);
    expect(shown()).toEqual(OPTIONS); // still the first question
    answer("backdrop");
    expect(await a).toBe(false);
    expect(first.focus).toHaveBeenCalledTimes(1);
    expect(second.focus).not.toHaveBeenCalled();
  });

  it("answers an open question no when the page goes away, so nothing waits for ever", async () => {
    vi.stubGlobal("document", { activeElement: null });
    const { view, ask } = setup();
    const answered = ask(OPTIONS, element("opener"));
    view.unmount();
    expect(await answered).toBe(false);
  });
});
