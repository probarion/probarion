import { describe, expect, it } from "vitest";
import {
  ALLOWANCE_LOW_ALERT_YOCTO,
  codeStorageYocto,
  createDepositPlan,
  EMBEDDED_CODE_ESTIMATE_BYTES,
  EMBEDDED_VAULT_WASM_BYTES,
  FRESH_VAULT_STATE_BYTES,
  freeNearYocto,
  LOW_NEAR_YOCTO,
  NEAR_LOW_ALERT_YOCTO,
  NEAR_PER_SPEND_YOCTO,
  nearRunway,
  STORAGE_BYTE_COST_YOCTO,
} from "./runway";

const NEAR = 10n ** 24n;
const milli = (n: bigint) => (n * NEAR) / 1000n;

describe("runway constants (R3)", () => {
  it("pins the figures from docs/runbooks/factory.md and mainnet-v0.md", () => {
    expect(STORAGE_BYTE_COST_YOCTO).toBe(10n ** 19n); // 0.00001 NEAR per byte
    expect(NEAR_PER_SPEND_YOCTO).toBe((53n * NEAR) / 10_000n); // 0.0053 NEAR
    expect(LOW_NEAR_YOCTO).toBe(milli(100n)); // amber below 0.1 NEAR
    expect(NEAR_LOW_ALERT_YOCTO).toBe(milli(50n)); // near_low below 0.05 NEAR (Task 20)
    expect(ALLOWANCE_LOW_ALERT_YOCTO).toBe(milli(200n)); // allowance_low below 0.2 NEAR (Task 20)
    expect(EMBEDDED_VAULT_WASM_BYTES).toBe(248_501n);
    // +10% on the measured wasm, rounded up: the factory does not expose code_len (ICR to come)
    expect(EMBEDDED_CODE_ESTIMATE_BYTES).toBe(273_352n);
    expect(FRESH_VAULT_STATE_BYTES).toBe(250_733n - 248_501n);
  });
});

describe("nearRunway", () => {
  it("free NEAR is the balance minus the storage stake, and runway counts 0.0053 NEAR spends", () => {
    // 3 NEAR, 250,733 bytes: 2.50733 NEAR staked, 0.49267 free, 92 spends.
    const r = nearRunway({ amount: (3n * NEAR).toString(), storage_usage: 250_733 });
    expect(r.freeYocto).toBe("492670000000000000000000");
    expect(r.spends).toBe(92);
    expect(r.low).toBe(false);
    expect(r.alert).toBe(false);
  });

  it("is amber below 0.1 NEAR free and alerting below 0.05", () => {
    const at = (free: bigint) =>
      nearRunway({
        amount: (free + 1000n * STORAGE_BYTE_COST_YOCTO).toString(),
        storage_usage: 1000,
      });
    expect(at(milli(100n))).toMatchObject({ low: false, alert: false });
    expect(at(milli(100n) - 1n)).toMatchObject({ low: true, alert: false });
    expect(at(milli(50n))).toMatchObject({ low: true, alert: false });
    expect(at(milli(50n) - 1n)).toMatchObject({ low: true, alert: true });
  });

  it("never reports less than zero free NEAR", () => {
    expect(freeNearYocto({ amount: "5", storage_usage: 1 })).toBe(0n);
    expect(nearRunway({ amount: "0", storage_usage: 100 })).toMatchObject({
      freeYocto: "0",
      spends: 0,
      low: true,
    });
  });
});

describe("createDepositPlan (R14)", () => {
  const min = (NEAR / 2n).toString(); // 0.5 NEAR

  it("global mode: the factory requires min_deposit, and nearly all of it is runway", () => {
    expect(codeStorageYocto("global")).toBe(0n);
    const p = createDepositPlan(min, "global", NEAR / 2n);
    expect(p.requiredYocto).toBe(NEAR / 2n);
    expect(p.covers).toBe(true);
    // 0.5 - 2,232 bytes (0.02232) = 0.47768 free: 90 spends
    expect(p.freeYocto).toBe(NEAR / 2n - FRESH_VAULT_STATE_BYTES * STORAGE_BYTE_COST_YOCTO);
    expect(p.spends).toBe(90);
  });

  it("embedded mode adds the storage of the vault's copy of the wasm, with a 10% margin (2.73352 NEAR)", () => {
    expect(codeStorageYocto("embedded")).toBe(2_733_520n * 10n ** 18n);
    const required = NEAR / 2n + 2_733_520n * 10n ** 18n;
    expect(createDepositPlan(min, "embedded", required).covers).toBe(true);
    expect(createDepositPlan(min, "embedded", required - 1n).covers).toBe(false);
    // min_deposit alone does not cover an embedded vault, and leaves no runway
    const short = createDepositPlan(min, "embedded", NEAR / 2n);
    expect(short).toMatchObject({ covers: false, requiredYocto: required, spends: 0 });
    expect(short.freeYocto).toBe(0n);
  });

  it("does not cover a deposit that would not even pay the vault's own state", () => {
    const p = createDepositPlan("0", "global", 1000n);
    expect(p.covers).toBe(false);
    expect(p.spends).toBe(0);
  });
});
