import { describe, expect, it } from "vitest";
import { type ChecklistInput, firstPaymentChecklist, type StepId } from "./checklist";
import type { MandateSummary, Read, SpendSummary } from "./vaults";

// "Your first agent payment" (site audit P1-8): five steps from a new vault to a payment an agent makes inside a
// mandate, worked out from what the overview reads. A step whose read failed is never ticked and never offered as
// undone: it says it could not be checked.

const ok = <T>(value: T): Read<T> => ({ ok: true, value });
const failed = { ok: false, kind: "rpc" } as const;
const notAllowed = { ok: false, kind: "not_allowed" } as const;
const spends = (counts: Record<string, number>): Read<SpendSummary> => {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return ok({ held: [], recent: [], counts, total });
};
const mandates = (counts: Record<string, number>): Read<MandateSummary> =>
  ok<MandateSummary>({ counts, total: Object.values(counts).reduce((a, b) => a + b, 0) });

const NEW: ChecklistInput = {
  network: "testnet",
  keys: ok({ agent: false, ledger: false }),
  usdc: ok("0"),
  intentsBase: notAllowed,
  mandates: mandates({}),
  spends: spends({}),
  faucetUsdc: "25",
};
const READY = { ...NEW, keys: ok({ agent: true, ledger: true }), usdc: ok("25000000") };

const states = (i: ChecklistInput) => {
  const c = firstPaymentChecklist(i);
  if (c === null) throw new Error("hidden");
  return Object.fromEntries(c.steps.map((s) => [s.id, s.state])) as Record<StepId, string>;
};

