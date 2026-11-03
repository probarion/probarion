import { describe, expect, it } from "vitest";
import {
  AmountError,
  dateToNs,
  formatNear,
  formatNearUp,
  formatUnits,
  formatUsdc,
  hoursToNs,
  nsToDate,
  parseNear,
  parseUnits,
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

describe("units: fix round 1 bounds", () => {
  it("refuses an amount above u128 with a field error, never a RangeError", () => {
    expect(() => parseNear(`1${"0".repeat(20)}`)).toThrow(AmountError); // 1e44 yocto > 2^128-1
    expect(() => parseUsdc(`1${"0".repeat(40)}`)).toThrow(AmountError);
    const max = (2n ** 128n - 1n).toString();
    expect(parseUnits(max, 0)).toBe(max);
    expect(() => parseUnits((2n ** 128n).toString(), 0)).toThrow(AmountError);
  });

  it("dateToNs takes the years 1970 to 9999 only (Date.UTC reads 0099 as 1999)", () => {
    expect(() => dateToNs("0099-01-01")).toThrow(AmountError);
    expect(() => dateToNs("1969-12-31")).toThrow(AmountError);
    expect(() => dateToNs("10000-01-01")).toThrow(AmountError);
    expect(dateToNs("1970-01-01")).toBe(
      String(BigInt(Date.UTC(1970, 0, 1, 23, 59, 59)) * 1_000_000n),
    );
    expect(dateToNs("9999-12-31")).toBe(
      String(BigInt(Date.UTC(9999, 11, 31, 23, 59, 59)) * 1_000_000n),
    );
  });

  it("formatNearUp rounds a required minimum up, never down", () => {
    expect(formatNearUp("2485010000000000000000001", 6)).toBe("2.485011");
    expect(formatNearUp("2485010000000000000000000", 6)).toBe("2.48501");
    expect(formatNearUp("1", 6)).toBe("0.000001");
    expect(formatNearUp("0", 6)).toBe("0");
    expect(formatNearUp("3000000000000000000000000", 6)).toBe("3");
  });
});
