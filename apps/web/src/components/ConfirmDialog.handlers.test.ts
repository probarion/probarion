import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfirmOptions, ConfirmSource } from "@/lib/console/confirm-dialog";
import { type El, elements, mount, textOf } from "../../test/fixtures/mini-react";

// Which control gives which answer, held to the real handlers: the component is run as a plain function with its
// hooks replaced (test/fixtures/mini-react.ts), and the handlers it returns are called the way the browser would.
// The markup tests cannot see a handler, and the logic tests cover createAsker, not the component that calls it,
// so without this a swap of the two answers (Cancel confirms, the action cancels) would pass every other test.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  ...(await import("../../test/fixtures/mini-react")).hooks,
}));

import { ConfirmDialog } from "./ConfirmDialog";

const OPTIONS: ConfirmOptions = {
  title: "Approve",
  body: "Approve paying 5 USDC to bob.near (spend #7)?",
  actionLabel: "Approve",
};
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);

type Handler = (event?: unknown) => void;

/**
 * Opens the dialog at T0 on a clock the test controls. By default the owner has had time to read it (the action
 * button is held back for the first moments), so `waited: false` is for the tests of that hold.
 */
function open({ waited = true, options = OPTIONS } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const answers: ConfirmSource[] = [];
  const view = mount(() =>
    ConfirmDialog({ options, onSettle: (source: ConfirmSource) => answers.push(source) }),
  );
  if (waited) vi.setSystemTime(T0 + 1_000);
  const all = elements(view.result);
  const dialog = all.find((e) => e.type === "dialog") as El;
  const button = (label: string) => {
    const b = all.find((e) => e.type === "button" && textOf(e) === label);
    if (!b) throw new Error(`no ${label} button`);
    return b.props.onClick as Handler;
  };
  const on = (name: string) => dialog.props[name] as Handler;
  return { answers, dialog, button, on };
}

/** A DOM event with just what the handlers read. */
const event = (over: Record<string, unknown> = {}) => ({
  detail: 1,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ConfirmDialog's handlers: which control gives which answer", () => {
  it("the Cancel button answers no", () => {
    const { answers, button } = open();
    button("Cancel")(event());
    expect(answers).toEqual(["cancel-button"]);
  });

  it("the action button answers yes, and nothing else does", () => {
    const { answers, button } = open();
    button("Approve")(event());
    expect(answers).toEqual(["action"]);
  });

  it("Esc (the dialog's cancel event) answers no, and stops the browser closing the dialog itself", () => {
    const { answers, on } = open();
    const esc = event();
    on("onCancel")(esc);
    expect(answers).toEqual(["escape"]);
    expect(esc.preventDefault).toHaveBeenCalled();
  });

  it("a click on the backdrop (a press and a click on the dialog element itself) answers no", () => {
    const { answers, dialog, on } = open();
    on("onMouseDown")(event({ target: dialog }));
    on("onClick")(event({ target: dialog, currentTarget: dialog }));
    expect(answers).toEqual(["backdrop"]);
  });

  it("a click inside the panel does nothing", () => {
    const { answers, dialog, on } = open();
    const panel = { name: "panel" };
    on("onMouseDown")(event({ target: panel }));
    on("onClick")(event({ target: panel, currentTarget: dialog }));
    expect(answers).toEqual([]);
  });

  it("a selection dragged from the panel onto the backdrop does nothing", () => {
    const { answers, dialog, on } = open();
    on("onMouseDown")(event({ target: { name: "panel" } }));
    on("onClick")(event({ target: dialog, currentTarget: dialog }));
    expect(answers).toEqual([]);
  });

  it("a close the browser did on its own (the dialog's close event) answers no, as its own source", () => {
    const { answers, on } = open();
    on("onClose")(event());
    expect(answers).toEqual(["close"]);
  });

  it("keeps a click inside the dialog from reaching the page's handlers", () => {
    const { dialog, on } = open();
    const down = event({ target: dialog });
    const click = event({ target: dialog, currentTarget: dialog });
    on("onMouseDown")(down);
    on("onClick")(click);
    expect(down.stopPropagation).toHaveBeenCalled();
    expect(click.stopPropagation).toHaveBeenCalled();
  });
});

describe("ConfirmDialog's action button, held back after the dialog opens", () => {
  it("ignores a click on the action in the first moments (the second click of a double click on the opener)", () => {
    const { answers, button } = open({ waited: false });
    vi.setSystemTime(T0 + 50);
    button("Approve")(event());
    vi.setSystemTime(T0 + 399);
    button("Approve")(event());
    expect(answers).toEqual([]);
  });

  it("takes a click on the action once the guard time has passed", () => {
    const { answers, button } = open({ waited: false });
    vi.setSystemTime(T0 + 400);
    button("Approve")(event());
    expect(answers).toEqual(["action"]);
  });

  it("ignores the second click of a double click on the action itself, however late", () => {
    const { answers, button } = open();
    button("Approve")(event({ detail: 2 }));
    expect(answers).toEqual([]);
    button("Approve")(event({ detail: 1 }));
    expect(answers).toEqual(["action"]);
  });

  it("never holds Cancel back: the safe answer is always available", () => {
    const { answers, button } = open({ waited: false });
    button("Cancel")(event({ detail: 2 }));
    expect(answers).toEqual(["cancel-button"]);
  });
});

describe("ConfirmDialog's place in the page", () => {
  it("renders where it is when there is no document (the server render)", () => {
    const { dialog } = open();
    expect(dialog.type).toBe("dialog");
  });

  it("is rendered into document.body, away from the button's own ancestors, when there is a document", () => {
    const body = { nodeType: 1 };
    vi.stubGlobal("document", { body });
    const view = mount(() => ConfirmDialog({ options: OPTIONS, onSettle: () => {} }));
    const portal = view.result as unknown as { containerInfo: unknown; children: El };
    expect(portal.containerInfo).toBe(body);
    expect(portal.children.type).toBe("dialog");
  });
});
