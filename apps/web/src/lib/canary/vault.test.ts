import type { MandateView } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { summarizeVault } from "./vault";

const mandate = (over: Partial<MandateView> = {}): MandateView => ({
  id: 1,
  payee: { type: "near", account_id: "canary-payee.probarion.testnet" },
  purpose_hash: "0".repeat(64),
  max_per_payment: "1000000",
  max_total: "10000000",
  spent: "0",
  reserved: "0",
  max_uses: 10,
  uses: 0,
  expires_at_ns: "1893456000000000000",
  approval_above: "0",
  agent_pk: "ed25519:11111111111111111111111111111111",
  label: "Canary",
  status: "active",
  created_at_ns: "1793456000000000000",
  ...over,
});

describe("summarizeVault", () => {
  it("formats the balance and the first active mandate", () => {
    expect(summarizeVault({ usdc: "25500000", base: null, mandates: [mandate()] })).toEqual({
      balance: "25.5",
      base: null,
      mandate: {
        kind: "active",
        count: 1,
        payee: "canary-payee.probarion.testnet",
        maxPerPayment: "1",
        holdsEverySpend: true,
      },
      frozen: false,
    });
  });

  it("says a read that failed is unreadable, never zero", () => {
    expect(summarizeVault({ usdc: null, base: null, mandates: null, frozen: null })).toEqual({
      balance: null,
      base: null,
      mandate: { kind: "unreadable" },
      frozen: false,
    });
    expect(summarizeVault({ usdc: "0", base: null, mandates: [] }).balance).toBe("0");
  });

  // The owner's Freeze shows on the public card. A config read that failed shows nothing: it is not drawn as either.
  it("says the vault is frozen only when its config was read as frozen", () => {
    const frozen = (v: boolean | null | undefined) =>
      summarizeVault({ usdc: "1", base: null, mandates: [], frozen: v }).frozen;
    expect(frozen(true)).toBe(true);
    expect(frozen(false)).toBe(false);
    expect(frozen(null)).toBe(false);
    expect(frozen(undefined)).toBe(false);
  });

  it("treats a balance that is not a whole number of base units as unreadable", () => {
    for (const bad of ["", "12.5", "-1", "abc", "1e6"]) {
      expect(summarizeVault({ usdc: bad, base: null, mandates: [] }).balance, bad).toBeNull();
    }
  });

  it("shows the Base balance only when it was read and is above zero", () => {
    const base = (v: string | null) => summarizeVault({ usdc: "1", base: v, mandates: [] }).base;
    expect(base("5000000")).toBe("5");
    expect(base("0")).toBeNull();
    expect(base(null)).toBeNull();
    expect(base("junk")).toBeNull();
  });

  it("does not say every spend is held when the mandate lets small ones through", () => {
    const line = (above: string) =>
      summarizeVault({ usdc: "1", base: null, mandates: [mandate({ approval_above: above })] })
        .mandate;
    expect(line("0")).toMatchObject({ holdsEverySpend: true });
    expect(line("500000")).toMatchObject({ holdsEverySpend: false });
  });

  it("shows a Base payee as base:<address>, and another chain by its own name", () => {
    const payee = (chain: "base" | "solana") =>
      summarizeVault({
        usdc: "1",
        base: null,
        mandates: [mandate({ payee: { type: "intents", chain, address: "0xabc", asset: "x" } })],
      }).mandate;
    expect(payee("base")).toMatchObject({ payee: "base:0xabc" });
    expect(payee("solana")).toMatchObject({ payee: "solana:0xabc" });
  });

  it("skips a revoked or exhausted mandate and counts the active ones", () => {
    const first = mandate({ id: 1, status: "revoked", label: "old" });
    const second = mandate({ id: 2, payee: { type: "near", account_id: "b.testnet" } });
    const third = mandate({ id: 3, payee: { type: "near", account_id: "c.testnet" } });
    expect(
      summarizeVault({ usdc: "1", base: null, mandates: [first, second, third] }).mandate,
    ).toMatchObject({
      kind: "active",
      count: 2,
      payee: "b.testnet",
    });
  });

  it("says there is no mandate when none is active", () => {
    expect(summarizeVault({ usdc: "1", base: null, mandates: [] }).mandate).toEqual({
      kind: "none",
    });
    expect(
      summarizeVault({ usdc: "1", base: null, mandates: [mandate({ status: "exhausted" })] })
        .mandate,
    ).toEqual({ kind: "none" });
  });

  it("calls a mandate with an amount it cannot read unreadable", () => {
    expect(
      summarizeVault({ usdc: "1", base: null, mandates: [mandate({ max_per_payment: "x" })] })
        .mandate,
    ).toEqual({ kind: "unreadable" });
  });
});
