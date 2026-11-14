import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hooks, mount } from "../../../test/fixtures/mini-react";

// The two timers, run as plain functions with React's hooks replaced (test/fixtures/mini-react.ts) and the clock faked,
// so each threshold is held to the millisecond.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  ...(await import("../../../test/fixtures/mini-react")).hooks,
}));

import { MIN_SHOW_MS, SHOW_DELAY_MS } from "@/lib/ui/pending";
import { useDelayedFlag, useElapsed } from "./hooks";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});
afterEach(() => vi.useRealTimers());

/** A hook under a prop the test can change, as a parent re-rendering with a new prop would. */
function withProp<P, T>(initial: P, use: (p: P) => T) {
  let set: (p: P) => void = () => {};
  const seen: T[] = [];
  const view = mount(() => {
    const [p, setP] = hooks.useState(initial);
    set = setP;
    const out = use(p);
    seen.push(out);
    return out;
  });
  view.flush();
  const change = (p: P) => {
    set(p);
    view.flush();
  };
  /** Moves the clock on, and re-renders for what the timers set. */
  const wait = (ms: number) => {
    vi.advanceTimersByTime(ms);
    view.flush();
  };
  return { view, change, wait, seen };
}

describe("useDelayedFlag", () => {
  it("never shows for work that ends within 200 ms", () => {
    const { view, change, wait, seen } = withProp(false, (on) => useDelayedFlag(on));
    change(true);
    wait(SHOW_DELAY_MS - 1);
    expect(view.result).toBe(false);
    change(false);
    wait(5_000);
    expect(seen).not.toContain(true);
  });

  it("shows from 200 ms after it turns on", () => {
    const { view, change, wait } = withProp(false, (on) => useDelayedFlag(on));
    change(true);
    wait(SHOW_DELAY_MS - 1);
    expect(view.result).toBe(false);
    wait(1);
    expect(view.result).toBe(true);
  });

  it("once shown, stays 400 ms, however soon the work ends", () => {
    const { view, change, wait } = withProp(false, (on) => useDelayedFlag(on));
    change(true);
    wait(SHOW_DELAY_MS);
    expect(view.result).toBe(true);
    wait(50);
    change(false);
    expect(view.result).toBe(true);
    wait(MIN_SHOW_MS - 50 - 1);
    expect(view.result).toBe(true);
    wait(1);
    expect(view.result).toBe(false);
  });

  it("goes at once when it has already been shown 400 ms", () => {
    const { view, change, wait } = withProp(false, (on) => useDelayedFlag(on));
    change(true);
    wait(SHOW_DELAY_MS + MIN_SHOW_MS + 100);
    expect(view.result).toBe(true);
    change(false);
    expect(view.result).toBe(false);
  });

  it("stays on, with no flicker, when the work starts again during the hold", () => {
    const { view, change, wait, seen } = withProp(false, (on) => useDelayedFlag(on));
    change(true);
    wait(SHOW_DELAY_MS);
    change(false);
    wait(100);
    change(true);
    wait(2_000);
    expect(view.result).toBe(true);
    expect(seen.slice(seen.indexOf(true))).not.toContain(false);
  });

  it("clears its timers when the component goes", () => {
    const { view, change } = withProp(false, (on) => useDelayedFlag(on));
    change(true);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useElapsed", () => {
  type Props = { active: boolean; key?: string };
  const setup = () =>
    withProp<Props, number>({ active: false }, ({ active, key }) => useElapsed(active, key));

  it("is 0 while inactive, then counts the time since it started, once a second", () => {
    const { view, change, wait } = setup();
    wait(3_000);
    expect(view.result).toBe(0);
    change({ active: true });
    expect(view.result).toBe(0);
    wait(999);
    expect(view.result).toBe(0);
    wait(1);
    expect(view.result).toBe(1_000);
    wait(6_000);
    expect(view.result).toBe(7_000);
  });

  it("reads 0 at once when it stops, and starts again from 0", () => {
    const { view, change, wait, seen } = setup();
    change({ active: true });
    wait(12_000);
    expect(view.result).toBe(12_000);
    const before = seen.length;
    change({ active: false });
    expect(seen.slice(before)).not.toContain(12_000);
    expect(view.result).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    change({ active: true });
    wait(2_000);
    expect(view.result).toBe(2_000);
  });

  it("restarts from 0 on a new key, and the render with the new key already reads 0", () => {
    const { view, change, wait, seen } = setup();
    change({ active: true, key: "wallet" });
    wait(25_000);
    expect(view.result).toBe(25_000);
    const before = seen.length;
    change({ active: true, key: "confirm" });
    // No render under the new key shows the old phase's time.
    expect(seen.slice(before).every((ms) => ms === 0)).toBe(true);
    wait(3_000);
    expect(view.result).toBe(3_000);
    // One clock at a time.
    expect(vi.getTimerCount()).toBe(1);
  });
});