describe("firstPaymentChecklist", () => {
  it("lists the five steps in the order they depend on each other", () => {
    expect(firstPaymentChecklist(NEW)?.steps.map((s) => s.id)).toEqual([
      "vault",
      "keys",
      "usdc",
      "mandate",
      "payment",
    ]);
  });

  it("starts a new vault with only the vault done, and the keys next", () => {
    const c = firstPaymentChecklist(NEW);
    expect(states(NEW)).toEqual({
      vault: "done",
      keys: "open",
      usdc: "open",
      mandate: "open",
      payment: "open",
    });
    expect(c?.done).toBe(1);
    expect(c?.next).toBe("keys");
  });

  it("ticks the keys only once the console holds an active agent key and an active ledger key, as Payables needs", () => {
    expect(states({ ...NEW, keys: ok({ agent: true, ledger: false }) }).keys).toBe("open");
    expect(states({ ...NEW, keys: ok({ agent: false, ledger: true }) }).keys).toBe("open");
    expect(states({ ...NEW, keys: ok({ agent: true, ledger: true }) }).keys).toBe("done");
  });

  it("ticks the USDC once the vault holds some on NEAR or as Base USDC in Intents", () => {
    expect(states({ ...NEW, usdc: ok("1") }).usdc).toBe("done");
    expect(states({ ...NEW, intentsBase: ok("1") }).usdc).toBe("done");
    expect(states({ ...NEW, intentsBase: ok("0") }).usdc).toBe("open");
    expect(states({ ...NEW, usdc: ok("1"), intentsBase: failed }).usdc).toBe("done");
  });

  it("leaves the USDC unchecked when a balance it needs could not be read", () => {
    expect(states({ ...NEW, usdc: failed }).usdc).toBe("unknown");
    expect(states({ ...NEW, intentsBase: failed }).usdc).toBe("unknown");
    expect(states({ ...NEW, usdc: ok("not a number") }).usdc).toBe("unknown");
  });

  it("ticks the mandate only for an active one: a revoked or used-up mandate pays nothing", () => {
    expect(states({ ...NEW, mandates: mandates({ active: 1 }) }).mandate).toBe("done");
    expect(states({ ...NEW, mandates: mandates({ revoked: 1, exhausted: 2 }) }).mandate).toBe(
      "open",
    );
  });

  it("does not count a payment that is held, pending, failed or rejected", () => {
    for (const status of ["held", "pending", "failed", "rejected", "expired", "unconfirmed"]) {
      expect(states({ ...NEW, spends: spends({ [status]: 1 }) }).payment).toBe("open");
    }
  });

  it("goes away once a payment is paid, on NEAR or out through Intents", () => {
    expect(firstPaymentChecklist({ ...NEW, spends: spends({ paid: 1 }) })).toBeNull();
    expect(firstPaymentChecklist({ ...NEW, spends: spends({ burned: 1, failed: 2 }) })).toBeNull();
  });

  it("is not shown when the spends cannot be read: the vault may have paid long ago", () => {
    expect(firstPaymentChecklist({ ...NEW, spends: failed })).toBeNull();
  });

  it("says a step could not be checked when its read failed, never done or undone", () => {
    const s = states({ ...NEW, keys: failed, usdc: failed, mandates: failed });
    expect(s).toEqual({
      vault: "done",
      keys: "unknown",
      usdc: "unknown",
      mandate: "unknown",
      payment: "open",
    });
  });

  it("makes the first undone step the next one, past one it could not check", () => {
    expect(firstPaymentChecklist({ ...NEW, keys: failed })?.next).toBe("usdc");
    expect(firstPaymentChecklist(READY)?.next).toBe("mandate");
    expect(firstPaymentChecklist({ ...READY, mandates: mandates({ active: 1 }) })?.next).toBe(
      "payment",
    );
  });

  it("counts only the steps that are done", () => {
    const c = firstPaymentChecklist({
      ...NEW,
      keys: failed,
      usdc: ok("5"),
      mandates: mandates({ active: 2 }),
    });
    expect(c?.done).toBe(3);
  });

  it("sends each undone step to the tab where it is done", () => {
    const tabs = Object.fromEntries(
      (firstPaymentChecklist(NEW)?.steps ?? []).map((s) => [s.id, [s.tab, s.action]]),
    );
    expect(tabs).toEqual({
      vault: [null, null],
      keys: ["/keys", "Go to Keys"],
      usdc: ["/topup", "Go to Top-up"],
      mandate: ["/mandates", "Go to Mandates"],
      payment: ["/payables", "Go to Payables"],
    });
  });

  it("offers the faucet and the samples on testnet", () => {
    const text = Object.fromEntries(
      (firstPaymentChecklist(NEW)?.steps ?? []).map((s) => [s.id, s]),
    );
    expect(text.usdc?.title).toBe("Test USDC in the vault");
    expect(text.usdc?.text).toContain("25 test USDC");
    expect(text.mandate?.text).toMatch(/sample purchase order/);
    expect(text.payment?.text).toMatch(/sample invoice/);
    expect(text.payment?.text).toContain("2 test USDC");
  });

  it("says what happens to an invoice no attested model confirms, as the Payables tab does", () => {
    const payment = firstPaymentChecklist(NEW)?.steps[4];
    expect(payment?.text).toMatch(
      /If no attested model confirms the amount, the invoice waits for you/,
    );
  });

  it("points to Top-up for test USDC when this server has no faucet", () => {
    const usdc = firstPaymentChecklist({ ...NEW, faucetUsdc: null })?.steps[2];
    expect(usdc?.text).not.toMatch(/faucet|\d+ test USDC/);
    expect(usdc?.text).toMatch(/Top-up/);
  });

  it("offers no test tokens and no samples on mainnet", () => {
    const steps =
      firstPaymentChecklist({ ...NEW, network: "mainnet", faucetUsdc: null })?.steps ?? [];
    const all = steps.map((s) => `${s.title} ${s.text}`).join(" ");
    expect(all).not.toMatch(/test USDC|faucet|sample/i);
    expect(steps[2]?.title).toBe("USDC in the vault");
  });

  it("says what each key can do, and that the owner adds it from their wallet", () => {
    const keys = firstPaymentChecklist(NEW)?.steps[1];
    expect(keys?.text).toMatch(/wallet/);
    expect(keys?.text).toMatch(/only call spend/);
  });
});
