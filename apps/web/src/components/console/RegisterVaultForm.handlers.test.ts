import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type El, elements, mount, textOf } from "../../../test/fixtures/mini-react";

// Register's submit and its Try again, held to the real handlers: the form runs as a plain function with React's hooks
// replaced (test/fixtures/mini-react.ts; the vault list's refresh transition runs at once) and the server action mocked.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  ...(await import("../../../test/fixtures/mini-react")).hooks,
  useTransition: () => [false, (fn: () => void) => fn()] as const,
}));
const { refresh, registerVaultAction } = vi.hoisted(() => ({
  refresh: vi.fn(),
  registerVaultAction:
    vi.fn<
      (vault: string) => Promise<{ ok: true; vaultId: string } | { ok: false; error: string }>
    >(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/console/actions", () => ({ registerVaultAction }));

import { RegisterVaultForm } from "./RegisterVaultForm";

beforeEach(() => {
  registerVaultAction.mockReset();
  refresh.mockReset();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
});
afterEach(() => vi.useRealTimers());

/** Lets the answer of a call that has ended reach the form (readAction, then the handler's own steps). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function open() {
  const view = mount(() => RegisterVaultForm({ placeholder: "acme.vaults.probarion.near" }));
  const all = () => elements(view.result);
  const form = () => all().find((e) => e.type === "form") as El;
  const buttons = () => all().filter((e) => e.type === "button");
  const region = () => all().find((e) => e.props.role === "status");
  const submit = () => {
    const e = { preventDefault: vi.fn() };
    (form().props.onSubmit as (e: { preventDefault: () => void }) => void)(e);
    return e;
  };
  return { view, buttons, region, submit };
}

describe("RegisterVaultForm's submit", () => {
  it("registers once when it is submitted again before the render that shows the first", async () => {
    let finish: (r: { ok: true; vaultId: string }) => void = () => {};
    registerVaultAction.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { view, buttons, submit } = open();
    // The form handles every submit itself: the page never reloads.
    expect(submit().preventDefault).toHaveBeenCalledTimes(1);
    submit();
    view.flush();
    submit();
    // readAction starts the call a microtask later.
    await settle();
    expect(registerVaultAction).toHaveBeenCalledTimes(1);
    expect(textOf(buttons()[0])).toBe("Checking the chain…");
    expect(buttons()[0]?.props["aria-disabled"]).toBe(true);
    finish({ ok: true, vaultId: "acme.vaults.probarion.near" });
    await settle();
    view.flush();
    expect(textOf(view.result)).toContain("Registered acme.vaults.probarion.near.");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("says, when the call fails on the way, that the vault may be registered, and offers Try again", async () => {
    registerVaultAction.mockRejectedValue(new Error("Failed to fetch https://internal.example/x"));
    const { view, buttons, region, submit } = open();
    submit();
    await settle();
    view.flush();
    const text = textOf(region());
    expect(text).toContain(
      "The console got no answer. The vault may be registered: reload the page to see, or try again.",
    );
    expect(text).not.toMatch(/internal\.example|Nothing was/);
    expect(textOf(buttons()[1])).toBe("Try again");
  });

  it("hands the focus from Try again to the form's button before the notice that holds it gives way", async () => {
    registerVaultAction.mockRejectedValueOnce(new Error("offline"));
    const { view, buttons, region, submit } = open();
    submit();
    await settle();
    view.flush();
    // mini-react attaches no refs: the test puts the two buttons in them, Try again focused.
    const retry: { ownerDocument?: { activeElement: unknown } } = {};
    retry.ownerDocument = { activeElement: retry };
    let seen = "";
    const main = {
      focus: vi.fn(() => {
        // Whatever the form has set by now is drawn: the notice must still be the old one.
        view.flush();
        seen = textOf(region());
      }),
    };
    (buttons()[0]?.props.ref as { current: unknown }).current = main;
    (buttons()[1]?.props.ref as { current: unknown }).current = retry;
    registerVaultAction.mockResolvedValueOnce({ ok: true, vaultId: "acme.vaults.probarion.near" });
    const tryAgain = buttons()[1];
    if (!tryAgain) throw new Error("no Try again");
    (tryAgain.props.onClick as () => void)();
    view.flush();
    expect(textOf(buttons()[1])).toBe("Trying again…");
    expect(buttons()[0]?.props["aria-disabled"]).toBe(true);
    await settle();
    expect(main.focus).toHaveBeenCalledTimes(1);
    expect(seen).toContain("The console got no answer.");
    view.flush();
    expect(textOf(region())).toContain("Registered acme.vaults.probarion.near.");
    expect(registerVaultAction).toHaveBeenCalledTimes(2);
  });

  it("re-reads out the same answer: each answer's words are a new node in the region", async () => {
    registerVaultAction.mockResolvedValue({ ok: false, error: "Not a Probarion vault." });
    const { view, region, submit } = open();
    const words = () =>
      elements(region()).find((e) => e.type === "span" && textOf(e) === "Not a Probarion vault.") as
        | (El & { key?: unknown })
        | undefined;
    submit();
    await settle();
    view.flush();
    const first = words()?.key;
    expect(first).toBeDefined();
    submit();
    await settle();
    view.flush();
    expect(words()?.key).toBeDefined();
    expect(words()?.key).not.toBe(first);
    expect(region()?.props["aria-atomic"]).toBe("false");
  });
});
