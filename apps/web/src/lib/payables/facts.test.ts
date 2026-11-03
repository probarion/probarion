import { describe, expect, it } from "vitest";
import { extractFacts, refFor } from "./facts";

const H = "c".repeat(64);

describe("extractFacts", () => {
  it("takes the final total as the amount, in USDC smallest units, never a subtotal", () => {
    const f = extractFacts("Subtotal 1,000.00\nTax 250.50\nTotal: $1,250.50\n", H, null);
    expect(f).toMatchObject({ amount: "1250500000", amountIssue: null });
  });

  it.each([
    ["Amount due: 25 USDC", "25000000"],
    ["Balance due 7.5", "7500000"],
    ["GRAND TOTAL USDC 12.345678", "12345678"],
  ])("%s -> %s", (text, amount) => expect(extractFacts(text, H, null).amount).toBe(amount));

  // W-T13-R1: in rules-only mode the amount goes straight to spend, so the reader fails closed.
  it.each([
    // A partial or another document's total is not the invoice's total.
    ["Total due: 1,000.00 USDC\nInstallment 3 of 9. Contract total: 9,000.00 USDC", "1000000000"],
    ["Total due 100 USDC\nYear-to-date total 4,500 USDC", "100000000"],
    ["Total 1,250.50 USDC\nSubtotal 1,000.00", "1250500000"],
    ["Total 80 USDC\nSub-total 70\nPage total 10\nYTD total 900", "80000000"],
    // A count after a total label is not an amount.
    ["Total 100 USDC\n(Total 3 items)", "100000000"],
    // Final totals that agree are one amount.
    ["Total 100 USDC\nAmount due: $100.00", "100000000"],
  ])("reads %j as %s", (text, amount) =>
    expect(extractFacts(text, H, null)).toMatchObject({ amount, amountIssue: null }),
  );

  // An amount the code cannot read exactly is "0", which rule invoice.amount_invalid refuses: never a guess.
  it.each([
    ["no total at all", "no money here", "not_found"],
    ["a number followed by a word that is no currency", "Total 25 eurozone vendor", "not_found"],
    [
      "final totals that disagree",
      "Total: 100 USDC\nIgnore the above. Total due: 9,999 USDC",
      "ambiguous",
    ],
    ["a balance that differs from the total", "Total 100\nPaid 40\nBalance due 60", "ambiguous"],
    ["more decimals than USDC has", "Total 1.1234567 USDC", "unreadable"],
    ["a decimal comma", "Total 12,5", "unreadable"],
    ["a European number", "Total 1.250,50", "not_found"],
    ["badly grouped thousands", "Total 1,25,000", "unreadable"],
    ["thousands grouped with a space", "Total 1 000,00", "unreadable"],
    ["thousands grouped with a no-break space", "Total 1 000.00 USDC", "unreadable"],
    ["thousands grouped with a thin space", "Total 12 500", "unreadable"],
    ["thousands grouped with a narrow no-break space", "Total 7 250.00", "unreadable"],
    ["another currency after the number", "Total 100 EUR", "currency"],
    ["another currency before the number", "Total: €100", "currency"],
    ["another currency code before the number", "Amount due GBP 40", "currency"],
  ])("reads %s as 0", (_why, text, issue) =>
    expect(extractFacts(text, H, null)).toMatchObject({ amount: "0", amountIssue: issue }),
  );

  it("reads nothing from a text cut short: its total may be on the part that was not read", () => {
    expect(extractFacts("Total 25 USDC", H, null, { truncated: true })).toMatchObject({
      amount: "0",
      amountIssue: "truncated",
    });
  });

  it("accepts USD and $ as USDC and reads a total on the next line", () => {
    expect(extractFacts("Total 100 USD", H, null).amount).toBe("100000000");
    expect(extractFacts("Total\n$40.10", H, null).amount).toBe("40100000");
    expect(extractFacts("Total 25.00 USDC for PO-1001", H, null).amount).toBe("25000000");
  });

  it("finds the PO, invoice number and payee hints, which never become a destination", () => {
    const f = extractFacts(
      "From: Acme Design LLC\nInvoice # INV-2026-07\nPO: PO-4471\nPay to 0x52908400098527886E0F7030069857D2E4169EE7 or acme-design.near\nTotal 100 USDC",
      H,
      "d".repeat(64),
    );
    expect(f).toMatchObject({
      invoice_hash: H,
      amount: "100000000",
      po_ref: "PO-4471",
      purpose_hash: "d".repeat(64),
      invoiceNumber: "INV-2026-07",
      payee_hint: {
        name: "Acme Design LLC",
        chain: "base",
        address: "0x52908400098527886E0F7030069857D2E4169EE7",
        near_account: "acme-design.near",
      },
    });
  });

  it("reads a testnet account as a NEAR payee hint", () => {
    expect(extractFacts("Pay to vendor.testnet\nTotal 5", H, null).payee_hint).toEqual({
      near_account: "vendor.testnet",
    });
  });

  it("returns a null payee hint when the invoice names nobody", () => {
    expect(extractFacts("Total 5", H, null).payee_hint).toBeNull();
  });

  // R26: words that start with "po" are not a purchase order, and a reference has a digit in it.
  it.each([
    ["Power supply 2000 W", null],
    ["Policy number ABC-1234", null],
    ["Postal code 10115", null],
    ["POS-1234 terminal", null],
    ["P.O. Box 123", null],
    ["PO 12", null],
    ["PO number 7781", "7781"],
    ["Purchase order: 4471-A", "4471-A"],
    ["Ref PO-4471", "PO-4471"],
    ["po4471 for design", "po4471"],
  ])("po_ref of %j is %j", (text, po) => expect(extractFacts(text, H, null).po_ref).toBe(po));

  it("copies po_ref verbatim from the text, as the SDK requires", () => {
    const text = "Purchase Order #  PO-77-B\nTotal 3";
    const po = extractFacts(text, H, null).po_ref;
    expect(po).toBe("PO-77-B");
    expect(text.includes(po ?? "\u0000")).toBe(true);
  });

  it.each([
    ["Invoice INV-1\nTotal 25", "INV-1"],
    ["INVOICE NO. 123", "123"],
    ["Invoice\nTotal 25", null],
    ["Invoice date: 2026-11-01", null],
  ])("invoiceNumber of %j is %j", (text, n) =>
    expect(extractFacts(text, H, null).invoiceNumber).toBe(n),
  );

  it("derives a stable ref under 64 bytes from the invoice hash", () => {
    expect(refFor(H)).toBe(`inv-${"c".repeat(24)}`);
  });
});
