import { describe, expect, it } from "vitest";
import { MAX_TEXT, REMOVED, safeText } from "./sanitize";

const mark = String.fromCodePoint(0x0301); // combining acute accent
const ring = String.fromCodePoint(0x030a); // combining ring above
const ellipsis = String.fromCodePoint(0x2026);

describe("safeText: stacked marks and length", () => {
  it("keeps up to two combining marks in a row, so real accents survive", () => {
    expect(safeText(`e${mark}`)).toBe(`e${mark}`);
    expect(safeText(`e${mark}${ring}x`)).toBe(`e${mark}${ring}x`);
  });

  it("drops a longer run of marks, which would paint over the rows around it", () => {
    expect(safeText(`a${mark.repeat(50)}b`)).toBe(`a${mark}${mark}b`);
    expect(safeText(`a${mark}${ring}${mark}${ring}`)).toBe(`a${mark}${ring}`);
    expect(safeText(`x${mark.repeat(3)}y${ring.repeat(9)}`)).toBe(`x${mark}${mark}y${ring}${ring}`);
  });

  it("caps text at 300 code points by default, marking the cut with an ellipsis", () => {
    expect(MAX_TEXT).toBe(300);
    expect(safeText("x".repeat(300))).toBe("x".repeat(300));
    expect(safeText("x".repeat(301))).toBe(`${"x".repeat(300)}${ellipsis}`);
    // Code points, not UTF-16 units: an emoji counts once and is never split.
    const emoji = String.fromCodePoint(0x1f4b8);
    expect(safeText(emoji.repeat(301))).toBe(`${emoji.repeat(300)}${ellipsis}`);
  });

  it("takes a longer cap where the caller asks for one, such as a check's detail", () => {
    expect(safeText("y".repeat(1000), 1000)).toBe("y".repeat(1000));
    expect(safeText("y".repeat(1001), 1000)).toBe(`${"y".repeat(1000)}${ellipsis}`);
  });

  it("caps after replacing, so a removed character counts once", () => {
    const rlo = String.fromCodePoint(0x202e);
    expect(safeText(rlo.repeat(301))).toBe(`${REMOVED.repeat(300)}${ellipsis}`);
  });
});

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
