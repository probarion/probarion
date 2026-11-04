import { describe, expect, it } from "vitest";
import { extractFacts, fingerprintText, invoiceNumberOf, numberKeyText, refFor } from "./facts";
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
    // Invisible characters and other dashes are not part of the number.
    ["Invoice INV-10\u200b01\nTotal 25", "INV-1001"],
    ["Invoice INV\u20111001\nTotal 25", "INV-1001"],
    ["Invoice INV\u22121001\nTotal 25", "INV-1001"],
    // More ways to write the number.
    ["Invoice: #1001", "1001"],
    ["Bill #1001", "1001"],
    ["Inv. No. 1001", "1001"],
    ["Invoice n\u00b0 1001", "1001"],
    ["Invoice Number\t# 1067", "1067"],
    ["Bill to: Globex Corp", null],
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
      // It renders the same: invisible characters, other dashes, look-alike letters, combining marks.
      "Invoice INV\u2011\u200b1\nTotal 5 USDC",
      "Inv\u043eice INV-1\nTotal 5 USDC",
      "Invoice INV\u22121\nTot\u00adal 5 USDC",
      "Invoice INV-1\nTotal 5 US\u034fDC",
    ]) {
      expect(fingerprintText(variant)).toBe(base);
    }
    expect(fingerprintText("Invoice INV-1\nTotal 6 USDC")).not.toBe(base);
  });
});

/**
 * The duplicate guard's two keys for a text, as the pipeline computes them: the fingerprint, and the invoice
 * number in its key form (pipeline.ts keys an HMAC of it with the vault and the payee).
 */
const keysOf = (text: string) => {
  const number = invoiceNumberOf(text);
  return {
    fingerprint: fingerprintText(text),
    number: number === null ? null : numberKeyText(number),
  };
};
/** Either key equal: the guard answers the second text as a duplicate of the first. */
const guarded = (paid: string, again: string): boolean => {
  const a = keysOf(paid);
  const b = keysOf(again);
  return a.fingerprint === b.fingerprint || (a.number !== null && a.number === b.number);
};

