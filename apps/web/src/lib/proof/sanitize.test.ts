import { describe, expect, it } from "vitest";
import { REMOVED, safeText } from "./sanitize";

describe("safeText (ledger and chain text is untrusted)", () => {
  it("keeps ordinary text, including non-Latin letters and emoji", () => {
    expect(safeText("spend 3: memo WITHDRAW_TO:0x52 — ok")).toBe(
      "spend 3: memo WITHDRAW_TO:0x52 — ok",
    );
    expect(safeText("Thanh toán hóa đơn 💸")).toBe("Thanh toán hóa đơn 💸");
  });

  it("replaces bidi and other format controls, so 'fail' cannot be made to read as 'pass'", () => {
    for (const ch of [
      "\u202E",
      "\u202D",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
      "\u200B",
      "\u200F",
      "\uFEFF",
      "\u00AD",
    ]) {
      expect(safeText(`a${ch}b`), `U+${ch.codePointAt(0)?.toString(16)}`).toBe(`a${REMOVED}b`);
    }
    expect(safeText("\u202Eliaf")).toBe(`${REMOVED}liaf`);
  });

  it("replaces control characters, newlines and the Unicode line and paragraph separators", () => {
    for (const ch of [
      "\u0000",
      "\u0007",
      "\t",
      "\n",
      "\r",
      "\u001b",
      "\u007f",
      "\u0085",
      "\u2028",
      "\u2029",
    ]) {
      expect(safeText(`a${ch}b`), `U+${ch.codePointAt(0)?.toString(16)}`).toBe(`a${REMOVED}b`);
    }
    expect(safeText("x\u001b[32mRESULT: PASS\u001b[0m")).toBe(
      `x${REMOVED}[32mRESULT: PASS${REMOVED}[0m`,
    );
  });

  it("replaces every unsafe character, not only the first", () => {
    expect(safeText("\u202E\u202E\n")).toBe(REMOVED.repeat(3));
  });

  it("turns any value into text without throwing", () => {
    expect(safeText(42)).toBe("42");
    expect(safeText(null)).toBe("null");
    expect(safeText(undefined)).toBe("undefined");
    expect(safeText({ a: 1 })).toBe("[object Object]");
  });

  it("uses U+FFFD as the mark", () => {
    expect(REMOVED).toBe("\uFFFD");
  });
});
