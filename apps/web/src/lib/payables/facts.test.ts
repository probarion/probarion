import { describe, expect, it } from "vitest";
import { extractFacts, fingerprintText, refFor } from "./facts";
import { nearAccounts } from "./lexicon";

// The facts other than the amount (amount.test.ts and its corpora cover the amount reader), and the shape
// extractFacts returns.

const H = "c".repeat(64);

describe("extractFacts", () => {
  it("returns the five InvoiceFacts keys, the invoice number and why the amount was refused", () => {
    expect(extractFacts("Invoice INV-1\nTotal $25.00", H, "d".repeat(64))).toEqual({
      invoice_hash: H,
      amount: "25000000",
      po_ref: null,
      purpose_hash: "d".repeat(64),
      payee_hint: null,
      invoiceNumber: "INV-1",
      amountIssue: null,
    });
    expect(extractFacts("Total 25", H, null)).toMatchObject({
      amount: "0",
      amountIssue: "unreadable",
    });
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
    expect(extractFacts("Pay to vendor.testnet\nTotal 5 USDC", H, null).payee_hint).toEqual({
      near_account: "vendor.testnet",
    });
  });

  it("returns a null payee hint when the invoice names nobody", () => {
    expect(extractFacts("Total 5 USDC", H, null).payee_hint).toBeNull();
  });

  // "PO" must be a word of its own (not "Power", "Policy", "Postal"), and a reference has a digit in it.
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

describe("nearAccounts", () => {
  it.each([
    ["Pay to acme-design.near or 0x00", ["acme-design.near"]],
    ["Pay to vendor.testnet.", ["vendor.testnet"]],
    ["x@sub.acme_co.near, y.near", ["sub.acme_co.near", "y.near"]],
    ["Acme.near", []],
    ["near", []],
    [".near", []],
    ["a--b.near", []],
    [`${"a".repeat(60)}.near`, []],
    [`${"a-".repeat(31)}.`.repeat(10), []],
  ])("finds the NEAR accounts in %j", (text, accounts) =>
    expect(nearAccounts(text)).toEqual(accounts),
  );
});

describe("fingerprintText", () => {
  it("is the same text whatever the line ends, the case, spaces or compatibility forms", () => {
    const base = fingerprintText("Invoice INV-1\nTotal 5 USDC");
    for (const variant of [
      "Invoice INV-1\nTotal 5 USDC\n",
      "Invoice INV-1\r\nTotal 5 USDC\r\n",
      "invoice inv-1\ntotal 5 usdc",
      "Invoice\u00a0INV-1\n\nTotal  5\tUSDC",
      "  Invoice INV-1\nTotal 5 USDC  ",
      "\uff29nvoice INV-1\nTotal \uff15 USDC",
    ]) {
      expect(fingerprintText(variant)).toBe(base);
    }
    expect(fingerprintText("Invoice INV-1\nTotal 6 USDC")).not.toBe(base);
  });
});
