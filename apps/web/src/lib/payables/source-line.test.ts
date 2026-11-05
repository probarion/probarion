import { describe, expect, it } from "vitest";
import { invoiceLines, sourceLine } from "./source-line";

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
