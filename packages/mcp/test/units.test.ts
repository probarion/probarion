import { describe, expect, it } from "vitest";
import { AmountError, formatUsdc, parseUsdc } from "../src/units.js";

describe("parseUsdc", () => {
  it.each([
    ["25", "25000000"],
    ["25.5", "25500000"],
    ["25.50", "25500000"],
    ["0.01", "10000"],
    ["0.000001", "1"],
    ["999999999999.999999", "999999999999999999"],
  ])("%s USDC -> %s units", (human, units) => {
    expect(parseUsdc(human)).toBe(units);
  });

  it.each([
    "25 USDC",
    "1e3",
    "25,50",
    "-1",
    "+1",
    "0",
    "0.0",
    "0.0000001",
    "01",
    ".5",
    "5.",
    "",
    " 5",
    "25000000000000",
  ])("rejects %j", (human) => {
    expect(() => parseUsdc(human)).toThrow(AmountError);
  });
});

describe("formatUsdc", () => {
  it.each([
    ["25500000", "25.50"],
    ["10000", "0.01"],
    ["1", "0.000001"],
    ["100000000", "100.00"],
    ["0", "0.00"],
  ])("%s units -> %s USDC", (units, human) => {
    expect(formatUsdc(units)).toBe(human);
  });
});
