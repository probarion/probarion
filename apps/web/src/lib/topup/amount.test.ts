import { describe, expect, it } from "vitest";
import {
  MAX_TOPUP_UNITS,
  MIN_TOPUP_UNITS,
  parseFundAmount,
  parseTopupAmount,
  TOPUP_RANGE_TEXT,
} from "./amount";

describe("the 1Click top-up amount", () => {
  it("takes from 1 to 1000 USDC, both ends included", () => {
    expect(parseTopupAmount("1")).toEqual({ units: "1000000" });
    expect(parseTopupAmount("20")).toEqual({ units: "20000000" });
    expect(parseTopupAmount(" 12.5 ")).toEqual({ units: "12500000" });
    expect(parseTopupAmount("1000")).toEqual({ units: "1000000000" });
    expect(MIN_TOPUP_UNITS).toBe(1_000_000n);
    expect(MAX_TOPUP_UNITS).toBe(1_000_000_000n);
  });

  it("refuses less than 1 USDC and more than 1000 USDC, by one unit", () => {
    expect(parseTopupAmount("0.999999")).toEqual({ problem: TOPUP_RANGE_TEXT });
    expect(parseTopupAmount("0")).toEqual({ problem: TOPUP_RANGE_TEXT });
    expect(parseTopupAmount("1000.000001")).toEqual({ problem: TOPUP_RANGE_TEXT });
    expect(TOPUP_RANGE_TEXT).toBe("Between 1 and 1000 USDC");
  });

  it("says what is wrong with an amount that is not a plain decimal", () => {
    for (const bad of ["", "abc", "-5", "1e3", "1,000", "0x10", "1.0000001", "٣"]) {
      const r = parseTopupAmount(bad);
      expect(r, bad).toHaveProperty("problem");
      expect((r as { problem: string }).problem.length).toBeGreaterThan(0);
    }
    expect(parseTopupAmount("1.0000001")).toEqual({ problem: "At most 6 decimal places" });
  });
});

describe("the amount of USDC sent from the owner's wallet to the vault", () => {
  it("takes any amount above zero", () => {
    expect(parseFundAmount("0.000001")).toEqual({ units: "1" });
    expect(parseFundAmount("25")).toEqual({ units: "25000000" });
    expect(parseFundAmount("5000")).toEqual({ units: "5000000000" });
  });

  it("refuses zero and what is not a plain decimal", () => {
    expect(parseFundAmount("0")).toEqual({ problem: "Must be above 0" });
    expect(parseFundAmount("0.000000")).toEqual({ problem: "Must be above 0" });
    expect(parseFundAmount("-1")).toHaveProperty("problem");
    expect(parseFundAmount("")).toHaveProperty("problem");
    expect(parseFundAmount("1.0000001")).toEqual({ problem: "At most 6 decimal places" });
  });
});
