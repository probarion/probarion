import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignInPhase } from "@/lib/ui/pending";
import { type El, elements, mount, textOf } from "../../../test/fixtures/mini-react";

// The click, held to the real handler: the button is run as a plain function with React's hooks replaced
// (test/fixtures/mini-react.ts), the wallet stands in for near-connect, and each phase is read in the same tick.
const h = vi.hoisted(() => ({
  ready: true,
  calls: [] as {
    onPhase?: (phase: SignInPhase) => void;
    resolve: (id: string) => void;
    reject: (e: unknown) => void;
  }[],
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  ...(await import("../../../test/fixtures/mini-react")).hooks,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("./WalletProvider", () => ({
  useWallet: () => ({
    ready: h.ready,
    signIn: (opts?: { onPhase?: (phase: SignInPhase) => void }) =>
      new Promise<string>((resolve, reject) =>
        h.calls.push({ onPhase: opts?.onPhase, resolve, reject }),
      ),
  }),
}));

import {
  SIGN_IN_CLOSED,
  SIGN_IN_LABELS,
  SIGN_IN_TIMED_OUT,
  SIGN_IN_WALLET_LINE,
} from "@/lib/ui/pending";
import { SignInButton } from "./SignInButton";

const assign = vi.fn();

beforeEach(() => {
  h.ready = true;
  h.calls = [];
  assign.mockReset();
  vi.stubGlobal("window", { location: { assign } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function open() {
  const view = mount(() => SignInButton({ next: "/console/acme.vaults.probarion.testnet" }));
  const tree = () => elements(view.result);
  const button = (): El => {
    const b = tree().find((e) => e.type === "button");
    if (!b) throw new Error("no button");
    return b;
  };
  const lines = () => {
    const regions = tree().filter((e) => e.props.role === "status");
    expect(regions).toHaveLength(1); // one region, mounted in every state
    return elements(regions[0]?.props.children)
      .filter((e) => e.type === "p")
      .map(textOf);
  };
  const click = () => {
    const pending = (button().props.onClick as () => Promise<void>)();
    view.flush();
    return pending;
  };
  return { view, button, lines, click };
}

describe("SignInButton's steps", () => {
  it("before the wallets load: disabled, Loading wallets…, and an empty region", () => {
    h.ready = false;
    const { button, lines } = open();
    expect(button().props.disabled).toBe(true);
    expect(textOf(button())).toBe("Loading wallets…");
    expect(lines()).toEqual([]);
  });

  it("keeps one width from loading to every step", () => {
    const sizers = (b: El) =>
      elements(b.props.children)
        .filter(
          (e) => typeof e.props["data-label"] === "string" && e.props.className !== "busy-echo",
        )
        .map((e) => e.props["data-label"]);
    h.ready = false;
    const before = new Set(sizers(open().button()));
    h.ready = true;
    const after = new Set(sizers(open().button()));
    expect(before).toEqual(after);
    expect(after).toEqual(new Set(["Sign in with NEAR wallet", ...SIGN_IN_LABELS]));
  });

  it("names each step, keeps the focus while busy and asks the wallet once", async () => {
    const { view, button, lines, click } = open();
    expect(textOf(button())).toBe("Sign in with NEAR wallet");
    const done = click();
    void click();
    expect(h.calls).toHaveLength(1);
    expect(textOf(button())).toBe("Check your wallet…");
    expect(button().props.disabled).toBe(false);
    expect(button().props["aria-disabled"]).toBe(true);
    // the selector, then the console fetching the challenge: the wallet's line waits for the wallet's own step
    expect(lines()).toEqual([]);

    h.calls[0]?.onPhase?.("wallet");
    view.flush();
    expect(textOf(button())).toBe("Check your wallet…");
    expect(lines()).toEqual([SIGN_IN_WALLET_LINE]);

    h.calls[0]?.onPhase?.("verify");
    view.flush();
    expect(textOf(button())).toBe("Checking your signature…");
    expect(lines()).toEqual([]);

    h.calls[0]?.onPhase?.("open");
    view.flush();
    expect(textOf(button())).toBe("Opening your console…");

    h.calls[0]?.resolve("alice.testnet");
    await done;
    view.flush();
    expect(assign).toHaveBeenCalledExactlyOnceWith("/console/acme.vaults.probarion.testnet");
    // it stays busy until the page leaves, so a second click cannot ask the wallet to sign again
    expect(button().props["aria-disabled"]).toBe(true);
    expect(textOf(button())).toBe("Opening your console…");
    void click();
    expect(h.calls).toHaveLength(1);
  });

  it("a closed wallet reads as closed, in the region, and the button can be used again", async () => {
    const { view, button, lines, click } = open();
    const done = click();
    h.calls[0]?.reject(new Error("User rejected"));
    await done;
    view.flush();
    expect(lines()).toEqual([SIGN_IN_CLOSED]);
    expect(textOf(button())).toBe("Sign in with NEAR wallet");
    expect(button().props["aria-disabled"]).toBeUndefined();
    expect(assign).not.toHaveBeenCalled();
    void click();
    expect(h.calls).toHaveLength(2);
    expect(lines()).toEqual([]); // the old error goes when a new attempt starts
  });

  it("a server that did not answer says so in the region", async () => {
    const { view, lines, click } = open();
    const done = click();
    h.calls[0]?.onPhase?.("verify");
    h.calls[0]?.reject(new Error(SIGN_IN_TIMED_OUT));
    await done;
    view.flush();
    expect(lines()).toEqual([
      "The server did not answer in 15 s. You are not signed in. Try again.",
    ]);
  });

  it("adds the wallet's hint at 20 s under its line, and never gives up on the wallet", () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const { view, button, lines, click } = open();
    void click();
    // a slow challenge is the console's wait, not the wallet's: no wallet line, and no wallet clock yet
    vi.advanceTimersByTime(10_000);
    view.flush();
    expect(textOf(button())).toBe("Check your wallet…");
    expect(lines()).toEqual([]);
    h.calls[0]?.onPhase?.("wallet");
    view.flush();
    expect(lines()).toEqual([SIGN_IN_WALLET_LINE]);
    vi.advanceTimersByTime(19_000);
    view.flush();
    expect(lines()).toEqual([`${SIGN_IN_WALLET_LINE} 0:19`]);
    vi.advanceTimersByTime(1_000);
    view.flush();
    // the hint's clock is the one that runs
    expect(lines()).toEqual([
      SIGN_IN_WALLET_LINE,
      "Still waiting for your wallet (0:20). If you closed its window, check your wallet's activity before you sign again.",
    ]);
    vi.advanceTimersByTime(600_000);
    view.flush();
    expect(textOf(button())).toBe("Check your wallet…");
    expect(h.calls).toHaveLength(1);
  });
});
