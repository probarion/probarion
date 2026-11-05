import { describe, expect, it } from "vitest";
import { aroundFigure, invoiceLines, shownLine, sourceLine } from "./source-line";

// The exact line the amount was read from (ruling W-T14-R2): the reader's own answer, re-run on the retained text,
// not a search for the figure.

const BODY = "Invoice INV-77\nPO: PO-1001\nPay to vendor.testnet";

describe("sourceLine", () => {
  it.each([
    ["the total as the last line", `${BODY}\nTotal 20.00 USDC`, "20000000", "Total 20.00 USDC"],
    [
      "a due date after the total",
      `${BODY}\nTotal 20.00 USDC\nDue date: 2026-11-20`,
      "20000000",
      "Total 20.00 USDC",
    ],
    [
      "payment terms after the total",
      `${BODY}\nTotal 20.00 USDC\nPayment due within 20 days`,
      "20000000",
      "Total 20.00 USDC",
    ],
    [
      "net terms after the total",
      `${BODY}\nTotal 30.00 USDC\nNet 30, payable within 30 days`,
      "30000000",
      "Total 30.00 USDC",
    ],
    [
      "a payable-by date after the total",
      `${BODY}\nTotal 15.00 USDC\nPayable by 2026-11-15`,
      "15000000",
      "Total 15.00 USDC",
    ],
    [
      "an unlabelled figure after the total",
      `${BODY}\nTotal 10.00 USDC\nThank you, 10 years serving you`,
      "10000000",
      "Total 10.00 USDC",
    ],
  ])("names the real total line with %s", (_why, text, units, line) => {
    expect(sourceLine(text, units)).toEqual({ number: 4, text: line });
  });

  it("names nothing when the reader does not read that amount from the text now", () => {
    expect(sourceLine(`${BODY}\nTotal 20.00 USDC`, "20000001")).toBeNull();
    expect(sourceLine(`${BODY}\nTotal 20.00 EUR`, "20000000")).toBeNull();
    expect(sourceLine("", "1")).toBeNull();
  });

  it("trims blanks and reads tabs as spaces, so the figure shows", () => {
    expect(sourceLine(`${BODY}\n${" ".repeat(300)}Total 20.00 USDC`, "20000000")).toEqual({
      number: 4,
      text: "Total 20.00 USDC",
    });
    expect(sourceLine(`${BODY}\n\t\tTotal\t20.00 USDC`, "20000000")).toEqual({
      number: 4,
      text: "Total 20.00 USDC",
    });
    expect(shownLine(`${" ".repeat(400)}Item\t\tA  `)).toBe("Item A");
  });

  it("numbers the lines the way the page shows them, whatever the line ends", () => {
    const text = "INVOICE INV-1001\r\nBill to: Beta\n\nItem 1\fTotal $5.00";
    expect(invoiceLines(text)).toEqual([
      "INVOICE INV-1001",
      "Bill to: Beta",
      "",
      "Item 1",
      "Total $5.00",
    ]);
    expect(sourceLine(text, "5000000")).toEqual({ number: 5, text: "Total $5.00" });
  });
});

describe("aroundFigure", () => {
  it("leaves a short line as it is, with its blanks collapsed", () => {
    expect(aroundFigure("Total    20.00 USDC", "20000000")).toBe("Total 20.00 USDC");
  });

  it("cuts a long line around the figure, not from the start", () => {
    const line = `${"x".repeat(1000)} Total 20.00 USDC ${"y".repeat(1000)}`;
    const shown = aroundFigure(line, "20000000");
    expect(shown).toContain("Total 20.00 USDC");
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.endsWith("…")).toBe(true);
    expect(Array.from(shown).length).toBeLessThanOrEqual(302);
  });

  it("finds a grouped figure and a figure at the end of the line", () => {
    const shown = aroundFigure(`${"note ".repeat(200)}Amount due $1,277.35`, "1277350000");
    expect(shown.endsWith("Amount due $1,277.35")).toBe(true);
    expect(shown.startsWith("…")).toBe(true);
  });

  it("keeps the end of the line when the figure is not written as digits it knows", () => {
    const shown = aroundFigure(`${"a".repeat(1000)} the end`, "20000000");
    expect(shown.endsWith("the end")).toBe(true);
    expect(Array.from(shown).length).toBeLessThanOrEqual(302);
  });

  it("does not cut a character in two, and shows no control character", () => {
    const shown = aroundFigure(
      `${"\u{1F600}".repeat(400)} Total 20.00 USDC ${"\u{1F600}".repeat(400)}\u0007`,
      "20000000",
    );
    expect(shown).toContain("Total 20.00 USDC");
    // encodeURIComponent throws on half a surrogate pair.
    expect(() => encodeURIComponent(shown)).not.toThrow();
    expect(shown).not.toContain("\u0007");
  });
});
