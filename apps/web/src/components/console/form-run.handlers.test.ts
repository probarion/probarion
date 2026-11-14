import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsState } from "@/app/console/[vault]/actions";
import type { AlertsState } from "@/app/console/[vault]/alerts/actions";
import type { KeySyncState } from "@/lib/keys/rules";
import { type El, elements, mount, textOf } from "../../../test/fixtures/mini-react";

// The console forms' presses, held to useFormRun's real guards: each form runs as a plain function with React's hooks
// replaced (test/fixtures/mini-react.ts), and useActionState by a stand-in that does what React does with a form's
// action. The action runs at once; its answer and the end of `pending` land together in the next render (flush), as
// they do in React when the transition commits, after the action's promise has settled.
const runs: Promise<void>[] = [];
vi.mock("react", async (importOriginal) => {
  const mini = (await import("../../../test/fixtures/mini-react")).hooks;
  return {
    ...(await importOriginal<typeof import("react")>()),
    ...mini,
    useActionState: <S, P>(fn: (prev: S, payload: P) => Promise<S>, initial: S) => {
      const [state, setState] = mini.useState(initial);
      const [pending, setPending] = mini.useState(false);
      const dispatch = (payload: P) => {
        setPending(true);
        runs.push(
          fn(state, payload).then((next) => {
            setState(next);
            setPending(false);
          }),
        );
      };
      return [state, dispatch, pending] as const;
    },
  };
});

import { AddEmailForm } from "./AddEmailForm";
import { KeySyncButton } from "./KeyActions";
import { SettingsForm } from "./SettingsForm";

beforeEach(() => {
  runs.length = 0;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
});
afterEach(() => vi.useRealTimers());

/** A promise the test ends when it chooses. */
function deferred<T>() {
  let end: (value: T) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    end = resolve;
    fail = reject;
  });
  // Handled here too: a test may end it with a failure before the form has taken it up.
  promise.catch(() => {});
  return { promise, end, fail };
}

/** An event with the one method the guards call. */
const event = () => ({ preventDefault: vi.fn() });

type Handler = (e: ReturnType<typeof event>) => void;
const handler = (el: El | undefined, name: "onClick" | "onSubmit") => {
  const fn = el?.props[name];
  if (typeof fn !== "function") throw new Error(`no ${name}`);
  return fn as Handler;
};

/** The elements of a tree, with each child component that takes no children (SettingsForm's Result) drawn in place. */
function drawn(tree: unknown): El[] {
  return elements(tree).flatMap((e) =>
    typeof e.type === "function" && e.props.children === undefined
      ? [e, ...drawn((e.type as (p: unknown) => unknown)(e.props))]
      : [e],
  );
}

/** A mounted form's parts, found again in its latest render. */
function parts(view: { result: unknown }) {
  const all = () => drawn(view.result);
  return {
    forms: () => all().filter((e) => e.type === "form"),
    buttons: () => all().filter((e) => e.type === "button"),
    regions: () => all().filter((e) => e.props.role === "status"),
  };
}

/** Lets every settled run's answer through (the stand-in's then), without rendering it. */
async function settle() {
  await Promise.all(runs);
}

/**
 * Presses a form's button the way the browser does: the click (the guard may stop it there), then the form's submit
 * event, then, unless that was stopped, React calls the form's action. Answers whether the action ran.
 */
function press(button: El | undefined, form: El | undefined): boolean {
  if (!form) throw new Error("no form");
  const click = event();
  handler(button, "onClick")(click);
  if (click.preventDefault.mock.calls.length > 0) return false;
  const submit = event();
  handler(form, "onSubmit")(submit);
  if (submit.preventDefault.mock.calls.length > 0) return false;
  (form.props.action as (f: FormData) => void)(new FormData());
  return true;
}