describe("the duplicate guard's keys", () => {
  const P =
    "Acme Studio LLC\nInvoice INV-1001\nDate: 2026-10-01\nLogo design $1,000.00\nTotal $1,000.00";

  it.each([
    ["O for zero", "INV-1OO1"],
    ["l for one", "INV-l00l"],
    ["Cyrillic O for zero", "INV-1\u041e\u041e1"],
    ["a modifier minus", "INV\u02d71001"],
    ["a heavy minus", "INV\u27961001"],
    ["a box-drawing line", "INV\u25001001"],
    ["a long-vowel mark", "INV\u30fc1001"],
    ["a hyphen bullet", "INV\u20431001"],
    ["a space", "INV 1001"],
    ["a zero-width space", "INV-10\u200b01"],
    ["a non-breaking hyphen", "INV\u20111001"],
  ])("keys a re-upload whose number is written with %s as the paid original", (_why, written) => {
    expect(guarded(P, P.replace("INV-1001", written))).toBe(true);
  });

  it.each([
    [
      "a number with look-alike digits after #",
      "Invoice # 1001\nLogo design $1,000.00\nTotal $1,000.00",
      "Invoice # 1OO1\nLogo design $1,000.00\nTotal $1,000.00",
    ],
    [
      "a Braille blank in an item, the number under a header cell",
      "Acme Studio LLC\nINVOICE\nInvoice #\tDate\nINV-1001\t2026-10-01\nLogo design $1,000.00\nTotal $1,000.00",
      "Acme Studio LLC\nINVOICE\nInvoice #\tDate\nINV-1001\t2026-10-01\nLogo\u2800design $1,000.00\nTotal $1,000.00",
    ],
    [
      "a Hangul filler in an item, the number on the line after its label",
      "Acme Studio LLC\nInvoice number:\nINV-1001\nLogo design $1,000.00\nTotal $1,000.00",
      "Acme Studio LLC\nInvoice number:\nINV-1001\nLogo\u3164design $1,000.00\nTotal $1,000.00",
    ],
    [
      "a reminder line, the number as a token",
      "Acme Studio LLC\nReference INV-1001\nLogo design $1,000.00\nTotal $1,000.00",
      "Acme Studio LLC\nReference INV-1001\nLogo design $1,000.00\nTotal $1,000.00\nReminder: overdue",
    ],
    [
      "a reminder line, the number after #",
      "INVOICE\nKestrel IT Services\n# INV-000415\nInvoice Date : 02 Nov 2026\nManaged IT support - November\t$750.00\nTotal\t$750.00\n",
      "INVOICE\nKestrel IT Services\n# INV-000415\nInvoice Date : 02 Nov 2026\nReminder: this invoice is now 15 days overdue.\nManaged IT support - November\t$750.00\nTotal\t$750.00\n",
    ],
    [
      "a second notice, the number as INV and a space",
      "INVOICE\nOak & Anvil Furniture Restoration\nINV 2026-0451\nCustomer: Bellweather Inn\nRefinish 12 dining chairs\t$1,140.00\nInvoice Total: $1,800.00\n",
      "INVOICE\nOak & Anvil Furniture Restoration\nINV 2026-0451\nCustomer: Bellweather Inn\nSecond notice - please remit\nRefinish 12 dining chairs\t$1,140.00\nInvoice Total: $1,800.00\n",
    ],
    [
      "a reminder line, the number as No.",
      "INVOICE\nAcme\nNo. 5520\nLogo design\t$750.00\nTotal\t$750.00\n",
      "INVOICE\nAcme\nNo. 5520\nLogo design\t$750.00\nReminder: overdue\nTotal\t$750.00\n",
    ],
    [
      "a reminder line, the number as n\u00b0",
      "INVOICE\nAcme\nn\u00b0 5520\nLogo design\t$750.00\nTotal\t$750.00\n",
      "INVOICE\nAcme\nn\u00b0 5520\nLogo design\t$750.00\nReminder: overdue\nTotal\t$750.00\n",
    ],
    [
      "a reminder line, the number after Invoice #:",
      "INVOICE\nAcme\nInvoice #: INV-000415\nLogo design\t$750.00\nTotal\t$750.00\n",
      "INVOICE\nAcme\nInvoice #: INV-000415\nLogo design\t$750.00\nReminder: overdue\nTotal\t$750.00\n",
    ],
  ])("keys a re-upload with %s as the paid original", (_why, paid, again) => {
    expect(guarded(paid, again)).toBe(true);
  });

  it.each([
    ["the next number", P, P.replace("INV-1001", "INV-1002")],
    ["a longer number", P, P.replace("INV-1001", "INV-10010")],
    ["a number with a suffix", P, P.replace("INV-1001", "INV-1001A")],
    [
      "another No.",
      "INVOICE\nAcme\nNo. 5520\nTotal\t$750.00\n",
      "INVOICE\nAcme\nNo. 5521\nTotal\t$750.00\n",
    ],
    [
      "another amount and no number",
      "INVOICE\nAcme\nLogo design $700.00\nTotal $700.00",
      "INVOICE\nAcme\nLogo design $800.00\nTotal $800.00",
    ],
  ])("keys %s as another invoice", (_why, a, b) => {
    expect(guarded(a, b)).toBe(false);
  });

  it.each([
    ["# INV-000415", "INVOICE\n# INV-000415\nTotal $5.00", "INV-000415"],
    ["INV and a space", "INVOICE\nINV 2026-0451\nTotal $5.00", "INV 2026-0451"],
    ["No. in the header", "INVOICE\nAcme\nNo. 5520\nTotal $5.00", "5520"],
    ["n\u00b0 in the header", "INVOICE\nAcme\nn\u00b0 5520\nTotal $5.00", "5520"],
    ["the line after the label", "Invoice number:\nINV-1001\nTotal $5.00", "INV-1001"],
    [
      "the line after the label, with no INV",
      "Invoice number:\n2026-0451\nTotal $5.00",
      "2026-0451",
    ],
    ["under a header cell", "Invoice #\tDate\nINV-1001\t2026-10-01\nTotal $5.00", "INV-1001"],
    ["under a header cell, with no INV", "Invoice #\tDate\n5520\t2026-10-01\nTotal $5.00", "5520"],
    ["an -INV- segment", "INVOICE CCC-INV-4410\nTotal $5.00", "CCC-INV-4410"],
    ["look-alike digits", "Invoice # 1OO1\nTotal $5.00", "1001"],
    ["a ref. label", "Invoice ref. A-1\nTotal $5.00", "A-1"],
  ])("reads one invoice number written as %s", (_why, text, number) => {
    expect(invoiceNumberOf(text)).toBe(number);
  });

  it("keys INV 1001, inv-1001 and INV-1001 as one number", () => {
    expect(numberKeyText("INV 1001")).toBe(numberKeyText("INV-1001"));
    expect(numberKeyText("inv-1001")).toBe(numberKeyText("INV-1001"));
    expect(numberKeyText("INV-1002")).not.toBe(numberKeyText("INV-1001"));
  });

  it("folds blank-rendering characters and digit look-alikes into the fingerprint", () => {
    expect(fingerprintText("Logo\u2800design 1OO1")).toBe(fingerprintText("Logo design 1001"));
    expect(fingerprintText("Logo\u3164design")).toBe(fingerprintText("Logo design"));
    // A look-alike digit is a digit only beside a real one: "OO" alone stays letters.
    expect(fingerprintText("Total OO")).not.toBe(fingerprintText("Total 00"));
  });
});
