import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type El, elements, mount, textOf } from "../../../test/fixtures/mini-react";

// The Raw mode pill and its tooltip: the markup as React renders it, then what the handlers do (run as a plain function
// with mini-react's hooks, as the form's handler tests do), then the CSS that shows and places the tooltip.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  ...(await import("../../../test/fixtures/mini-react")).hooks,
}));

import { CANARY_COPY } from "@/lib/canary/copy";
import { CANARY_LIMITS } from "@/lib/canary/limits";
import { RawModeTip } from "./RawModeTip";

const F = CANARY_COPY.form;

function open() {
  const view = mount(() => RawModeTip());
  const find = (pred: (e: El) => boolean) => elements(view.result).find(pred) as El;
  const button = () => find((e) => e.type === "button");
  const tip = () => find((e) => e.props.role === "tooltip");
  const call = (name: string, arg?: unknown) => {
    (button().props[name] as (a?: unknown) => void)(arg);
    view.flush();
  };
  return { view, button, tip, call };
}

describe("the Raw mode pill", () => {
  it("is a button the keyboard reaches, named Raw mode on, with a ? that a screen reader skips", () => {
    const f = open();
    expect(f.button().props.type).toBe("button");
    const mark = elements(f.button()).find((e) => e.props["aria-hidden"] === "true");
    expect(textOf(mark)).toBe("?");
    expect(textOf(f.button()).replace("?", "")).toBe("Raw mode on");
  });

  it("is described by its tooltip: role tooltip, its id in the button's aria-describedby", () => {
    const f = open();
    const id = f.tip().props.id;
    expect(id).toBeTruthy();
    expect(f.button().props["aria-describedby"]).toBe(id);
    expect(textOf(f.tip())).toBe(F.rawTip);
  });

  it("says what raw mode does, with the on-chain limits from CANARY_LIMITS", () => {
    expect(F.rawTip).toBe(
      "When code refuses a proposal to pay, raw mode can also send it straight to the NEAR contract, skipping the code rules, so you can watch the chain refuse it too. It sends only what the contract's free dry run says it would refuse: a spend the contract would accept is not sent. At most 1 per visitor every 10 minutes, and 30 an hour for all visitors together.",
    );
    expect(CANARY_LIMITS.rawVisitorWindowS).toBe(600);
    expect(CANARY_LIMITS.rawGlobalPerHour).toBe(30);
  });

  it("shows the tooltip on focus and after a tap, hides it on Escape, and leaves it to hover once the focus goes", () => {
    const f = open();
    expect(f.tip().props["data-state"]).toBe("auto");
    f.call("onFocus");
    expect(f.tip().props["data-state"]).toBe("open");
    f.call("onKeyDown", { key: "Enter" });
    expect(f.tip().props["data-state"]).toBe("open");
    f.call("onKeyDown", { key: "Escape" });
    expect(f.tip().props["data-state"]).toBe("closed");
    f.call("onClick");
    expect(f.tip().props["data-state"]).toBe("open");
    f.call("onBlur");
    expect(f.tip().props["data-state"]).toBe("auto");
  });
});

describe("Escape with the focus elsewhere (WCAG 1.4.13)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The form with a document that only dispatches events, since the tests run with no DOM. */
  function withDocument() {
    const doc = new EventTarget();
    vi.stubGlobal("document", doc);
    const f = open();
    const wrap = () => elements(f.view.result).find((e) => "onPointerEnter" in e.props) as El;
    const pointer = (name: "onPointerEnter" | "onPointerLeave") => {
      (wrap().props[name] as () => void)();
      f.view.flush();
    };
    const pressEscape = () => {
      doc.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
      f.view.flush();
    };
    return { ...f, pointer, pressEscape, state: () => f.tip().props["data-state"] };
  }

  it("hides a tooltip that hover alone shows, and hover can show it again once the pointer has left", () => {
    const f = withDocument();
    // Nothing shows and nothing listens before the pointer comes.
    f.pressEscape();
    expect(f.state()).toBe("auto");
    f.pointer("onPointerEnter");
    f.pressEscape();
    expect(f.state()).toBe("closed");
    f.pointer("onPointerLeave");
    expect(f.state()).toBe("auto");
    f.pointer("onPointerEnter");
    expect(f.state()).toBe("auto");
  });

  it("hides a tooltip opened by a tap, and a tap's pointer leaving keeps it open until then", () => {
    const f = withDocument();
    f.pointer("onPointerEnter");
    f.call("onClick");
    f.pointer("onPointerLeave");
    expect(f.state()).toBe("open");
    f.pressEscape();
    expect(f.state()).toBe("closed");
  });
});

describe("the tooltip's CSS", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../site/canary.module.css", import.meta.url)),
    "utf8",
  );
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };

  it("is hidden until its state is open, or the pointer is over it where there is hover and Escape did not close it", () => {
    expect(rule(".tip")).toContain("display: none;");
    expect(rule('.tip[data-state="open"]')).toContain("display: block;");
    expect(css).toMatch(
      /@media \(hover: hover\) \{\s*\.tipWrap:hover \.tip:not\(\[data-state="closed"\]\) \{\s*display: block;/,
    );
  });

  it("spans the row of actions on a phone, so it never runs past a 375 px screen, and hangs under the pill from 621 px", () => {
    expect(rule(".actions")).toContain("position: relative;");
    expect(rule(".tip")).toMatch(/left: 0;[\s\S]*right: 0;/);
    expect(rule(".tipWrap")).not.toContain("position:");
    expect(css).toMatch(
      /@media \(min-width: 621px\) \{\s*\.tipWrap \{\s*position: relative;\s*\}\s*\.tip \{\s*right: auto;\s*width: 320px;/,
    );
  });
});
