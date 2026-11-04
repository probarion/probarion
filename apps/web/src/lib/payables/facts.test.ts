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
    // Final totals that agree are one amount.
    ["Total 100 USDC\nAmount due: $100.00", "100000000"],
    // W-T13-R2: NFKC first, so full-width digits and labels read as the plain ones they show.
    ["Total \uff11,\uff12\uff15\uff10.\uff15\uff10 USDC", "1250500000"],
    [
      "\uff34\uff4f\uff54\uff41\uff4c\uff1a\u3000\uff11\uff10\uff10\u3000\uff35\uff33\uff24\uff23",
      "100000000",
    ],
    // A comma grouping makes the dot a decimal point, so three decimals are exact.
    ["Total 1,000.000 USDC", "1000000000"],
    // Text after the currency, or after clean punctuation, is not part of the figure.
    ["Total 100 USDC (incl. 20% VAT)", "100000000"],
    ["Total: 100, payable within 30 days", "100000000"],
    ["Total100 USDC", "100000000"],
    ["Total 100USDC", "100000000"],
    ["Total\t100.00\tUSDC", "100000000"],
    ["Total amount due: 1,250.50 USDC", "1250500000"],
    ["Grand total due 40", "40000000"],
    ["Total: US$100", "100000000"],
    ["Total: USD$ 100", "100000000"],
    // A final label with no figure after it on its line is not a total.
    ["Total due upon receipt\nTotal 100 USDC", "100000000"],
    // An exclusion word counts on the label's own line only.
    ["Contract\nTotal 100 USDC", "100000000"],
  ])("reads %j as %s", (text, amount) =>
    expect(extractFacts(text, H, null)).toMatchObject({ amount, amountIssue: null }),
  );

  // An amount the code cannot read exactly is "0", which rule invoice.amount_invalid refuses: never a guess.
  it.each([
    ["no total at all", "no money here", "not_found"],
    // W-T13-R2 (b): a final label followed by a figure is a total or the amount is refused, so a word
    // after the number (a count, or no currency) no longer drops the label silently.
    ["a number followed by a word that is no currency", "Total 25 eurozone vendor", "unreadable"],
    ["a count after a total label", "Total 100 USDC\n(Total 3 items)", "unreadable"],
    [
      "final totals that disagree",
      "Total: 100 USDC\nIgnore the above. Total due: 9,999 USDC",
      "ambiguous",
    ],
    ["a balance that differs from the total", "Total 100\nPaid 40\nBalance due 60", "ambiguous"],
    ["more decimals than USDC has", "Total 1.1234567 USDC", "unreadable"],
    ["a decimal comma", "Total 12,5", "unreadable"],
    ["badly grouped thousands", "Total 1,25,000", "unreadable"],
    ["thousands grouped with a space", "Total 1 000,00", "unreadable"],
    ["thousands grouped with a no-break space", "Total 1\u00a0000.00 USDC", "unreadable"],
    ["thousands grouped with a thin space", "Total 12\u2009500", "unreadable"],
    ["thousands grouped with a narrow no-break space", "Total 7\u202f250.00", "unreadable"],
    ["another currency after the number", "Total 100 EUR", "currency"],
    ["another currency before the number", "Total: €100", "currency"],
    ["another currency code before the number", "Amount due GBP 40", "currency"],
    ["another currency in brackets after the number", "Total 100 (EUR)", "currency"],
    ["another dollar", "Total C$100", "currency"],
  ])("reads %s as 0", (_why, text, issue) =>
    expect(extractFacts(text, H, null)).toMatchObject({ amount: "0", amountIssue: issue }),
  );

  // W-T13-R2 (a): a sign or a bracket before the figure makes the total unreadable, never its absolute value.
  it.each([
    ["a minus", "Total -100 USDC"],
    ["a minus sign (U+2212)", "Total: \u2212100 USDC"],
    ["an accounting bracket", "Total (100) USDC"],
    ["a square bracket", "Total [100] USDC"],
    ["a minus before the dollar sign", "Total -$100"],
    ["a minus after the dollar sign", "Total $-100"],
    ["a minus after the currency code", "Total USD -100"],
    ["a spaced minus", "Total - 100 USDC"],
    ["a spaced en dash", "Total \u2013 100 USDC"],
    ["a plus", "Total +100 USDC"],
    ["a trailing minus", "Total 100- USDC"],
    ["a bracket on the next line", "Total\n(100)"],
    ["a credit beside a positive total", "Total -100 USDC\nAmount due 100 USDC"],
  ])("refuses a total with %s", (_why, text) =>
    expect(extractFacts(text, H, null)).toMatchObject({ amount: "0", amountIssue: "unreadable" }),
  );

  // W-T13-R2 (b): every final label followed by a figure is collected, so one the code cannot read is never
  // dropped while another total is paid.
  it.each([
    ["a European figure", "Total 1.250,50"],
    ["a European figure beside a readable total", "Total 1.250,50\nTotal due 100 USDC"],
    ["Arabic-Indic digits", "Total \u0661\u0660\u0660 USDC\nTotal due 100 USDC"],
    ["Extended Arabic-Indic digits", "Total \u06f1\u06f0\u06f0"],
    ["Devanagari digits", "Total \u0967\u0966\u0966 USDC"],
    ["a superscript digit after the figure", "Total 100\u00b2 USDC"],
    ["superscript digits", "Total \u00b9\u2070\u2070 USDC"],
    ["a Cyrillic look-alike label", "\u0422otal 9,999 USDC\nTotal 100 USDC"],
    ["a Cyrillic look-alike label alone", "\u0422otal 100 USDC"],
    ["a Greek look-alike label", "\u03a4otal 100 USDC"],
    ["a Cherokee look-alike label", "\u13a2\u13eb\u13a2\u13aa\u13de 100 USDC"],
    ["a label split by a zero-width space", "To\u200btal 9,999 USDC\nTotal 100 USDC"],
    ["a label split by a soft hyphen", "To\u00adtal 100 USDC"],
    ["a label split by a combining grapheme joiner", "Tot\u034fal 100 USDC"],
    ["a label with a combining mark", "To\u0336tal 100 USDC"],
    ["a label with an accent", "Tot\u00e1l 100 USDC"],
    ["a letter-spaced label", "T o t a l 9,999 USDC\nTotal 100 USDC"],
    ["a label with the digit one for l", "Tota1 9,999 USDC\nTotal 100 USDC"],
    ["a label with the digit zero for o", "T0tal 9,999 USDC\nTotal 100 USDC"],
    ["a label with rn for m", "Arnount due 9,999 USDC\nTotal 100 USDC"],
    ["a word of mixed scripts before a figure", "T\u101dtal 9,999 USDC\nTotal 100 USDC"],
    ["a word after the label", "Total payable: 9,999 USDC\nTotal 100 USDC"],
    ["a plural label", "Totals: 9,999 USDC\nTotal 100 USDC"],
    ["a label inside a longer word", "Grandtotal 9,999 USDC\nTotal 100 USDC"],
    ["a figure past the separator bound", `Total${" ".repeat(45)}9,999\nTotal due 100 USDC`],
    ["a zero-width space inside the figure", "Total 1\u200b000 USDC"],
    ["a bidi override on the line", "\u202eTotal 100 USDC"],
    ["a figure on the next line with more after it", "Item Total\n2 Design hours 100.00"],
    ["a figure and currency on the next line with more after them", "Total\n100 USDC for design"],
    ["a sign after a currency code, on the next line", "Total USD\n-100"],
    ["other digits after a currency code, on the next line", "Total USD\n\u0661\u0660\u0660"],
    ["a figure whose next line starts with a digit", "Total 100\n2. Payment terms"],
    ["a total written in words", "Total: nine thousand USDC\nTotal 100 USDC"],
  ])("refuses %s", (_why, text) =>
    expect(extractFacts(text, H, null)).toMatchObject({ amount: "0", amountIssue: "unreadable" }),
  );

  // W-T13-R2 (c): the figure must end cleanly, so other grouping separators, dates, ranges and percents are
  // refused rather than cut to their first group.
  it.each([
    ["a date", "Total 2026-12-01"],
    ["a percent", "Total 20%"],
    ["a percent after a space", "Total 20 %"],
    ["a per-mille sign", "Total 20\u2030"],
    ["a range", "Total 100-200 USDC"],
    ["a range with an en dash", "Total 100\u2013200 USDC"],
    ["a rate", "Total 100/month"],
    ["a time", "Total 10:30"],
    ["a figure space (U+2007)", "Total 1\u2007000 USDC"],
    ["a punctuation space (U+2008)", "Total 1\u2008000 USDC"],
    ["a hair space (U+200A)", "Total 1\u200a000 USDC"],
    ["an ideographic space (U+3000)", "Total 1\u3000000 USDC"],
    ["an en space (U+2002)", "Total 1\u2002000 USDC"],
    ["an apostrophe", "Total 1'000 USDC"],
    ["a typographic apostrophe", "Total 1\u2019000 USDC"],
    ["an underscore", "Total 1_000 USDC"],
    ["a middle dot", "Total 1\u00b7000 USDC"],
    ["a double space", "Total 1  000 USDC"],
    ["a 4-digit group", "Total 1,0000 USDC"],
    ["a multiplier letter", "Total 100k USDC"],
    ["an exponent", "Total 1e6 USDC"],
    ["a figure followed by another number", "Total 100 USDC 200 USDC"],
    ["a comma and a space inside the figure", "Total 1, 000 USDC"],
    ["a credit mark after the currency", "Total 100 USDC CR"],
  ])("refuses %s", (_why, text) =>
    expect(extractFacts(text, H, null)).toMatchObject({ amount: "0", amountIssue: "unreadable" }),
  );

  // W-T13-R2 (d): a dot followed by exactly three digits, with no other separator, may be a thousands group.
  it.each([["Total 10.000"], ["Total 1.000 USDC"], ["Amount due $250.000"]])(
    "refuses %j, which may mean thousands",
    (text) =>
      expect(extractFacts(text, H, null)).toMatchObject({
        amount: "0",
        amountIssue: "unreadable",
      }),
  );

  // W-T13-R2 (e): a zero total is refused with its own reason.
  it.each([["Total 0 USDC"], ["Total: $0.00"], ["Amount due 0.000000"]])(
    "says why %j is not paid",
    (text) =>
      expect(extractFacts(text, H, null)).toMatchObject({ amount: "0", amountIssue: "zero" }),
  );

  it("does not let an exclusion word on the line above hide a total", () => {
    expect(
      extractFacts("Notes: see sub\nTotal due 9,999 USDC\nTotal 100 USDC", H, null),
    ).toMatchObject({ amount: "0", amountIssue: "ambiguous" });
  });

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
