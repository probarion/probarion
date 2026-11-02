import { describe, expect, it } from "vitest";
import {
  AmountError,
  dateToNs,
  formatNear,
  formatUnits,
  formatUsdc,
  hoursToNs,
  nsToDate,
  parseNear,
  parseUsdc,
} from "./units";

describe("units", () => {
  it.each([
    ["25", "25000000"],
    ["0.5", "500000"],
    [" 12.345678 ", "12345678"],
    ["0", "0"],
  ])("parseUsdc(%s) = %s", (h, u) => expect(parseUsdc(h)).toBe(u));

  it.each(["1e3", "0.0000001", "-1", "1,000", "", "abc", "01", "1."])("rejects %s", (h) => {
    expect(() => parseUsdc(h)).toThrow(AmountError);
  });

  it("formats without trailing zeros", () => {
    expect(formatUsdc("25000000")).toBe("25");
    expect(formatUsdc("20208197")).toBe("20.208197");
    expect(formatNear(parseNear("1.25"))).toBe("1.25");
    expect(formatNear("190000000000000000000000")).toBe("0.19");
  });

  it("cuts (never rounds up) to maxFrac, so a balance is never shown larger than it is", () => {
    expect(formatNear("199999999999999999999999")).toBe("0.1999");
    expect(formatUnits("123456", 6, 2)).toBe("0.12");
    expect(formatUnits("-1500000", 6)).toBe("-1.5");
  });

  it("converts hours and end-of-day dates to nanoseconds", () => {
    expect(hoursToNs(72)).toBe("259200000000000");
    expect(dateToNs("2026-12-31")).toBe(
      String(BigInt(Date.UTC(2026, 11, 31, 23, 59, 59)) * 1_000_000n),
    );
    expect(() => dateToNs("2026-13-01")).toThrow(AmountError);
    expect(() => dateToNs("2026-02-30")).toThrow(AmountError);
    expect(nsToDate("259200000000000").toISOString()).toBe("1970-01-04T00:00:00.000Z");
  });
});