describe("the settings' Save and Re-sync", () => {
  function open() {
    const save = deferred<SettingsState>();
    const refresh = vi.fn(async (): Promise<SettingsState> => ({ ok: true, message: "Re-read." }));
    const view = mount(() =>
      SettingsForm({
        vault: "v.vaults.probarion.near",
        kind: "team",
        zeroRetention: false,
        proofPublic: false,
        save: () => save.promise,
        refresh,
      }),
    );
    return { view, save, refresh, ...parts(view) };
  }

  it("share one lock: while Save runs, Re-sync's click and its form's submit both do nothing", () => {
    const { view, refresh, forms, buttons } = open();
    expect(press(buttons()[0], forms()[0])).toBe(true);
    view.flush();
    const click = event();
    handler(buttons()[1], "onClick")(click);
    expect(click.preventDefault).toHaveBeenCalledTimes(1);
    // Enter in a field submits with no click: the form's own guard stops it.
    const submit = event();
    handler(forms()[1], "onSubmit")(submit);
    expect(submit.preventDefault).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    // Both buttons say so: Save is busy, Re-sync waits under its own label.
    expect(textOf(buttons()[0])).toBe("Saving…");
    expect(textOf(buttons()[1])).toBe("Re-sync approvers from the chain");
    expect(buttons().map((b) => b.props["aria-disabled"])).toEqual([true, true]);
  });

  it("keep the lock until the answer's render, not just until the action's promise settles", async () => {
    const { view, save, refresh, forms, buttons } = open();
    press(buttons()[0], forms()[0]);
    view.flush();
    save.end({ ok: true, message: "Settings saved." });
    await settle();
    // The answer is in, but the page still shows "Saving…" (React's pending lasts until the commit): a press now
    // must do nothing, as it would otherwise start a run the page cannot show.
    expect(textOf(buttons()[0])).toBe("Saving…");
    expect(press(buttons()[1], forms()[1])).toBe(false);
    view.flush();
    expect(textOf(buttons()[0])).toBe("Save settings");
    expect(press(buttons()[1], forms()[1])).toBe(true);
    await settle();
    view.flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("read out the same answer twice: each answer's words are a new node in the region", async () => {
    const { view, save, forms, buttons, regions } = open();
    const words = () =>
      elements(regions()[0]).find((e) => e.type === "span" && textOf(e) === "Settings saved.") as
        | (El & { key?: unknown })
        | undefined;
    press(buttons()[0], forms()[0]);
    save.end({ ok: true, message: "Settings saved." });
    await settle();
    view.flush();
    const first = words()?.key;
    expect(first).toBeDefined();
    // The same save again answers the same words; while it runs, the last answer keeps its node.
    expect(press(buttons()[0], forms()[0])).toBe(true);
    view.flush();
    expect(words()?.key).toBe(first);
    await settle();
    view.flush();
    expect(textOf(regions()[0])).toContain("Settings saved.");
    expect(words()?.key).not.toBe(first);
  });
});

describe("the key sync's Try again", () => {
  function open() {
    let calls = 0;
    const second = deferred<KeySyncState>();
    const sync = vi.fn(async (): Promise<KeySyncState> => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return second.promise;
    });
    const view = mount(() => KeySyncButton({ sync }));
    return { view, sync, second, ...parts(view) };
  }

  it("adds the slow hint as a line after the last answer, which stays as it was", async () => {
    const { view, forms, buttons, regions } = open();
    press(buttons()[0], forms()[0]);
    await settle();
    view.flush();
    const region = () => regions()[0];
    const children = () => (region()?.props.children ?? []) as unknown[];
    const before = children();
    expect(textOf(region())).toContain("The console could not check the keys.");
    expect(textOf(buttons()[1])).toBe("Try again");
    expect(press(buttons()[1], forms()[0])).toBe(true);
    view.flush();
    expect(textOf(buttons()[1])).toBe("Trying again…");
    vi.advanceTimersByTime(5_000);
    view.flush();
    const after = children();
    // The region's last child is the hint, keyed as its own line; the answer before it is the same element tree.
    const hint = after.at(-1) as (El & { key?: unknown }) | null;
    expect(hint?.key).toBe("hint");
    expect(textOf(hint)).toContain("Still reading the chain");
    expect(textOf(hint)).toContain("The console finishes one request at a time.");
    expect(before.at(-1)).toBeNull();
    const words = (list: unknown[]) =>
      elements(list).find((e) => e.type === "span" && textOf(e).startsWith("The console could"));
    expect((words(after) as { key?: unknown }).key).toBe((words(before) as { key?: unknown }).key);
    expect(region()?.props["aria-atomic"]).toBe("false");
  });

  it("hands the focus to the form's button before the notice that holds it gives way", async () => {
    const { view, second, forms, buttons, regions } = open();
    press(buttons()[0], forms()[0]);
    await settle();
    view.flush();
    // mini-react attaches no refs: the test puts the two buttons in them, Try again focused.
    const retry: { ownerDocument?: { activeElement: unknown } } = {};
    retry.ownerDocument = { activeElement: retry };
    let seen = "";
    const main = {
      focus: vi.fn(() => {
        view.flush();
        seen = textOf(regions()[0]);
      }),
    };
    (buttons()[0]?.props.ref as { current: unknown }).current = main;
    (buttons()[1]?.props.ref as { current: unknown }).current = retry;
    press(buttons()[1], forms()[0]);
    view.flush();
    second.end({ ok: true, message: "Checked on chain: nothing changed.", notes: [] });
    await settle();
    expect(main.focus).toHaveBeenCalledTimes(1);
    // When the focus moved, the region still held the notice with Try again in it.
    expect(seen).toContain("The console could not check the keys.");
    view.flush();
    expect(textOf(regions()[0])).toContain("Checked on chain: nothing changed.");
    expect(buttons()).toHaveLength(1);
  });

  it("leaves the focus on Try again when the answer offers it again", async () => {
    const { view, second, forms, buttons } = open();
    press(buttons()[0], forms()[0]);
    await settle();
    view.flush();
    const retry: { ownerDocument?: { activeElement: unknown } } = {};
    retry.ownerDocument = { activeElement: retry };
    const main = { focus: vi.fn() };
    (buttons()[0]?.props.ref as { current: unknown }).current = main;
    (buttons()[1]?.props.ref as { current: unknown }).current = retry;
    expect(press(buttons()[1], forms()[0])).toBe(true);
    second.fail(new Error("offline again"));
    await settle();
    view.flush();
    expect(main.focus).not.toHaveBeenCalled();
    expect(textOf(buttons()[1])).toBe("Try again");
  });
});

describe("the alert email's Send confirmation", () => {
  it("sends once when it is pressed again before the answer's render: an email cannot be taken back", async () => {
    const sent = deferred<AlertsState>();
    const add = vi.fn(() => sent.promise);
    const view = mount(() => AddEmailForm({ add }));
    const { forms, buttons } = parts(view);
    expect(press(buttons()[0], forms()[0])).toBe(true);
    // Before the render that shows the first press.
    expect(press(buttons()[0], forms()[0])).toBe(false);
    view.flush();
    sent.end({ ok: true, message: "Sent. Open the link in it to confirm." });
    await settle();
    expect(press(buttons()[0], forms()[0])).toBe(false);
    view.flush();
    expect(add).toHaveBeenCalledTimes(1);
    expect(textOf(view.result)).toContain("Sent. Open the link in it to confirm.");
  });
});
