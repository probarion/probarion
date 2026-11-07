import { describe, expect, it, vi } from "vitest";
import {
  ACTION_GUARD_MS,
  actionClickAllowed,
  type ConfirmOptions,
  type ConfirmSource,
  type ConfirmTone,
  createAsker,
  type DangerTone,
  isBackdropClick,
  pickOpener,
  SIGN_FOOTNOTE,
  walletConfirm,
} from "./confirm-dialog";

// The logic behind the console's confirm dialog, without a browser: who may confirm, what cancels, and what a
// second ask does while one is open. The markup is held in components/ConfirmDialog.test.ts.

const ASK: ConfirmOptions = {
  title: "Freeze vault",
  body: "Freeze stops every spend and every approval until you unfreeze. Continue?",
  actionLabel: "Freeze vault",
};
const OTHER: ConfirmOptions = { ...ASK, title: "Withdraw", actionLabel: "Withdraw" };

function asker() {
  const seen: (ConfirmOptions | null)[] = [];
  const a = createAsker((o) => seen.push(o));
  return { a, seen };
}

describe("createAsker", () => {
  it("opens the dialog with the options, and answers true only when the action button is used", async () => {
    const { a, seen } = asker();
    const answer = a.ask(ASK);
    expect(seen).toEqual([ASK]);
    expect(a.open).toEqual(ASK);
    a.settle("action");
    expect(await answer).toBe(true);
    expect(seen).toEqual([ASK, null]);
    expect(a.open).toBeNull();
  });

  it.each<ConfirmSource>(["cancel-button", "escape", "backdrop", "close", "unmount"])(
    "answers false and closes when the dialog is dismissed by %s",
    async (source) => {
      const { a, seen } = asker();
      const answer = a.ask(ASK);
      a.settle(source);
      expect(await answer).toBe(false);
      expect(seen).toEqual([ASK, null]);
      expect(a.open).toBeNull();
    },
  );

  it("does not open a second dialog, and does not confirm, when asked again while one is open", async () => {
    const { a, seen } = asker();
    const first = a.ask(ASK);
    const second = a.ask(OTHER);
    // The second ask is answered "no" at once, and the dialog on screen is still the first one.
    expect(await second).toBe(false);
    expect(seen).toEqual([ASK]);
    expect(a.open).toEqual(ASK);
    // The first is still waiting for the owner, and still confirms with the action button.
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    a.settle("action");
    expect(await first).toBe(true);
  });

  it("can be asked again once the first question is answered, and the new answer is its own", async () => {
    const { a } = asker();
    const first = a.ask(ASK);
    a.settle("action");
    expect(await first).toBe(true);
    const again = a.ask(OTHER);
    expect(a.open).toEqual(OTHER);
    a.settle("escape");
    expect(await again).toBe(false);
  });

  it("ignores a settle with nothing open, and a second settle on the same ask", async () => {
    const onChange = vi.fn();
    const a = createAsker(onChange);
    a.settle("action");
    expect(onChange).not.toHaveBeenCalled();
    const answer = a.ask(ASK);
    a.settle("escape");
    a.settle("action"); // a late click on the action button must not turn a "no" into a "yes"
    expect(await answer).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2); // open, close
  });

  it("answers an ask that is still open with false when it is closed from outside (the page went away)", async () => {
    const { a, seen } = asker();
    const answer = a.ask(ASK);
    a.settle("unmount");
    expect(await answer).toBe(false);
    expect(seen).toEqual([ASK, null]);
  });
});

describe("isBackdropClick", () => {
  const dialog = { name: "dialog" };
  const panel = { name: "panel" };

  it("is a click that began and ended on the dialog element itself (the backdrop is part of it)", () => {
    expect(isBackdropClick({ pressed: dialog, clicked: dialog, dialog })).toBe(true);
  });

  it("is not a click inside the panel", () => {
    expect(isBackdropClick({ pressed: panel, clicked: panel, dialog })).toBe(false);
  });

  it("is not a text selection that began in the panel and ended over the backdrop", () => {
    expect(isBackdropClick({ pressed: panel, clicked: dialog, dialog })).toBe(false);
  });

  it("is not a click whose press was never seen", () => {
    expect(isBackdropClick({ pressed: null, clicked: dialog, dialog })).toBe(false);
  });
});

describe("walletConfirm (what TxButton asks)", () => {
  it("titles the dialog with the button's label, labels the action the same, and keeps the text as it was", () => {
    const text = `Revoke mandate #1 "Acme" (pays bob.near)?\n\nThis cannot be undone.`;
    expect(walletConfirm({ label: "Revoke", confirm: text, confirmTone: "danger" })).toEqual({
      title: "Revoke",
      actionLabel: "Revoke",
      body: text,
      tone: "danger",
      footnote: SIGN_FOOTNOTE,
    });
  });

  it("is a normal dialog unless the caller says danger", () => {
    expect(walletConfirm({ label: "Approve", confirm: "Approve paying 5 USDC?" }).tone).toBe(
      "normal",
    );
  });

  it("tells the owner what comes next, in the words the approved design uses", () => {
    expect(SIGN_FOOTNOTE).toBe("Next, your wallet asks you to sign. Nothing is sent until you do.");
  });
});

describe("actionClickAllowed (a double click on the opener must not land on the action)", () => {
  const opened = 10_000;
  const at = (after: number, detail: number) =>
    actionClickAllowed({ openedAt: opened, now: opened + after, detail });

  it("ignores the action button for the first moments after the dialog opens", () => {
    expect(ACTION_GUARD_MS).toBe(400);
    expect(at(0, 1)).toBe(false);
    expect(at(ACTION_GUARD_MS - 1, 1)).toBe(false);
  });

  it("takes a click once the guard time has passed", () => {
    expect(at(ACTION_GUARD_MS, 1)).toBe(true);
    expect(at(60_000, 1)).toBe(true);
  });

  it("ignores the second click of a double click, however late", () => {
    expect(at(60_000, 2)).toBe(false);
    expect(at(60_000, 3)).toBe(false);
  });

  it("takes a click from the keyboard (its detail is 0) once the guard time has passed", () => {
    expect(at(ACTION_GUARD_MS, 0)).toBe(true);
    expect(at(0, 0)).toBe(false);
  });
});

describe("pickOpener (where focus goes back to)", () => {
  const button = { name: "the button that was clicked" };
  const active = { name: "whatever had focus" };

  it("is the element the caller passed, when it passed one", () => {
    expect(pickOpener(button, active)).toBe(button);
  });

  it("falls back to the element that had focus when none was passed", () => {
    expect(pickOpener(undefined, active)).toBe(active);
    expect(pickOpener(null, active)).toBe(active);
  });

  it("is nothing when there is neither", () => {
    expect(pickOpener(undefined, null)).toBeNull();
  });
});

describe("tone types", () => {
  it("DangerTone is the one tone a prop can name besides the normal one", () => {
    const danger: DangerTone = "danger";
    const tone: ConfirmTone = danger;
    expect(tone).toBe("danger");
    // @ts-expect-error "normal" is what no tone means; a prop names only "danger"
    const normal: DangerTone = "normal";
    expect(normal).toBe("normal");
  });
});
