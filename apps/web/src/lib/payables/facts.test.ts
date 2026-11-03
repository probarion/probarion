import { describe, expect, it } from "vitest";
import { extractFacts, refFor } from "./facts";

const H = "c".repeat(64);

describe("extractFacts", () => {
  it("takes the last total as the amount, in USDC smallest units", () => {
    const f = extractFacts("Subtotal 1,000.00\nTax 250.50\nTotal: $1,250.50\n", H, null);
    expect(f.amount).toBe("1250500000");
  });

  it.each([
    ["Amount due: 25 USDC", "25000000"],
    ["Balance due 7.5", "7500000"],
    ["GRAND TOTAL USDC 12.345678", "12345678"],
    ["no money here", "0"],
  ])("%s -> %s", (text, amount) => expect(extractFacts(text, H, null).amount).toBe(amount));

  // An amount the code cannot read exactly is "0", which rule invoice.amount_invalid refuses: never a guess.
  it.each([
    ["more decimals than USDC has", "Total 1.1234567 USDC"],
    ["a decimal comma", "Total 12,5"],
    ["a European number", "Total 1.250,50"],
    ["badly grouped thousands", "Total 1,25,000"],
    ["another currency after the number", "Total 100 EUR"],
    ["another currency before the number", "Total: €100"],
    ["another currency code before the number", "Amount due GBP 40"],
  ])("reads %s as 0", (_why, text) => expect(extractFacts(text, H, null).amount).toBe("0"));

  it("accepts USD and $ as USDC and reads a total on the next line", () => {
    expect(extractFacts("Total 100 USD", H, null).amount).toBe("100000000");
    expect(extractFacts("Total\n$40.10", H, null).amount).toBe("40100000");
    expect(extractFacts("Total 25 eurozone vendor", H, null).amount).toBe("25000000");
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
