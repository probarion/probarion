import { DEFAULT_NEARAI_TIMEOUTS_MS } from "@probarion/sdk";
import { describe, expect, it } from "vitest";
import { PAYABLES_NEARAI_TIMEOUTS_MS, PAYABLES_TIME, payablesBudget } from "./budget";

describe("PAYABLES_TIME", () => {
  it("states the parts of the console upload's 90 s", () => {
    expect(PAYABLES_TIME).toEqual({
      routeMs: 90_000,
      beforeModelMs: 10_000,
      modelBudgetMs: 40_000,
      afterModelMs: 10_000,
      sendByMs: 60_000,
      sendAndCloseMs: 10_000,
      afterResponseMs: 20_000,
      kickWatchMs: 5_000,
    });
    expect(PAYABLES_NEARAI_TIMEOUTS_MS).toEqual({
      catalog: 6000,
      report: 6000,
      chat: 40_000,
      signature: 6000,
    });
  });

  // The route's start, the model, the decision and its dry run come before the first transaction; the send, the anchor,
  // the row and the answer after it; the watcher kick last, in the same function (route.test.ts holds routeMs to the
  // route's maxDuration, and server.test.ts the kick to afterResponseMs).
  it("adds up to the route's time, with the send and the watcher kick after the model's whole budget", () => {
    const t = PAYABLES_TIME;
    expect(t.beforeModelMs + t.modelBudgetMs + t.afterModelMs).toBe(t.sendByMs);
    expect(t.sendByMs + t.sendAndCloseMs + t.afterResponseMs).toBeLessThanOrEqual(t.routeMs);
    // the kick's watch is a part of what is left after the answer
    expect(t.kickWatchMs).toBeLessThan(t.afterResponseMs);
  });

  // Production, 2026-11-10: a slow private model used 30 s on the Canary's chat alone. The other calls (the catalog, the
  // probe, the report, the signature) take about a second each.
  it("leaves a 30 s chat its time, and every call less than the SDK's own limit", () => {
    expect(30_000 + 4 * 1000).toBeLessThanOrEqual(PAYABLES_TIME.modelBudgetMs);
    for (const phase of ["catalog", "report", "chat", "signature"] as const) {
      expect(PAYABLES_NEARAI_TIMEOUTS_MS[phase]).toBeLessThan(DEFAULT_NEARAI_TIMEOUTS_MS[phase]);
      expect(PAYABLES_NEARAI_TIMEOUTS_MS[phase]).toBeLessThanOrEqual(PAYABLES_TIME.modelBudgetMs);
    }
  });
});

describe("payablesBudget", () => {
  const T0 = 1_800_000_000_000;

  it("gives the model calls 40 s from the first one, when the start took the 10 s it is planned for", () => {
    let now = T0 + 10_000;
    const b = payablesBudget(T0, () => now);
    expect(b.modelMs()).toBe(40_000);
    now += 30_000; // a 30 s chat
    expect(b.modelMs()).toBe(10_000);
    now += 10_000;
    expect(b.modelMs()).toBe(0);
    now += 30_000; // a model that hangs: 70 s after the first call
    expect(b.modelMs()).toBeLessThan(0);
  });

  it("stops the model calls afterModelMs before sendByMs when the start took longer", () => {
    let now = T0 + 30_000;
    const b = payablesBudget(T0, () => now);
    // 60 - 10 - 30: the decision's write and its dry run keep their 10 s
    expect(b.modelMs()).toBe(20_000);
    now += 20_000;
    expect(b.modelMs()).toBe(0);
    // a start past the model's last moment leaves it nothing at all
    const late = payablesBudget(T0, () => T0 + 55_000);
    expect(late.modelMs()).toBeLessThan(0);
  });

  it("counts the model's budget from its first call, not from each call", () => {
    let now = T0 + 5_000;
    const b = payablesBudget(T0, () => now);
    expect(b.modelMs()).toBe(40_000);
    now += 15_000;
    expect(b.modelMs()).toBe(25_000);
    expect(b.modelMs()).toBe(25_000);
  });

  it("lets the chain reads run until sendByMs, and sets no limit once a transaction is under way", () => {
    let now = T0;
    const b = payablesBudget(T0, () => now);
    expect(b.chainMs()).toBe(60_000);
    now = T0 + 59_000;
    expect(b.chainMs()).toBe(1_000);
    now = T0 + 61_000;
    expect(b.chainMs()).toBe(-1_000);
    b.sending();
    // from the first transaction on, the reads run as the SDK's own client runs them
    expect(b.chainMs()).toBe(Number.POSITIVE_INFINITY);
    now = T0 + 200_000;
    expect(b.chainMs()).toBe(Number.POSITIVE_INFINITY);
  });

  it("does not give the model more time once a transaction is under way", () => {
    let now = T0 + 10_000;
    const b = payablesBudget(T0, () => now);
    expect(b.modelMs()).toBe(40_000);
    b.sending();
    now += 45_000;
    expect(b.modelMs()).toBeLessThan(0);
  });

  it("reads the system clock by default", () => {
    const b = payablesBudget(Date.now());
    expect(b.chainMs()).toBeGreaterThan(PAYABLES_TIME.sendByMs - 1_000);
    expect(b.chainMs()).toBeLessThanOrEqual(PAYABLES_TIME.sendByMs);
  });
});
