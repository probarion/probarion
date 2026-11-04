import { describe, expect, it } from "vitest";
import { MAX_READ_UNITS, NOT_AN_INVOICE, readAmount } from "./amount";
import { extractFacts } from "./facts";

// The invoice amount reader, rule by rule, through the public extractFacts. It pays only a total written in the
// closed final grammar; everything else is "0" with a reason.

const H = "c".repeat(64);
const read = (text: string) => {
  const f = extractFacts(text, H, null);
  return { amount: f.amount, issue: f.amountIssue };
};
const pays = (amount: string) => ({ amount, issue: null });
/**
 * The positive cases test the grammar of an invoice, so a text with no invoice title gets one ("INVOICE" on its own
 * first line); the title gate has its own tests.
 */
const readInvoice = (text: string) =>
  read(readAmount(text).why === NOT_AN_INVOICE ? `INVOICE\n${text}` : text);
const no = (issue: string) => ({ amount: "0", issue });
/** Eight header lines that read, so a line after them is read as a body line. */
const HEADER =
  "INVOICE INV-1\nAcme Design LLC\n1 Main St\nSpringfield\nDate: 2026-11-01\nDue date: 2026-12-01\nBill to: Beta\nTerms: Net 30\n";

describe("gate: text the reader cannot trust", () => {
  it.each([
    ["a NUL inside the figure", "Total 2\u00005 USDC"],
    ["a NUL in a label", "To\u0000tal 9,999 USDC\nTotal 5 USDC"],
    ["a bell", "Total 5 USDC\u0007"],
    ["a backspace in a label", "Total\u0008 9,999 USDC\nTotal 5 USDC"],
    ["an escape", "\u001b[0mTotal 5 USDC"],
    ["a delete", "To\u007ftal 9,999 USDC\nTotal 5 USDC"],
    ["a C1 control", "To\u009btal 9,999 USDC\nTotal 5 USDC"],
    ["a replacement character", "Total 2\ufffd5 USDC"],
    ["an Arabic letter mark", "Total 5 USDC\u061c"],
    ["a left-to-right mark", "\u200eTotal 5 USDC"],
    ["a right-to-left mark", "\u200fTotal 5 USDC"],
    ["a left-to-right embedding", "\u202aTotal 5 USDC"],
    ["a right-to-left embedding", "\u202bTotal 5 USDC"],
    ["a pop directional formatting", "Total 5 USDC\u202c"],
    ["a left-to-right override", "\u202dTotal 5 USDC"],
    ["a right-to-left override, even a line away", "\u202e\nTotal 19 USDC"],
    ["a left-to-right isolate", "\u2066Total 5 USDC"],
    ["a right-to-left isolate", "\u2067Total 5 USDC"],
    ["a first-strong isolate", "\u2068Total 5 USDC"],
    ["a pop directional isolate", "Total 5 USDC\u2069"],
  ])("refuses %s", (_why, text) => expect(read(text)).toEqual(no("unreadable")));

  it.each([
    ["CRLF", "Invoice INV-1\r\nTotal 5 USDC\r\n"],
    ["a lone CR", "Invoice INV-1\rTotal 5 USDC"],
    ["a vertical tab", "Invoice INV-1\u000bTotal 5 USDC"],
    ["a form feed", "Invoice INV-1\fTotal 5 USDC"],
    ["a next-line character", "Invoice INV-1\u0085Total 5 USDC"],
    ["a line separator", "Invoice INV-1\u2028Total 5 USDC"],
    ["a paragraph separator", "Invoice INV-1\u2029Total 5 USDC"],
  ])("reads a line end written as %s", (_why, text) =>
    expect(readInvoice(text)).toEqual(pays("5000000")),
  );
});

describe("gate: a document that is not a payable invoice", () => {
  it.each([
    ["receipt", "Receipt #1234\nTotal $100.00"],
    ["remittance advice", "REMITTANCE ADVICE\nTotal 750.00 USD"],
    ["quotation", "QUOTATION Q-2026-11\nTotal 5,000.00 USDC"],
    ["quote", "Quote Q-12\nTotal 500 USDC"],
    ["estimate", "Estimate E-7\nTotal 500 USDC"],
    ["purchase order", "Purchase order PO-4471\nTotal 500 USDC"],
    ["credit note", "CREDIT NOTE CN-7\nTotal 250.00 USD"],
    ["credit memo", "Credit memo CM-2\nTotal 250.00 USD"],
    ["refund", "REFUND STATEMENT\nRefund amount due 100.00 USDC"],
    ["statement", "Statement\nTotal 500 USDC"],
    ["statement of account", "STATEMENT OF ACCOUNT\nTotal 500.00 USD"],
    ["pro forma", "Pro forma invoice PF-1\nTotal 500 USDC"],
    ["proforma", "PROFORMA INVOICE\nTotal 500 USDC"],
    ["debit note", "Debit note DN-3\nTotal 500 USDC"],
    ["a heading in capitals further down", "Acme Design LLC\nPAYMENT RECEIPT\nTotal $100.00"],
    ["a document type alone on a line", "Acme Design LLC\nQuotation\nTotal 500 USDC"],
    ["a disguised word (Cyrillic e)", "R\u0435ceipt #1234\nTotal $100.00"],
    ["a disguised word (Cyrillic O)", "QU\u041eTATION Q-1\nTotal 500 USDC"],
    ["a disguised word (zero-width space)", "Rec\u200beipt #1234\nTotal $100.00"],
  ])("refuses a %s", (_why, text) => expect(read(text)).toEqual(no("not_payable")));

  it.each([
    ["VOID", "INVOICE INV-90 - VOID\nTotal 800 USDC"],
    ["VOIDED", "Invoice INV-90 VOIDED\nTotal 800 USDC"],
    ["CANCELLED", "Invoice INV-90\nCANCELLED\nTotal 800 USDC"],
    ["CANCELED", "Invoice INV-90\nCANCELED\nTotal 800 USDC"],
    ["a PAID stamp", "Invoice INV-77\n*** PAID ***\nTotal 1,250.00 USD"],
    ["a dated PAID stamp", "Invoice INV-77\nPAID 2026-11-01\nTotal 1,250.00 USD"],
    ["PAID IN FULL", "Invoice INV-77\nTotal 1,250.00 USD\nPaid in full, thank you"],
    ["a Status: Paid line", "INVOICE INV-77\nStatus: PAID\nTotal 1,250.00 USD"],
    ["do not pay", "Invoice INV-90\nDo not pay this invoice.\nTotal 800 USDC"],
    ["SAMPLE", "SAMPLE INVOICE - FOR ILLUSTRATION ONLY\nTotal 9,999.00 USDC"],
    ["SPECIMEN", "Invoice INV-3 SPECIMEN\nTotal 100 USDC"],
    ["this is not an invoice", "Valid for 30 days. This is not an invoice.\nTotal 5,000.00 USDC"],
    ["has been cancelled", "Invoice INV-90\nThis invoice has been cancelled.\nTotal 800 USDC"],
    ["DRAFT", "DRAFT\nInvoice INV-5\nTotal 100 USDC"],
    ["a disguised stamp (Cyrillic O)", "Invoice INV-90 V\u041eID\nTotal 800 USDC"],
    ["a disguised stamp (a zero for O)", "Invoice INV-90 V0ID\nTotal 800 USDC"],
    ["a disguised stamp line (a one for I)", "Invoice INV-90\nPA1D\nTotal 800 USDC"],
    ["invoice is void", "Invoice INV-90\nThis invoice is void.\nTotal 800 USDC"],
    ["invoice is cancelled", "Invoice INV-90\nThis invoice is cancelled\nTotal 800 USDC"],
    ["invoice was paid", "Invoice INV-90\nThis invoice was paid on 2026-11-01\nTotal 800 USDC"],
    ["do not remit", "Invoice INV-90\nDo not remit.\nTotal 800 USDC"],
    ["for your records only", "Invoice INV-90\nFor your records only\nTotal 800 USDC"],
  ])("refuses a document marked %s", (_why, text) => expect(read(text)).toEqual(no("not_payable")));

  it.each([
    ["an amount paid of zero", "Invoice INV-1\nAmount paid $0.00\nTotal: $100.00"],
    ["a cited purchase order", "Invoice INV-1\nPurchase order: PO-1001\nTotal: $100.00"],
    ["a payment line, which is no PAID stamp", "Invoice INV-1\nPaid 40\nBalance due: $100.00"],
    [
      "a purchase order as the first field",
      "Purchase order: PO-1001\nInvoice INV-1\nTotal: $100.00",
    ],
    ["payment terms", "Invoice INV-1\nPayment terms: Net 30\nTotal: $100.00"],
    ["a capital heading that cites a PO", "INVOICE INV-1\nPURCHASE ORDER: PO-1001\nTOTAL: $100.00"],
    [
      "a vendor whose name holds a document word",
      "From: Quote Masters Inc\nInvoice INV-1\nTotal: $100.00",
    ],
  ])("reads an invoice with %s", (_why, text) =>
    expect(readInvoice(text)).toEqual(pays("100000000")),
  );
});

describe("gate: any currency other than US dollars", () => {
  it.each([
    ["an ISO code on another line", "Total 100 USDC\nPrices in EUR"],
    ["an ISO code before the label", "JPY Total 150,000"],
    ["an ISO code in brackets", "Total 2,000,000 (IDR)"],
    ["a Currency: line", "Total 100 USDC\nCurrency: EUR"],
    ["a lower-case Currency: value", "Total 100 USDC\nInvoice currency = eur"],
    ["USDT", "Total 100 USDC\nor 100 USDT"],
    ["DAI", "Total 100 USDC\nAccepted: DAI"],
    ["EURC", "Total 100 USDC\nAccepted: EURC"],
    ["PYUSD", "Total 100 USDC\nAccepted: PYUSD"],
    ["BTC", "Total 100 USDC\nor BTC"],
    ["ETH", "Total 100 USDC\nor ETH"],
    ["NEAR next to a figure", "Total 100 USDC\nor 25 NEAR"],
    ["in NEAR", "Total 100 USDC\nPayable in NEAR"],
    ["NEAR tokens", "Total 100 USDC\nAccepted as NEAR tokens"],
    ["near next to a figure, in lower case", "Total 100 USDC\nor 25 near"],
    ["in near, in lower case", "Total 100 USDC\nPayable in near"],
    ["near tokens, in lower case", "Total 100 USDC\nAccepted as near tokens"],
    ["a euro sign", "€ Total: 1,000.00"],
    ["a pound sign", "Total 100 USDC\n\u00a3 accepted"],
    ["a yen sign", "Total \u00a5100"],
    ["a rupee sign", "Total \u20b9100"],
    ["a cent sign", "Total 50\u00a2"],
    ["a bitcoin sign", "Total \u20bf1"],
    ["C$", "Total C$100"],
    ["A$", "Total A$100"],
    ["NZ$", "Total NZ$100"],
    ["HK$", "Total HK$100"],
    ["S$", "Total S$100"],
    ["R$", "Total R$100"],
    ["MX$", "Total MX$100"],
    ["NT$", "Total NT$100"],
    ["CAD next to a dollar figure", "Total $100 CAD"],
    ["CAD in brackets", "Total $100 (CAD)"],
    ["CAD alone on a line", "Total $100\nCAD"],
    // With no other word in capitals, a word-like code is read as the currency it names.
    ["CAD in a document with no other capitals", "CAD drawings and site plans\nTotal 100 USDC"],
    ["another country's dollar", "Total 100 USDC\nAll prices in Canadian dollars"],
    ["a disguised code (Cyrillic E)", "Total 100 USDC\nCurrency \u0415UR"],
  ])("refuses %s", (_why, text) => expect(read(text)).toEqual(no("currency")));

  it.each(
    [
      "euro",
      "euros",
      "yen",
      "pound",
      "pounds",
      "sterling",
      "rupee",
      "rupees",
      "peso",
      "pesos",
      "baht",
      "dong",
      "won",
      "yuan",
      "renminbi",
      "franc",
      "francs",
      "krona",
      "krone",
      "real",
      "rand",
      "lira",
      "ruble",
      "rouble",
      "dirham",
      "riyal",
      "ringgit",
      "rupiah",
      "shekel",
      "zloty",
      "forint",
    ].map((w) => [w]),
  )("refuses the currency word %s, in any case", (w) => {
    expect(read(`Total 100 USDC\nPrices in ${w}`)).toEqual(no("currency"));
    expect(read(`Total 100 USDC\nPrices in ${w.toUpperCase()}`)).toEqual(no("currency"));
  });

  it.each([
    ["NEAR as the network", "Total 100 USDC\nPaid in native USDC on NEAR"],
    ["a NEAR account", "Total 100 USDC\nPay to acme1.near"],
    ["ALL in a sentence in capitals", "ALL PRICES IN USD\nTotal 100 USDC"],
    // A document written with capital headings: CAD among them is a word, not a currency.
    ["CAD as drawings", "INVOICE INV-1\nCAD drawings and site plans\nTotal 100 USDC"],
    ["US$", "Total US$100"],
    ["a Currency: USD line", "Currency: USD\nTotal 100 USDC"],
  ])("reads %s", (_why, text) => expect(readInvoice(text)).toEqual(pays("100000000")));

  it.each(
    [
      "cents",
      "cent",
      "base units",
      "decimals",
      "wei",
      "lamports",
      "yocto",
      "thousand",
      "thousands",
      "million",
      "millions",
      "billion",
      "billions",
      "k",
      "m",
      "bn",
    ].map((w) => [w]),
  )("refuses the scale word %s on a final line", (w) => {
    expect(read(`Total 100 USDC ${w}`)).toEqual(no("unreadable"));
    expect(read(`Total 100 USDC (incl. ${w})`)).toEqual(no("unreadable"));
  });
});

describe("gate: more than one document", () => {
  it("refuses two different invoice numbers", () => {
    expect(
      read("INVOICE INV-201\nTotal 500 USDC\n\n-----\n\nINVOICE INV-202\nAmount due 500 USDC"),
    ).toEqual(no("ambiguous"));
  });

  it("refuses the same final label twice, even with an equal figure", () => {
    expect(read("Total 500 USDC\nNotes\nTotal 500 USDC")).toEqual(no("ambiguous"));
    expect(read("Total 500 USDC\nTOTAL $500.00")).toEqual(no("ambiguous"));
  });

  it("reads different final labels that agree", () => {
    expect(readInvoice("Total 100 USDC\nAmount due $100.00")).toEqual(pays("100000000"));
  });
});

describe("the final grammar", () => {
  it.each([
    ["Total $1", "1000000"],
    ["Total due $1", "1000000"],
    ["Total amount $1", "1000000"],
    ["Total amount due $1", "1000000"],
    ["Total payable $1", "1000000"],
    ["Amount due $1", "1000000"],
    ["Amount payable $1", "1000000"],
    ["Balance due $1", "1000000"],
    ["Balance remaining $1", "1000000"],
    ["Amount remaining $1", "1000000"],
    ["Total to pay $1", "1000000"],
    ["Please pay $1", "1000000"],
    ["Pay this amount $1", "1000000"],
    ["Amount owing $1", "1000000"],
    ["Total owing $1", "1000000"],
    ["Outstanding balance $1", "1000000"],
    ["Invoice total $1", "1000000"],
    ["Order total $1", "1000000"],
    ["Grand total $1", "1000000"],
    ["Final amount due $1", "1000000"],
    ["TOTAL DUE $1", "1000000"],
  ])("reads the label of %j", (text, amount) => expect(readInvoice(text)).toEqual(pays(amount)));

  it.each([
    ["Total (USD) 1,250.50"],
    ["Total (USDC) 1,250.50"],
    ["Total in USD: 1,250.50"],
    ["Total in USDC 1,250.50"],
    ["Amount Due (USD): $1,250.50"],
  ])("reads the infix of %j", (text) => expect(readInvoice(text)).toEqual(pays("1250500000")));

  it.each([
    ["Total $5"],
    ["Total\t$5"],
    ["Total: $5"],
    ["Total:$5"],
    ["Total = $5"],
    ["Total | $5"],
    ["Total ........ $5"],
    ["Total ........ 5 USDC"],
    ["| Total | $5 |"],
  ])("reads the separator of %j", (text) => expect(readInvoice(text)).toEqual(pays("5000000")));

  it.each([
    ["$F", "Total $1,250.50"],
    ["$ F", "Total $ 1,250.50"],
    ["US$F", "Total US$1,250.50"],
    ["US $F", "Total: US $1,250.50"],
    ["USD F", "Total USD 1,250.50"],
    ["USDC F", "Total USDC 1,250.50"],
    ["F USD", "Total 1,250.50 USD"],
    ["F USDC", "Total 1,250.50 USDC"],
    ["$F USD", "Total $1,250.50 USD"],
    ["$F USDC", "Total $1,250.50 USDC"],
  ])("reads the amount form %s", (_why, text) =>
    expect(readInvoice(text)).toEqual(pays("1250500000")),
  );

  it.each([
    ["no currency marker", "Total 100"],
    ["a count", "Total: 3"],
    ["hours", "Total\t12"],
    ["a minus", "Total -$100"],
    ["a spaced minus", "Total - $100"],
    ["a minus after the dollar", "Total $-100"],
    ["an en dash", "Total \u2013 $100"],
    ["a bracket", "Total ($100)"],
    ["a plus", "Total +$100"],
    ["text before the label", "See page 2 Total $100"],
    ["a qualifier before the label", "Estimated total $100"],
    ["a prefix outside the list", "Project total $100"],
    ["an infix outside the list", "Total in dollars $100"],
    ["a dot touching the figure", "Total .50 USDC"],
  ])("refuses a final line with %s", (_why, text) => expect(read(text)).toEqual(no("unreadable")));

  it.each([
    ["plain digits", "Total 1250 USDC", "1250000000"],
    ["US grouping", "Total 1,250,000 USDC", "1250000000000"],
    ["one decimal", "Total 1.5 USDC", "1500000"],
    ["six decimals", "Total 1.123456 USDC", "1123456"],
    ["three decimals with grouping", "Total 1,000.500 USDC", "1000500000"],
    ["the largest total", "Total 1,000,000,000,000 USDC", "1000000000000000000"],
    ["zero point something", "Total 0.50 USDC", "500000"],
  ])("reads a figure in %s", (_why, text, amount) =>
    expect(readInvoice(text)).toEqual(pays(amount)),
  );

  it.each([
    ["seven decimals", "Total 1.1234567 USDC"],
    ["a dot and three digits (may be thousands)", "Total 10.000 USDC"],
    ["one dot and three digits", "Total 1.000 USDC"],
    ["a leading zero", "Total 0100 USDC"],
    ["more than 10^12 USDC", "Total 1,000,000,000,001 USDC"],
    ["a European figure", "Total 1.250,50 USDC"],
    ["a comma at the end of the line", "Total: $1,\n250.00"],
    ["letters for zeros", "Total: $1,OOO.OO"],
    ["a 4-digit group", "Total 1,0000 USDC"],
    ["a figure space", "Total 1\u2007000 USDC"],
    ["an apostrophe", "Total 1'000 USDC"],
    ["Arabic-Indic digits", "Total \u0661\u0660\u0660 USDC"],
    ["a superscript after the figure", "Total 100\u00b2 USDC"],
  ])("refuses a figure with %s", (_why, text) => expect(read(text)).toEqual(no("unreadable")));

  it.each([
    ["a full stop after the code", "Total 100 USDC."],
    ["a comma after the code", "Total 100 USDC,"],
    ["a semicolon after the code", "Total 100 USDC;"],
    ["(incl. VAT)", "Total 100 USDC (incl. VAT)"],
    ["(including tax)", "Total $100 (including tax)"],
    ["(incl. GST)", "Total $100 (incl. GST)"],
    ["(incl. sales tax)", "Total $100 (incl. sales tax)"],
    ["(net 30)", "Total $100 (net 30)"],
    ["thank you", "Total $100 thank you"],
    [", thank you", "Total 100 USDC, thank you"],
  ])("reads the tail %s", (_why, text) => expect(readInvoice(text)).toEqual(pays("100000000")));

  it.each([
    ["a full stop right after the figure", "Total $100."],
    ["a date", "Total 100 USDC on 2026-10-30"],
    ["a status", "Total 100 USDC refunded"],
    ["a conversion", "Total 100 USDC (approx. 92)"],
    ["a rate", "Total 100 USDC / month"],
    ["a second amount", "Total 100 USDC 200 USDC"],
    ["a figure in words", "Total 100 USDC (nine thousand USDC)"],
    ["a percent", "Total 100 USDC 20%"],
    ["an (incl.) clause with a figure", "Total 100 USDC (incl. 20% VAT)"],
    ["an (incl.) clause naming a status", "Invoice INV-1\nTotal 100 USDC (incl. paid)"],
  ])("refuses a tail with %s", (_why, text) => expect(read(text)).toEqual(no("unreadable")));

  it.each([
    ["a label alone", "Total\n$100.00"],
    ["a label and its figure in a column block", "Subtotal\nTax\nTotal\n$90.00\n$10.00\n$100.00"],
    ["a label whose figure is on the next line behind a word", "Amount due\ntoday 5,000.00 USDC"],
    ["a figure 41 lines below", `Total${"\n".repeat(41)}9,999 USDC\nAmount due 5 USDC`],
    ["a label in prose", "Invoice INV-1\nTotal due upon receipt\nAmount due 5 USDC"],
    ["a verb label before a figure line", "Please pay\n$100.00"],
  ])("refuses %s", (_why, text) => expect(read(text)).toEqual(no("unreadable")));

  it.each([
    [
      "Item Qty Price Total",
      "Item Qty Price Total\nLogo design 1 700.00 700.00\nTotal 700.00 USDC",
    ],
    [
      "a tab header with a number column",
      "#\tItem\tQty\tPrice\tTotal\n1\tLogo\t1\t700.00\t700.00\nTotal\t700.00 USDC",
    ],
    [
      "a header starting with Date",
      "Date\tDescription\tHours\tTotal\n2026-11-02\tDesign\t4\t700.00\nTotal\t700.00 USDC",
    ],
  ])("reads past a table header (%s)", (_why, text) =>
    expect(readInvoice(text)).toEqual(pays("700000000")),
  );

  it("refuses a two-word header, where Total is a label without its figure", () => {
    expect(read("Description\tTotal (USD)\nDesign\t400.00\nTotal\t400.00 USDC")).toEqual(
      no("unreadable"),
    );
  });

  it("reads a verb label used as prose (a payment instruction)", () => {
    expect(readInvoice("Total $100.00\nPlease pay within 30 days")).toEqual(pays("100000000"));
  });

  it.each([
    ["Balance", "Balance\n$500.00\nTotal $100.00"],
    ["Amount", "Amount\n$500\nTotal $100.00"],
    ["a verb label in prose", "Please pay today\n$500.00\nTotal $100.00"],
  ])("refuses a value written under its label in a column (%s)", (_why, text) =>
    expect(read(text)).toEqual(no("unreadable")),
  );

  it.each([
    ["Sub total"],
    ["Tax total and VAT are shown below"],
    ["Contract total: see the contract"],
    ["Page total carried to the next page"],
  ])("reads past a partial label without its figure (%j)", (line) =>
    expect(readInvoice(`${line}\nTotal $100.00`)).toEqual(pays("100000000")),
  );
});

describe("every other line that looks payable", () => {
  it.each([
    ["Subtotal: $90.00"],
    ["Sub-total $90.00"],
    ["Sub total 90.00"],
    ["Tax: $10.00"],
    ["Tax (10%): $10.00"],
    ["VAT 20% 10.00 USD"],
    ["GST @ 10% $10.00"],
    ["Sales tax 8.25% $10.00"],
    ["Tax total 10.00"],
    ["Total tax $10.00"],
    ["Total VAT $10.00"],
    ["Net total $90.00"],
    ["Net amount $90.00"],
    ["Discount -$5.00"],
    ["Shipping $5.00"],
    ["Handling $0.00"],
    ["Fee $1.00"],
    ["Fees $1.00"],
    ["Amount paid $0.00"],
    ["Previous balance $0.00"],
    ["Page total $90.00"],
    ["Year-to-date total $900.00"],
    ["Contract total $9,000.00"],
  ])("ignores the non-final line %j", (line) =>
    expect(readInvoice(`${line}\nTotal $100.00`)).toEqual(pays("100000000")),
  );

  // A payment, deposit or credit the invoice deducts: the Total is before it, so only a balance-type label
  // (Balance due, Amount due, Amount remaining, ...) states what is left to pay.
  it.each([
    ["Deposit paid $40.00"],
    ["Deposit $40.00"],
    ["Deposit received 40.00 USDC"],
    ["Amount paid ($40.00)"],
    ["Paid to date $40.00"],
    ["Payment $40.00"],
    ["Payments $40.00"],
    ["Payment received 40.00 USDC"],
    ["Credit applied $5.00"],
    ["Credits applied $5.00"],
    ["Less deposit -$40.00"],
    ["Previous balance $500.00"],
  ])("reads the balance after the deduction %j", (line) => {
    expect(readInvoice(`Subtotal $140.00\n${line}\nBalance due $100.00`)).toEqual(
      pays("100000000"),
    );
    expect(readInvoice(`Subtotal $140.00\n${line}\nAmount due: 100 USDC`)).toEqual(
      pays("100000000"),
    );
  });

  it.each([
    ["an amount paid", "Total $1,000.00\nAmount paid $400.00"],
    ["a deposit", "Grand total 1,000.00 USDC\nDeposit paid 300.00 USDC"],
    ["a payment received", "Invoice total $1,000.00\nPayment received $1.00"],
    ["a previous balance", "Total $100.00\nPrevious balance $500.00"],
    ["a credit", "Total amount $1,000.00\nCredit applied $50.00"],
    // An installment is a part of the contract total: a plain Total after it is not what is due now.
    ["an installment", "Total $100.00\nInstallment 3 of 9 $11.11"],
  ])("refuses a total that comes before %s, with no balance stated", (_why, text) =>
    expect(read(text)).toEqual(no("ambiguous")),
  );

  it.each([
    ["a refund qualifier", "Refund amount due 100.00 USDC"],
    ["an estimate qualifier", "Estimated total 5,000 USDC"],
    ["an hours total", "Hours total: 40"],
    ["a credit balance", "Credit balance due 250.00 USD"],
    ["an installment due", "Installment amount due 3,000.00 USDC"],
    ["a balance with no label of its own", "BALANCE: $500.00"],
    ["a total of a quoted e-mail", "> Total 500 USDC"],
    ["an amount in words", "Amount in words: USD Nine Thousand Only"],
    ["a payee line with an amount", "Pay to acme.near 100 USDC"],
  ])("refuses %s", (_why, line) =>
    // Below an eight-line header: in the header, a type word beside an amount ("Refund amount due") is a title
    // and is refused as not payable before the line is read.
    expect(read(`${HEADER}${line}\nTotal $100.00`)).toEqual(no("unreadable")),
  );

  it("refuses a first line that names a refund as not payable, before reading it", () => {
    expect(read("Refund amount due 100.00 USDC\nTotal $100.00")).toEqual(no("not_payable"));
  });

  it.each([
    ["\u00f8", "T\u00f8tal"],
    ["\u0142", "Tota\u0142"],
    ["\u0166", "\u0166otal"],
    ["small capitals", "\u1d1b\u1d0f\u1d1b\u1d00\u029f"],
    ["a dagger", "\u2020otal"],
    ["a white circle", "T\u25cbtal"],
    ["a Devanagari zero", "T\u0966tal"],
    ["a Thai zero", "T\u0e50tal"],
    ["an Arabic-Indic one", "Tota\u0661"],
    ["an Adlam digit", "T\u{1E950}tal"],
    ["a Myanmar letter", "T\u101dtal"],
    ["the digit zero", "T0tal"],
    ["the digit one", "Tota1"],
    ["a capital I", "TotaI"],
    ["a bar", "Tota|"],
    ["a Devanagari zero in Amount", "Am\u0966unt due"],
    ["a Cyrillic a in Balance", "B\u0430lance due"],
  ])("refuses a look-alike label (%s)", (_why, label) => {
    expect(read(`${label} 9,999 USDC\nTotal 5 USDC`)).toEqual(no("unreadable"));
    // Glued to its separator and figure, too.
    expect(read(`${label}:$9,999.00\nTotal 5 USDC`)).toEqual(no("unreadable"));
  });

  it("refuses a look-alike symbol that is not in the fold table", () => {
    expect(read("T\u25catal: $9,999.00\nTotal 5 USDC")).toEqual(no("unreadable"));
  });

  it.each([
    ["a CJK vendor name with a year", "Vendor: \u682a\u5f0f\u4f1a\u793eABC 2026"],
    ["a Cyrillic city", "Bill to: \u041c\u043e\u0441\u043a\u0432\u0430 5"],
    ["an accented name", "Bill to: Ac\u00e9me S.A. 5"],
    ["a line item", "Logo design $700.00"],
    ["a due date", "Due date: 2026-12-01"],
    ["a due date in words", "Due: Dec 1, 2026"],
    ["a payment term", "Payment due within 30 days"],
    ["net terms", "Terms: Net 30"],
    ["a payee account", "Pay to acme-design.near"],
    ["a payee address", "Pay to 0x52908400098527886E0F7030069857D2E4169EE7"],
    ["a remittance address", "Remit to: Acme LLC, 123 Main St, Springfield 62701"],
    ["a late fee note", "Late payments incur a 1.5% monthly fee."],
    ["an invoice number", "Invoice # INV-2026-07"],
    ["a PO reference", "PO: PO-4471"],
  ])("reads past %s", (_why, line) =>
    expect(readInvoice(`${line}\nTotal $100.00`)).toEqual(pays("100000000")),
  );
});

describe("agreement and the result", () => {
  it("refuses final totals that disagree", () => {
    expect(
      read("Total 10,000.00 USD\nDeposit paid 5,000.00 USD\nBalance remaining 5,000.00 USD"),
    ).toEqual(no("ambiguous"));
  });

  it("says why a zero total is not paid", () => {
    expect(read("Total $0.00")).toEqual(no("zero"));
    expect(read("Amount due 0 USDC")).toEqual(no("zero"));
  });

  it("finds nothing in a text without a total", () => {
    expect(read("Logo design $700.00\nThank you")).toEqual(no("not_found"));
  });

  it("returns the amount as a canonical integer string of base units", () => {
    expect(read("Total 007.50 USDC")).toEqual(no("unreadable"));
    expect(readInvoice("Total 7.50 USDC").amount).toBe("7500000");
  });

  it("reads nothing from a text cut short", () => {
    const f = extractFacts("Total 25 USDC", H, null, { truncated: true });
    expect(f).toMatchObject({ amount: "0", amountIssue: "truncated" });
  });
});

describe("robustness", () => {
  it("does not throw, whatever the text", () => {
    for (const text of [
      "",
      "\ud800",
      "Total $1\udfff",
      `Total ${"\ud83d".repeat(1000)}`,
      "\u0000".repeat(10),
      "\ufdfa".repeat(20_000),
      `€${"a".repeat(MAX_READ_UNITS + 1)}`,
      "Total $1\n".repeat(10_000),
    ]) {
      expect(() => readAmount(text)).not.toThrow();
      expect(readAmount(text).amount).toBe("0");
    }
  });

  it("refuses a text past the read cap before it normalises any of it", () => {
    const t0 = performance.now();
    expect(readAmount(`€${"a".repeat(4 * 1024 * 1024 - 1)}`)).toEqual(no("unreadable"));
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("refuses a text that NFKC expands past the read cap", () => {
    expect(readAmount("\ufdfa".repeat(12_000))).toEqual(no("unreadable"));
  });
});

describe("money lines outside the grammar", () => {
  const BODY = "INVOICE INV-1001\nDesign work $1,000.00\nTotal $1,000.00\n";
  it.each([
    ["a payment in prose", "Payment of $400.00 received on 2026-10-01, thank you."],
    ["a deposit with a date", "Deposit paid $400.00 on 2026-10-01"],
    ["a deposit after a colon", "Less: Deposit $400.00"],
    ["withholding", "Withholding tax -$100.00"],
    ["a refund", "Refunded $400.00"],
    ["a gift card", "Gift card: -$400.00"],
    ["a late fee", "Late fee $50.00"],
    ["what is owed", "You owe: $5.00"],
    ["what remains", "Remaining: $5.00"],
    ["a short balance", "Bal: $5.00"],
    ["a retainer credit after the total", "Retainer $400.00"],
  ])("refuses %s", (_why, line) => expect(read(BODY + line).amount).toBe("0"));

  it("refuses a plain Total before a payment line written as Paid", () => {
    expect(read(`${BODY}Paid $400.00`)).toEqual(no("ambiguous"));
  });

  it("reads a retainer charged as a line item before the total", () => {
    expect(
      readInvoice("INVOICE INV-1\nMonthly retainer, November 2026\t$3,000.00\nTotal\t$3,000.00"),
    ).toEqual(pays("3000000000"));
  });

  it("refuses the plural and stem forms inside (incl. ...)", () => {
    for (const w of [
      "deposits",
      "payments received",
      "credits",
      "refunds",
      "prior payments",
      "hundred",
    ]) {
      expect(read(`Total $1,000.00 (incl. ${w})`)).toEqual(no("unreadable"));
    }
  });
});

describe("a deduction settles only with a balance written after it", () => {
  it.each([
    [
      "Amount due before payments",
      "INVOICE INV-1\nAmount due $1,000.00\nPayments received $400.00",
    ],
    ["Total due before a deposit", "INVOICE INV-1\nTotal due $10,000.00\nDeposit (50%) $5,000.00"],
    [
      "a total before a deposit, then a balance",
      "Logo $1,000.00\nTotal: $1,000.00\nDeposit paid: $400.00\nBalance due: $1,000.00",
    ],
    [
      "an installment, then a plain Total",
      "INVOICE INV-1\nInstallment 2 of 3: $300.00\nTotal $900.00",
    ],
  ])("refuses %s", (_why, text) => expect(read(text)).toEqual(no("ambiguous")));

  it.each([
    [
      "a balance after a payment",
      "INVOICE INV-1\nSubtotal $1,000.00\nAmount paid $400.00\nBalance due $600.00",
      "600000000",
    ],
    [
      "the amount due after an installment",
      "Contract total $900.00\nInstallment 2 of 3 $300.00\nAmount due $300.00",
      "300000000",
    ],
  ])("reads %s", (_why, text, amount) => expect(readInvoice(text)).toEqual(pays(amount)));
});

describe("notes and figures around a total", () => {
  it.each([
    [
      "base units on the next line",
      "INVOICE INV-1001\nAmount due: 2,500,000 USDC\n(USDC base units, 6 decimals)",
    ],
    [
      "cents on the next line",
      "INVOICE INV-1001\nTotal: $250,000\nNote: all amounts are in cents.",
    ],
    [
      "thousands in brackets anywhere",
      "(figures in thousands)\nINVOICE INV-1001\nLogo $1.25\nX\nY\nTotal $1,250",
    ],
    ["a per-unit note", "Total: 770 USDC\nper seat x 20 seats"],
    ["a figure continued after a comma", "INVOICE INV-1\nAmount due: $12\n,500.00"],
    ["a figure continued after a decimal point", "INVOICE INV-1\nTotal $1,250\n.50"],
    ["a bare figure below a total", "Total: $770.00\n$9,999.00"],
    ["a decorated value under its label", "Total: $5.00\nBalance\n$9,999.00*"],
    ["a value two lines under its label", "Total: $5.00\nBalance:\nUSD\n9,999.00"],
    [
      "a row of sums under a summary header",
      "Subtotal\tTax\tTotal\n$4.50\t$0.50\t$5.00\nAmount due: $9,999.00",
    ],
  ])("refuses %s", (_why, text) => expect(read(text)).toEqual(no("unreadable")));

  it("reads an item table whose header has an item column and one Total", () => {
    expect(readInvoice("Item Qty Price Total\nLogo 1 $700.00 $700.00\nTotal: $700.00")).toEqual(
      pays("700000000"),
    );
  });
});

describe("a status or document type anywhere it is written", () => {
  const BODY = "Logo design $700.00\nSubtotal $700.00\nTax $70.00\nTotal: $770.00";
  it.each([
    ["paid by", `INVOICE INV-1001\n${BODY}\nPaid by bank transfer on 2026-11-03. Thank you!`],
    ["payment received", `INVOICE INV-1001\n${BODY}\nPAYMENT RECEIVED`],
    ["settled", `INVOICE INV-1001\n${BODY}\nThis invoice was settled on 2026-10-30.`],
    ["a letter-spaced stamp", `INVOICE INV-1001\n${BODY}\nP A I D`],
    ["a stamp behind a dash", `INVOICE INV-90 - Void\n${BODY}`],
    ["a status in a table", `Invoice INV-90\n${BODY}\n| Status | Paid |`],
    ["a status behind an en dash", `Invoice INV-90\n${BODY}\nStatus \u2013 Paid`],
    ["thank you for your payment", `Invoice INV-90\n${BODY}\nThank you for your payment!`],
    ["a receipt on the second line", `Acme Design LLC\nSales Receipt\n${BODY}`],
    ["a quote heading", `Acme Design LLC\nPrice Quote\n${BODY}`],
    ["a purchase order heading", `Acme Design LLC\nPurchase Order\n${BODY}`],
    ["a statement", `Acme Design LLC\nCustomer statement\n${BODY}`],
    ["a pro forma", `Jane Doe Design\nPro Forma Invoice\n${BODY}`],
    ["a letter-spaced title", `R E C E I P T\n${BODY}`],
    ["a digit in the title", `RECE1PT\n${BODY}`],
    ["a Markdown title", `Acme\n# Receipt\n${BODY}`],
    ["a credit note for an invoice", `Acme Design LLC\nCredit Note for invoice INV-1\n${BODY}`],
    ["a title split over two lines", `CREDIT\nNOTE\n${BODY}`],
    ["a stamp with a zero-width space", `INVOICE INV-90 - V\u200bOID\n${BODY}`],
    ["a stamp with a Cyrillic I", `INVOICE INV-90 - VO\u0406D\n${BODY}`],
    ["a stamp with a dotted I", `INVOICE INV-90 - VO\u0130D\n${BODY}`],
  ])("refuses %s as not payable", (_why, text) => expect(read(text)).toEqual(no("not_payable")));

  it.each([
    ["a cited purchase order", `Acme Design LLC\nINVOICE\nPurchase order: PO-1001\n${BODY}`],
    [
      "a cited purchase order with no colon, below the title",
      `INVOICE\nPurchase order PO-1001\n${BODY}`,
    ],
    ["a payment term upon receipt", `INVOICE\nPayment due upon receipt\n${BODY}`],
    ["a vendor name field", `From: Quote Masters Inc\nINVOICE\n${BODY}`],
    ["an amount paid of zero", `INVOICE INV-90\n${BODY}\nAMOUNT PAID $0.00`],
    ["a payment instruction", `INVOICE\n${BODY}\nTo be paid by bank transfer.`],
  ])("reads an invoice with %s", (_why, text) =>
    expect(readInvoice(text)).toEqual(pays("770000000")),
  );
});

describe("another currency in every form", () => {
  const BODY = "Invoice INV-90\nLogo design $700.00\nTotal: $770.00\n";
  it.each([
    ["a word-like code after a tab", "Currency\tCAD"],
    ["a word-like code after a dash", "Currency - TRY"],
    ["a word-like code in a currency field", "Currency code: CAD"],
    ["a word-like code beside a currency word", "All prices CAD"],
    ["a dollar sign before a code", "Prices are in $CAD"],
    ["a code glued to a figure", "Hourly rate EUR70"],
    ["a figure glued to a code", "Hourly rate 100GBP"],
    ["a title-case code", "Prices in Eur"],
    ["a lower-case code", "Logo design 700 eur"],
    ["a sign that NFKC turns into letters", "All amounts in \u20a8"],
    ["a CJK yen sign", "Amounts in \u5186"],
    ["a Hangul won sign", "Amounts in \uc6d0"],
    ["another dollar written with a space", "Prices in C $"],
    ["another dollar by its country", "Prices in Canadian $"],
    ["another country's funds", "Amounts in Canadian funds"],
    ["a nickname", "Payable in loonies"],
    ["an abbreviation", "Amounts in Rs."],
    ["a code with a zero-width space", "All amounts in E\u200bUR"],
    ["a code with a Cyrillic I", "All amounts in \u0406NR"],
    ["a dollar with a Cyrillic letter", "Prices in \u0421$"],
  ])("refuses %s", (_why, line) => expect(read(BODY + line)).toEqual(no("currency")));

  it.each([
    ["USDC on NEAR as the network", "Pay with USDC on NEAR to kai.near"],
    ["USDC (NEAR) as the network", "Payment method: USDC (NEAR)"],
  ])("reads %s", (_why, line) => expect(readInvoice(BODY + line)).toEqual(pays("770000000")));

  it("reads CAD as drawings in a document written with capital headings, and as a currency in one without", () => {
    const text = "Logo design $700.00\nTotal: $770.00\nCAD drawings and site plans";
    expect(readInvoice(`INVOICE INV-90\n${text}`)).toEqual(pays("770000000"));
    expect(read(`Invoice INV-90\n${text}`)).toEqual(no("currency"));
  });
});

describe("labels written to hide", () => {
  it.each([
    ["letter-spaced", "T o t a l 9,999 USDC\nTotal 5 USDC"],
    ["letter-spaced, the other way round", "Invoice INV-1\nT O T A L   $5.00\nTotal: $9,999.00"],
    ["split by a space", "Invoice INV-1\nLogo $9,999.00\nTo tal $9,999.00\nAmount due: $5.00"],
    ["split by a hyphen", "To-tal: $9,999.00\nAmount due: $5.00"],
    ["split by dots", "T.o.t.a.l 9,999 USDC\nTotal 5 USDC"],
    ["split across a line end", "Tot-\nal 9,999 USDC\nTotal 5 USDC"],
    ["split across a vertical tab", "To\u000btal 9,999 USDC\nTotal 5 USDC"],
    ["rn for m", "Arnount: 9,999 USDC\nTotal 5 USDC"],
    [
      "look-alikes with one letter outside the table",
      "\u0422\u043et\u0430\u16c1 9,999 USDC\nTotal 5 USDC",
    ],
    ["a capital outside the table", "\u0422\u041e\u0422\u0410\u0141 9,999 USDC\nTotal 5 USDC"],
    ["a payee line with a second column", "Total: $5.00\nPayable to: ACME LLC\tAmount: 9999"],
    ["a payee line with dollars", "Total: $5.00\nPay to ACME 9999 dollars"],
    ["an amount behind net terms", "Invoice INV-1\nTotal: $9,999.00\nBalance net 5 USDC"],
    [
      "an amount behind a word that starts like a month",
      "Logo $5.00\nTotal: $5.00\nAmount: Marketing 2500 USDC",
    ],
  ])("refuses a label %s", (_why, text) => expect(read(text)).toEqual(no("unreadable")));
});

describe("two documents in one text", () => {
  it.each([
    ["Total and Grand total", "INVOICE INV-1\nTotal 500 USDC\nGrand total 500 USDC"],
    [
      "repeated titles, each with a total",
      "INVOICE\nFrom: Acme\nTotal 500 USDC\n\nINVOICE\nFrom: Beta\nAmount due 500 USDC",
    ],
    [
      "numbers after a colon and a hash",
      "Invoice: #1001\nTotal: $500.00\n-----\nInvoice: #1002\nAmount due: $500.00",
    ],
    ["bill numbers", "Bill #1001\nTotal: $500.00\n-----\nBill #1002\nAmount due: $500.00"],
    [
      "abbreviated numbers",
      "Inv. No. 1001\nTotal: $500.00\n-----\nInv. No. 1002\nAmount due: $500.00",
    ],
    [
      "a number with a zero-width space",
      "Invoice INV-1001\nTotal: $500.00\n-----\nInvoice I\u200bNV-1002\nAmount due: $500.00",
    ],
  ])("refuses %s", (_why, text) => expect(read(text)).toEqual(no("ambiguous")));

  it("reads a two-page invoice that repeats its title and states its total once", () => {
    const page = (lines: string[], n: number) => `${lines.join("\n")}\n-- ${n} of 2 --\n`;
    const text =
      page(
        ["INVOICE", "Invoice # INV-2026-1083", "Sprint 1\t$1,400.00", "Sprint 2\t$1,400.00"],
        1,
      ) +
      page(["INVOICE", "Invoice # INV-2026-1083", "Sprint 3\t$1,400.00", "Total\t$4,200.00"], 2);
    expect(readInvoice(text)).toEqual(pays("4200000000"));
  });
});

describe("safe widenings", () => {
  it.each([
    [
      "an unmarked total that a marked balance corroborates",
      "INVOICE INV-1\nSUBTOTAL\t1,180.00\nTOTAL\t1,277.35\nBALANCE DUE\t$1,277.35",
      "1277350000",
    ],
    ["USD $F", "Total\tUSD $1,277.35", "1277350000"],
    [
      "a due-by headline in a numbered invoice",
      "Invoice number\tA1-0062\n$1,180.00 USD due December 1, 2026\nTotal\t$1,180.00",
      "1180000000",
    ],
    [
      "USDC (NEAR)",
      "INVOICE INV-1\nTotal (USDC)\t1,200.00\nPayment method: USDC (NEAR)",
      "1200000000",
    ],
    [
      "an address on a payable line",
      "Balance Physical Therapy, 220 Oak Street, Denver, CO 80203\nTotal:\t$450.00",
      "450000000",
    ],
    [
      "a dd-Mon-yyyy date",
      "INVOICE INV-1\nDue Date :\t01-Dec-2026\nTotal\t$1,277.35",
      "1277350000",
    ],
    [
      "Total sales tax as a partial",
      "Subtotal\t1,180.00\nTOTAL SALES TAX 8.25%\t97.35\nTOTAL USD\t1,277.35",
      "1277350000",
    ],
    [
      "Total excluding tax as a partial",
      "Total excluding tax\t$1,180.00\nTotal\t$1,277.35",
      "1277350000",
    ],
    ["a (USD) tail", "Invoice Amount\t$1,277.35 (USD)", "1277350000"],
    ["a count line", "Total hours: 40\nAmount due:\t$4,000.00", "4000000000"],
    ["Total for this invoice", "Total for this invoice\tUSD 1,277.35", "1277350000"],
    ["a due-on qualifier", "TOTAL AMOUNT DUE ON December 2, 2026\tUSD 1,277.35", "1277350000"],
    ["an incl. tax qualifier", "Total incl. tax\t$1,277.35", "1277350000"],
    ["an upon-receipt qualifier", "Total due upon receipt:\t$600.00", "600000000"],
    [
      "due diligence and balance sheet as items",
      "Due diligence review\t$2,000.00\nBalance sheet preparation\t$300.00\nTotal\t$2,300.00",
      "2300000000",
    ],
  ])("reads %s", (_why, text, amount) => expect(readInvoice(text)).toEqual(pays(amount)));

  it.each([
    ["an unmarked total alone", "Total 1,277.35"],
    ["an unmarked total that disagrees", "Total 9,999\nTotal $5.00"],
    [
      "a due-by line in a text that states no invoice number",
      "$9,999.00 USD due December 1, 2026\nTotal $5.00",
    ],
    ["a count line with a value under it", "Total hours: 40\n$4,000.00"],
  ])("still refuses %s", (_why, text) => expect(read(text).amount).toBe("0"));
});

describe("the reader's own views", () => {
  it("reads a lone surrogate as U+FFFD, the text the hash and the ledger see, and refuses it", () => {
    expect(readAmount("Acme Design LLC\nInvoice INV-77\nNote \ud800\nTotal: $770.00")).toEqual(
      no("unreadable"),
    );
  });

  it("folds a capital outside the look-alike table through its lower case", () => {
    // U+0196 is a capital iota; only its lower case (U+0269) is in the table, as an l.
    expect(read("INVOICE INV-90 - VO\u0196D\nTotal: $770.00")).toEqual(no("not_payable"));
    expect(read("Total: $770.00\nAll amounts in \u0196NR")).toEqual(no("currency"));
  });

  it("refuses a type written as <type> # below the title lines", () => {
    const head =
      "Acme Design LLC\nINVOICE INV-1\nDate: 2026-11-01\nBill to: Globex\nTerms: Net 30\n";
    expect(read(`${head}Logo $700.00\nPayment Receipt #1234 issued\nTotal: $700.00`)).toEqual(
      no("not_payable"),
    );
    expect(
      read(`${head}Logo $700.00\nCredit Note for invoice INV-1 attached\nTotal: $700.00`),
    ).toEqual(no("not_payable"));
  });

  it('reads a Markdown title below the title lines: "# Receipt 1234"', () => {
    const head =
      "Acme Design LLC\nINVOICE INV-1\nDate: 2026-11-01\nBill to: Globex\nTerms: Net 30\n";
    expect(read(`${head}Logo $700.00\n# Receipt 1234\nTotal: $700.00`)).toEqual(no("not_payable"));
  });

  it("reads a word-like code as a cell of a header row as the currency of that column", () => {
    expect(read("INVOICE INV-1\nItem\tQty\tCAD\nLogo design\t1\t$100.00\nTotal $100.00")).toEqual(
      no("currency"),
    );
  });

  it.each([
    ["two Total columns", "Item\tTotal\tTotal"],
    ["no item or quantity column", "Price\tAmount\tTotal"],
    ["a summary column", "Item\tSubtotal\tTotal"],
  ])("refuses a header row with %s: Total there is a label without its figure", (_why, header) => {
    expect(read(`${header}\nLogo design\t$700.00\t$700.00\nTotal: $700.00`)).toEqual(
      no("unreadable"),
    );
  });

  it("refuses a total that includes a retainer: what it includes is not stated", () => {
    expect(read("Total $1,000.00 (incl. retainer)")).toEqual(no("unreadable"));
  });

  it.each([
    ["Invoice amount", "Deposit paid $400.00\nInvoice amount $1,000.00"],
    ["Total for this invoice", "Deposit paid $400.00\nTotal for this invoice $1,000.00"],
  ])(
    "refuses %s after a deduction: it states the whole invoice, not what is left",
    (_why, text) => {
      expect(read(text)).toEqual(no("ambiguous"));
    },
  );
});

describe("a payable document names itself an invoice", () => {
  it.each([
    ["no title at all", "Acme Design LLC\nLogo design $700.00\nTotal $700.00"],
    [
      "a bill with no invoice title",
      "Ridgeview Water Co-op\nBill date: 10/31/2026\nTotal amount due $73.05",
    ],
    [
      "a reference number instead of a title",
      "Acme Studio LLC\nReference INV-1001\nTotal $1,000.00",
    ],
    [
      "a title after the first eight lines",
      "Acme Design LLC\n1 Main St\nSpringfield\nIL 62701\n(555) 555-0100\nbilling@acme.test\nDate: 2026-11-01\nBill to: Beta\nINVOICE INV-1\nTotal $700.00",
    ],
    [
      "an invoice word only in a sentence",
      "Acme Design LLC\nThank you for your business\nInvoice total $700.00",
    ],
  ])("refuses %s as not payable, and says why", (_why, text) => {
    expect(readAmount(text)).toEqual({ amount: "0", issue: "not_payable", why: NOT_AN_INVOICE });
    expect(read(text)).toEqual(no("not_payable"));
  });

  it.each([
    ["INVOICE"],
    ["Invoice"],
    ["Tax Invoice"],
    ["COMMERCIAL INVOICE"],
    ["Sales invoice"],
    ["Invoice #1001"],
    ["Invoice # 1001"],
    ["Invoice No. 7781"],
    ["Invoice number: 7781"],
    ["Invoice INV-2026-07"],
    ["Invoice 2026-09"],
    ["Invoice: 1001"],
    ["Acme Ltd \u2014 Invoice"],
    ["Acme Ltd | Invoice"],
    ["I N V O I C E"],
    ["**INVOICE**"],
    ["# Invoice"],
    ["| Invoice INV-1 |"],
  ])("reads an invoice titled %j", (title) => {
    expect(read(`${title}\nLogo design $700.00\nTotal $700.00`)).toEqual(pays("700000000"));
  });

  it("finds the title on any of the first eight lines", () => {
    const head =
      "Acme Design LLC\n1 Main St\nSpringfield\nIL 62701\n(555) 555-0100\nbilling@acme.test\nDate: 2026-11-01";
    expect(read(`${head}\nINVOICE INV-1\nTotal $700.00`)).toEqual(pays("700000000"));
  });

  it.each([
    ["Proposal"],
    ["BID"],
    ["Tender"],
    ["Sales Order"],
    ["ORDER CONFIRMATION"],
    ["Order summary"],
    ["Packing slip"],
    ["Packing List"],
    ["Delivery note"],
    ["Work order"],
    ["Payment confirmation"],
    ["Credit invoice"],
    ["Cancellation invoice"],
    ["Reversal invoice"],
    ["Preliminary invoice"],
    ["Pre-invoice"],
  ])("refuses a %s as not payable, even beside an invoice word", (type) => {
    expect(read(`${type}\nInvoice INV-1\nTotal $700.00`)).toEqual(no("not_payable"));
  });

  it.each([
    ["a receipt beside its amount", "INVOICE INV-1\nRECEIPT 100.00 USDC\nTotal 100 USDC"],
    ["a statement beside its amount", "INVOICE INV-1\nSTATEMENT 2026-10 $500.00\nTotal $500.00"],
    ["a refund beside its amount", "INVOICE INV-1\nRefund amount due 100.00 USDC\nTotal 100 USDC"],
  ])("refuses %s in the first eight lines", (_why, text) => {
    expect(read(text)).toEqual(no("not_payable"));
  });

  it.each([
    ["Quotation No.: Q-88120"],
    ["Receipt No: 5520"],
    ["Quote Number: Q-1"],
    ["Quote Ref: Q-77"],
    ["Statement Date: 10/31/2026"],
  ])("refuses a %j field on any line", (field) => {
    expect(read(`${HEADER}Logo design $700.00\n${field}\nTotal $700.00`)).toEqual(
      no("not_payable"),
    );
  });

  it("refuses a purchase order titled on its first line", () => {
    expect(read("PURCHASE ORDER #4471\nInvoice INV-1\nTotal $700.00")).toEqual(no("not_payable"));
  });

  it.each([
    ["a PO field", "INVOICE INV-1\nPO #4471\nTotal $700.00"],
    ["a purchase order field", "INVOICE INV-1\nPurchase order: PO-4471\nTotal $700.00"],
    ["a purchase order field first", "Purchase order: PO-4471\nINVOICE INV-1\nTotal $700.00"],
    ["a sales order field", "INVOICE INV-1\nSales order: SO-1001\nTotal $700.00"],
  ])("reads an invoice that cites %s", (_why, text) => {
    expect(read(text)).toEqual(pays("700000000"));
  });

  it("refuses a proof of receipt, and reads a due-on-receipt term", () => {
    expect(read("INVOICE INV-1\nProof of receipt\nTotal $700.00")).toEqual(no("not_payable"));
    expect(read("INVOICE INV-1\nPayment due upon receipt\nTotal $700.00")).toEqual(
      pays("700000000"),
    );
  });

  it.each([
    [
      "Sales Invoice twice",
      "Sales Invoice\nAcme Ltd\nWeb hosting\nTotal $100.00\n\nSales Invoice\nAcme Ltd\nDomain renewal\nAmount due $100.00",
    ],
    [
      "Commercial Invoice twice",
      "Commercial Invoice\nTotal $100.00\nCommercial Invoice\nBalance due $100.00",
    ],
    [
      "a named title twice",
      "Acme Ltd \u2014 Invoice\nTotal $100.00\nAcme Ltd \u2014 Invoice\nAmount due $100.00",
    ],
    [
      "Invoice for a month twice",
      "Invoice for October\nTotal: $500.00\n----\nInvoice for November\nAmount due: $500.00",
    ],
    [
      "two customer blocks",
      "INVOICE\nCustomer: Globex\nTotal $100.00\nCustomer: Initech\nAmount due $100.00",
    ],
    [
      "a number on the line after its label",
      "Invoice number:\n1001\nTotal $100.00\nInvoice number:\n1002\nAmount due $100.00",
    ],
    [
      "a number under a header cell",
      "Invoice #\tDate\n1001\t2026-10-01\nTotal $100.00\nInvoice #\tDate\n1002\t2026-10-02\nAmount due $100.00",
    ],
    ["a ref. number", "Invoice ref. A-1\nTotal $100.00\nInvoice ref. A-2\nAmount due $100.00"],
  ])("refuses two invoices in one text: %s", (_why, text) => {
    expect(read(text)).toEqual(no("ambiguous"));
  });

  it("reads an invoice whose number has an -INV- segment as one number", () => {
    expect(read("INVOICE CCC-INV-4410\nTotal $700.00")).toEqual(pays("700000000"));
  });
});

describe("notes, status and money lines around a total", () => {
  it.each([
    [
      "a per-unit note two lines after the total",
      "INVOICE INV-1001\nTotal: $770.00\nThank you!\nAll prices are per seat per month",
    ],
    [
      "a per-user note under a Notes label",
      "INVOICE INV-1001\nTotal: $770.00\nNotes:\nPrice per user, 20 users",
    ],
    [
      "a frequency after the total",
      "Invoice INV-1\nTotal $30.00\nmonthly, billed annually (12 months)",
    ],
    [
      "a scale note in the header",
      "Acme Design LLC\nINVOICE INV-1001\nAll amounts in cents\nBill to: Beta\nDesign $125,000\nHosting $25,000\nSubtotal $150,000\nTax $0\nTotal $150,000",
    ],
    ["a micro unit", "Invoice INV-1\nTotal $2,500,000.00\n(in \u00b5USDC)"],
    ["minor units", "Invoice INV-1\nTotal: $250,000\n(amounts in minor units)"],
    ["atomic units", "Invoice INV-1\nTotal: $2,500,000\nAmounts are in atomic units of USDC"],
    ["pennies", "Invoice INV-1\nTotal: $300\nAmounts shown in pennies"],
    ["$k", "Invoice INV-1\nTotal $3.00\n(in $k)"],
    ["USD '000", "Invoice INV-1\nAmounts in USD '000\nTotal $3.00"],
    ["USD MM", "Invoice INV-1\nTotal $3.00\nUSD MM"],
  ])("refuses %s", (_why, text) => expect(read(text)).toEqual(no("unreadable")));

  it.each([
    [
      "a due date on the first of each month",
      "INVOICE INV-1001\nTotal: $770.00\nThank you!\nPayment is due on the 1st of each month",
    ],
    [
      "a late-fee term",
      "INVOICE INV-1001\nTotal: $770.00\nLate payments incur a 1.5% monthly fee.",
    ],
    [
      "a finance-charge term",
      "INVOICE INV-1001\nTotal: $770.00\nA 1.5% monthly finance charge applies to balances over 30 days.",
    ],
    [
      "a rate line item before the total",
      "INVOICE INV-1001\nRate: $100.00 per hour\nTotal: $770.00",
    ],
  ])("reads %s", (_why, text) => expect(read(text)).toEqual(pays("770000000")));

  it.each([
    ["PAID letter-spaced with tabs", "INVOICE INV-1\nP\tA\tI\tD\nTotal $100.00"],
    ["PAID letter-spaced with runs of spaces", "INVOICE INV-1\nP   A   I   D\nTotal $100.00"],
    ["VOID cut by a pipe", "INVOICE INV-1001\nVO|D\nTotal $100.00"],
    ["VOID in small capitals", "INVOICE INV-1\n\u1d20\u1d0f\u026a\u1d05\nTotal $100.00"],
    ["a date before via", "INVOICE INV-1\nPaid 2026-11-01 via ACH\nTotal $100.00"],
    [
      "paid wrapped across a line",
      "INVOICE INV-1\nTotal $100.00\nThis invoice was paid\nin full on 11/02",
    ],
    ["has now been paid", "INVOICE INV-1\nTotal $100.00\nThis invoice has now been paid."],
    ["a payment made in full", "INVOICE INV-1\nTotal $100.00\nPayment made in full on 11/02/2026."],
    ["a status value under its label", "INVOICE INV-1\nTotal $100.00\nStatus:\nCompleted"],
    ["a status cell", "INVOICE INV-1\nInvoice #\tStatus\nINV-1\tPaid\nTotal $100.00"],
    ["paid as the first word", "INVOICE INV-1\nPaid, thank you\nTotal $100.00"],
    ["a refunded stamp", "INVOICE INV-1\nREFUNDED\nTotal $100.00"],
    ["a test stamp", "INVOICE INV-1\nTEST\nTotal $100.00"],
  ])("refuses %s as not payable", (_why, text) => expect(read(text)).toEqual(no("not_payable")));

  it.each([
    [
      "a terms sentence with not paid by",
      "INVOICE INV-1\nA late fee applies if not paid by the due date.\nTotal $100.00",
    ],
    [
      "a discount if paid by",
      "INVOICE INV-1\nTake 2% discount if paid by 11/11/2026.\nTotal $100.00",
    ],
    ["paid in USDC on NEAR", "INVOICE INV-1\nTotal $100.00\nPaid in native USDC on NEAR"],
    ["an amount paid of zero", "INVOICE INV-1\nTotal $100.00\nAmount paid $0.00"],
    [
      "an agency item, paid search",
      "INVOICE INV-1\nPaid search $60.00\nDesign $40.00\nTotal $100.00",
    ],
    [
      "an agency item, paid social management",
      "INVOICE INV-1\nPaid social management\t$100.00\nTotal $100.00",
    ],
    ["an item, a deposit box", "INVOICE INV-1\nDeposit box rental $100.00\nTotal $100.00"],
    ["a full-width dollar sign", "INVOICE INV-1\nTotal: \uff04100.00"],
    ["a small dollar sign", "INVOICE INV-1\nTotal: \ufe69100.00"],
    ["a street number under the total", "INVOICE INV-1\nTotal $100.00\n1200 Congress Avenue"],
    ["year's end", "INVOICE INV-1\nTotal $100.00\nPayable by year's end"],
  ])("reads %s", (_why, text) => expect(read(text)).toEqual(pays("100000000")));

  it("refuses a payment line written as Paid after a total, and reads it as no stamp", () => {
    expect(read("INVOICE INV-1\nTotal $1,000.00\nPaid $400.00")).toEqual(no("ambiguous"));
  });

  it.each([
    ["a discount", "Discount -$400.00"],
    ["a coupon", "Coupon -$400.00"],
    ["an unpaid amount", "Unpaid $600.00"],
    ["arrears", "Arrears $600.00"],
    ["retainage", "Retainage (10%): -$100.00"],
    ["an amount previously billed", "Previously billed $400.00"],
    ["an installment", "Installment 1: $500.00"],
    ["a milestone", "Milestone 1 of 3 \u2014 $1,000.00 now"],
    ["sales tax in a cell", "Sales tax (8%)\t$80.00"],
    ["shipping in a cell", "Shipping\t$50.00"],
    ["plus sales tax", "plus $80.00 sales tax"],
    ["a remainder", "Remainder $600.00"],
    ["a debit of the total", "Debited from your account $1,000.00"],
    ["a net amount", "Net amount $900.00"],
  ])("refuses a total followed by %s", (_why, line) => {
    expect(read(`INVOICE INV-1\nTotal $1,000.00\n${line}`).amount).toBe("0");
  });

  it.each([
    ["500 dollars", "INVOICE INV-1\nTotal $12\n500 dollars"],
    ["500 USD only", "INVOICE INV-1\nTotal $12\n500 USD only"],
    ["000 000.00", "INVOICE INV-1\nTotal $1\n000 000.00"],
    ["a bracketed fragment", "INVOICE INV-1\nTotal $12\n(,500.00)"],
    ["a starred fragment", "INVOICE INV-1\nTotal $1\n**,000.00**"],
    ["a zero-width space first", "Invoice INV-1001\nTotal: $1\n\u200b,250.00"],
    ["a word joiner first", "Invoice INV-1001\nTotal: $1\n\u2060250.00"],
    ["a low quote for a comma", "Invoice INV-1001\nTotal: $1\n\u201a250.00"],
    ["an Arabic comma", "Invoice INV-1001\nTotal: $1\n\u066c250.00"],
    ["a comma on its own line", "Invoice INV-1001\nTotal: $1\n,\n250.00"],
    ["an ellipsis line", "Invoice INV-1001\nTotal: $1\n...\n,250.00"],
    ["a bracketed value under a bare label", "INVOICE INV-1\nTotal: $5.00\nBalance\n[$9,999.00]"],
    [
      "a value with only under a bare label",
      "INVOICE INV-1\nTotal: $5.00\nBalance\nUSD 9,999.00 only",
    ],
  ])("refuses a figure continued on the next line: %s", (_why, text) => {
    expect(read(text)).toEqual(no("unreadable"));
  });

  it.each([["To\ttal"], ["T otal"], ["T\u00b7otal"], ["Tota l"], ["T/o/t/a/l"], ["T,o,t,a,l"]])(
    "refuses a split label %j",
    (label) => {
      expect(read(`Invoice INV-1001\nTotal: $100.00\n${label}: $5,000.00`)).toEqual(
        no("unreadable"),
      );
    },
  );

  it.each([
    [
      "the subtotal before it",
      "INVOICE INV-1\nSubtotal $1,000.00\nPaid $400.00\nTotal due $1,000.00",
    ],
    [
      "the subtotal, after a deposit",
      "INVOICE INV-1\nSubtotal $1,000.00\nDeposit $400.00\nBalance due $1,000.00",
    ],
    [
      "the net total",
      "INVOICE INV-1\nNet total $1,000.00\nAmount paid $400.00\nAmount due $1,000.00",
    ],
    ["the amount already paid", "Invoice INV-1\nAmount paid: $1,000.00\nTotal due: $1,000.00"],
  ])("refuses a balance after a deduction that equals %s", (_why, text) => {
    expect(read(text)).toEqual(no("ambiguous"));
  });

  it("reads the amount due now of an installment plan", () => {
    expect(
      read("INVOICE INV-1\nContract total $900.00\nInstallment 2 of 3 $300.00\nAmount due $300.00"),
    ).toEqual(pays("300000000"));
  });

  it.each([
    ["a line of NEAR", "INVOICE INV-1\nNEAR NEAR NEAR\nTotal $100.00"],
    ["a word-like code in a folded line", "INVOICE INV-1\nPayable in C\u0410D\nTotal $100.00"],
    ["a dotted code", "INVOICE INV-1\nAll amounts in C.A.D.\nTotal $100.00"],
    ["a spaced code", "INVOICE INV-1\nPrices in E U R\nTotal $100.00"],
    ["a Curr: field", "INVOICE INV-1\nCurr: EUR\nTotal $100.00"],
    ["a Ccy: field", "INVOICE INV-1\nCcy: GBP\nTotal $100.00"],
    ["a settlement currency field", "INVOICE INV-1\nSettlement currency: CHF\nTotal $100.00"],
    ["a settlement asset", "INVOICE INV-1\nSettlement asset: USDt (Tron)\nTotal $100.00"],
    ["C $ with a run of spaces", "INVOICE INV-1\nPrices in C   $\nTotal $100.00"],
    ["C $ with an invisible character", "INVOICE INV-1\nPrices in C\u200b $\nTotal $100.00"],
    ["CAN $", "INVOICE INV-1\nPrices in CAN $\nTotal $100.00"],
    ["$CAN", "INVOICE INV-1\nPrices in $CAN\nTotal $100.00"],
    ["$A", "INVOICE INV-1\nPrices in $A\nTotal $100.00"],
    ["NZ $", "INVOICE INV-1\nPrices in NZ $\nTotal $100.00"],
    ["HK $", "INVOICE INV-1\nPrices in HK $\nTotal $100.00"],
    ["RMB", "INVOICE INV-1\nPrices in RMB\nTotal $100.00"],
    ["FCFA", "INVOICE INV-1\nPrices in FCFA\nTotal $100.00"],
    ["KSh", "INVOICE INV-1\nRate KSh 500\nTotal $100.00"],
    ["EUR in small capitals", "INVOICE INV-1\nPrices in \u1d07\u1d1c\u0280\nTotal $100.00"],
    ["Pay in BNB", "INVOICE INV-1001\nPay in BNB\nTotal $1,000.00"],
    ["an adjective of another dollar", "INVOICE INV-1\nAll amounts are in Canadian\nTotal $100.00"],
  ])("refuses %s as another currency", (_why, text) => expect(read(text)).toEqual(no("currency")));
});

describe("rules the mutation pass found untested", () => {
  it("reads an I look-alike in a capital stamp inside a line as I", () => {
    expect(read("INVOICE INV-1\nLogo design VO\u0406D\t$100.00\nTotal $100.00")).toEqual(
      no("not_payable"),
    );
  });

  it("refuses a document type in a heading after the first eight lines", () => {
    expect(read(`${HEADER}Logo design $700.00\nPAYMENT RECEIPT DETAILS\nTotal $700.00`)).toEqual(
      no("not_payable"),
    );
  });

  it("refuses two invoice titles with one total, and reads a title repeated per page", () => {
    expect(
      read(
        "Sales Invoice\nAcme Ltd\nWeb hosting $100.00\n\nSales Invoice\nAcme Ltd\nDomain renewal $100.00\nTotal $100.00",
      ),
    ).toEqual(no("ambiguous"));
    expect(
      read(
        "Sales Invoice\nAcme Ltd\nWeb hosting $100.00\nPage 1 of 2\nSales Invoice\nAcme Ltd\nDomain renewal $100.00\nTotal $200.00\nPage 2 of 2",
      ),
    ).toEqual(pays("200000000"));
  });

  it("reads an agency item written in capitals that starts with PAID", () => {
    expect(read("INVOICE INV-1\nPAID SEARCH\t$60.00\nDesign $40.00\nTotal $100.00")).toEqual(
      pays("100000000"),
    );
  });

  it("refuses a scale note in the header, far from the total", () => {
    expect(
      read(
        "INVOICE INV-1001\nIn cents\nBill to: Beta\nDesign $125,000\nHosting $25,000\nSubtotal $150,000\nTax $0\nTotal $150,000",
      ),
    ).toEqual(no("unreadable"));
  });

  it("refuses a denomination note after the header, far from the total", () => {
    expect(
      read(
        `${HEADER}All figures are stated in thousands\nLogo design $1.00\nHosting $1.00\nSubtotal $2.00\nTotal $2.00`,
      ),
    ).toEqual(no("unreadable"));
  });

  it("refuses the total restated after it as a discount, and a refunded stamp line", () => {
    expect(read("INVOICE INV-1\nTotal $1,000.00\nDiscount $1,000.00")).toEqual(no("ambiguous"));
    expect(read("INVOICE INV-1\nRefunded\nTotal $100.00")).toEqual(no("not_payable"));
  });

  it("reads a dotted code in its plain spelling", () => {
    expect(read("INVOICE INV-1\nPAY IN C.A.D.\nTotal $100.00")).toEqual(no("currency"));
  });
});

describe("the breaker changes", () => {
  /** A read invoice: a title, a number, a date, an item and its total. */
  const HR =
    "INVOICE\nAcme Design LLC\nInvoice No: INV-1001\nDate: 2026-11-01\nLogo design $700.00\nTotal: $700.00\n";
  const HG =
    "Acme Design LLC\nINVOICE\nInvoice No: INV-1001\nDate: 2026-11-01\nLogo design $700.00\nSubtotal $700.00\nTax $70.00\nTotal: $770.00\n";
  const HP =
    "INVOICE\nMarlow Design Studio\nInvoice #: MDS-2026-140\nDate: 11/04/2026\nBill to: Quarry Labs Inc.\nLogo animation\t$450.00\nTotal\t$450.00\n";
  const withStatus = (s: string) =>
    `INVOICE\nAcme Design LLC\nInvoice No: INV-1001\nDate: 2026-11-01\n${s}\nLogo design $700.00\nTotal: $700.00`;

  it.each([
    [HR, "Balance paid on NEAR"],
    [HR, "Note: paid on NEAR (tx 9b1f...)"],
    [HR, "Customer paid on NEAR"],
    [HR, "Deposit paid on NEAR"],
    [HG, "Paid in USDC, thank you"],
    [HG, "Paid in USDC."],
    [HG, "Paid in USDC already"],
    [HG, "Paid in USDC from globex.near"],
    [HG, "Paid in USDC on NEAR by Globex Corp"],
  ])("refuses a payment made on NEAR or in USDC: %j + %j", (head, line) => {
    expect(read(head + line)).toEqual(no("not_payable"));
  });

  it.each([
    ["Paid in USDC on NEAR"],
    ["Please pay in USDC on NEAR"],
    ["To be paid in USDC on NEAR"],
  ])("reads the payment instruction %j", (line) =>
    expect(read(HR + line)).toEqual(pays("700000000")),
  );

  it.each([
    ["Invoice #1001 (Paid)\nAcme Design LLC"],
    ["Acme Design LLC\nInvoice INV-1001 (void)"],
    ["Acme Design LLC\nInvoice INV-1001 [void]"],
    ["Invoice #1001 \u2022 Paid\nAcme Design LLC"],
    ["Invoice #1001 \u00b7 Paid\nAcme Design LLC"],
    ["Invoice #1001 / Paid\nAcme Design LLC"],
    ["Invoice #1001 (Draft)\nAcme Design LLC"],
    ["Invoice #1001 cancelled\nAcme Design LLC"],
    ["Invoice INV-1001 Void\nAcme Design LLC"],
    ["Invoice #1001 (Refunded)\nAcme Design LLC"],
  ])("refuses a stamp on the title line: %j", (head) => {
    expect(read(`${head}\nLogo design $100.00\nTotal $100.00`)).toEqual(no("not_payable"));
  });

  it.each([
    ["Status \u2022 Paid"],
    ["Status \u00b7 Paid"],
    ["Status / Paid"],
    ["Status > Paid"],
    ["Status \u2192 Paid"],
    ["Status: \u2713 Paid"],
    ["Status: [Paid]"],
    ["Status: (Paid)"],
    ["Status \u2022 Refunded"],
    ["Balance \u2022 Paid"],
  ])("refuses a status behind any separator: %j", (s) =>
    expect(read(withStatus(s))).toEqual(no("not_payable")),
  );

  it.each([
    ["Refunded 11/03/2026 via Stripe"],
    ["Refunded on 11/03/2026"],
    ["This invoice was refunded on 11/03/2026."],
    ["Fully refunded."],
    ["Payment refunded"],
    ["Refunded by bank transfer"],
  ])("refuses a refunded invoice: %j", (s) =>
    expect(read(`${HP}${s}\n`)).toEqual(no("not_payable")),
  );

  it.each([
    ["No action is required."],
    ["No payment is needed."],
    ["No action or payment is needed."],
    ["No action or payment required."],
    ["Auto pay is on for this account."],
    ["Paid by direct-debit on the due date."],
    ["Collected by direct-debit."],
    ["Do not send payment."],
    ["You are enrolled in AutoPay."],
    ["Auto-pay is on for this account."],
    ["This amount will be automatically debited from your account on 12/01/2026."],
    ["This invoice will be charged automatically to your Visa ending in 4242 on Dec 1, 2026."],
    ["Your card on file will be charged on Dec 1, 2026."],
    ["Payment will be collected automatically by direct debit on 12/01/2026."],
    ["This is a test invoice."],
    ["For testing purposes only."],
    ["Please disregard this invoice."],
    ["Issued in error, please ignore."],
    ["This invoice is no longer valid."],
    ["This invoice has been superseded."],
    ["This invoice has been reversed."],
    ["Received with thanks."],
    ["Payment has been processed."],
    ["Payment was captured on 11/02/2026."],
    ["Payment was made on 11/02/2026."],
    ["Marked as paid"],
    ["Nothing to pay - your account is in credit."],
    ["Prepaid"],
  ])("refuses a document the vendor collects, a test or one already settled: %j", (s) => {
    expect(read(`${HP}${s}\n`)).toEqual(no("not_payable"));
  });

  it("reads a late-fee sentence after the total", () => {
    expect(read(`${HP}Late payments incur a 1.5% monthly fee.\n`)).toEqual(pays("450000000"));
  });

  it.each([
    ["Invoice will be issued on 2026-12-01"],
    ["Invoice terms: Net 30"],
    ["Invoice number: to follow"],
    ["Invoice #: pending"],
    ["Invoice # TBD"],
    ["Invoice address: 1 Main St"],
    ["Invoice date: 2026-10-01"],
    ["Invoice questions? Call (555) 010-0100"],
    ["| Invoice | INV-1 |"],
  ])("does not take %j for an invoice title", (line) => {
    expect(readAmount(`Acme Design LLC\n${line}\nLogo design $700.00\nTotal: $700.00`)).toEqual({
      amount: "0",
      issue: "not_payable",
      why: NOT_AN_INVOICE,
    });
  });

  it.each([
    ["Invoice No: INV-1001"],
    ["Invoice #1001"],
    ["Invoice 2026-09"],
    ["Invoice: 1001"],
    ["Invoice n\u00b0 77"],
  ])("takes %j for an invoice title", (line) =>
    expect(read(`Acme Design LLC\n${line}\nLogo design $700.00\nTotal: $700.00`)).toEqual(
      pays("700000000"),
    ),
  );

  it.each([
    ["Invoice Reversal"],
    ["Reversal of Invoice INV-1001"],
    ["Invoice Cancellation"],
    ["Cancellation of Invoice INV-1001"],
    ["Invoice Credit"],
    ["Credit for Invoice INV-1001"],
    ["Credit Advice"],
    ["Credit Slip"],
    ["Credit Voucher"],
    ["Debit Memo"],
    ["Order Acknowledgement"],
    ["Order Acknowledgment"],
    ["RECEIPTED INVOICE"],
  ])("refuses the type %j", (type) => {
    expect(
      read(`Acme Design LLC\n${type}\nInvoice No: INV-1001\nLogo design $700.00\nTotal: $700.00`),
    ).toEqual(no("not_payable"));
  });

  it.each([
    ["This document is a quotation only and is valid for 30 days from the date above."],
    ["This is a receipt for your records."],
    ["This receipt confirms the transaction above for your records."],
    ["This credit note reduces the balance of your account by the amount above."],
  ])("refuses a sentence that names the document's type on any line: %j", (s) => {
    expect(read(`${HEADER}Logo design $700.00\nTotal: $700.00\n${s}`)).toEqual(no("not_payable"));
  });

  it.each([
    ["plus 8% sales tax"],
    ["Plus applicable taxes"],
    ["Excl. VAT"],
    ["Tax not included"],
    ["Shipping extra"],
    ["Shipping 25"],
    ["Discount 50"],
    ["Taxes extra"],
    ["Wire of $700.00 on 2026-11-02 (ref 8812)"],
    ["Approved: $700.00"],
    ["Visa ****4417 $700.00"],
    ["Tx 0x9f3a... $700.00 confirmed"],
    ["Pay $700.00 to acme.near"],
  ])("refuses a money or charge line after the total: %j", (line) => {
    // Ambiguous by the after-total rule, or unreadable earlier (a payee line with an amount).
    expect(read(HR + line).amount).toBe("0");
  });

  it.each([
    ["2% discount if paid within 10 days"],
    ["Late fee of 1.5% per month on overdue balances"],
    ["Amount paid $0.00"],
  ])("reads a term or a zero after the total: %j", (line) =>
    expect(read(HR + line)).toEqual(pays("700000000")),
  );

  it.each([
    ["Gross $1,000.00\nPaid $400.00\nAmount due $1,000.00"],
    ["Logo design $1,000.00\nDeposit received $400.00\nBalance due $1,000.00"],
    ["Logo design $1,000.00\nPaid $400.00\nAmount due $1,000.00"],
    ["Gross $1,000.00\nCredit -$400.00\nAmount due $1,000.00"],
  ])("refuses a balance after a deduction that equals a figure written before it: %j", (body) => {
    expect(read(`INVOICE INV-1\n${body}`)).toEqual(no("ambiguous"));
  });

  it("reads a balance after a deposit", () => {
    expect(
      read("INVOICE INV-1\nLogo design $1,000.00\nDeposit received $400.00\nBalance due $600.00"),
    ).toEqual(pays("600000000"));
  });

  it.each([
    ["All prices are per seat per month"],
    ["Prices per seat"],
    ["Fees are per month"],
    ["Billed per user"],
  ])("refuses a per-unit note in the header: %j", (note) => {
    expect(
      read(`INVOICE INV-1001\n${note}\nBill to: Beta\nTeam plan $770.00\nTotal: $770.00`),
    ).toEqual(no("unreadable"));
  });

  it.each([
    ["Prices in A $"],
    ["Prices in A  $"],
    ["Prices in S $"],
    ["Prices in c.a.d."],
    ["Prices in e.u.r."],
  ])("refuses another dollar or a dotted code after in: %j", (line) =>
    expect(read(`INVOICE INV-1001\n${line}\nTotal $1,000.00`)).toEqual(no("currency")),
  );

  it("reads a fee written a $5 fee", () => {
    expect(read("INVOICE INV-1001\nIncludes a $5 fee\nTotal $1,000.00")).toEqual(
      pays("1000000000"),
    );
  });

  it.each([
    ["INV-1\u300701"],
    ["INV-1\u2c9f01"],
    ["INV-1\u09e601"],
    ["INV-\u01c0001"],
    ["INV\u25741001"],
    ["INV\u4e001001"],
  ])("refuses a number token that keeps a non-ASCII character: %j", (number) => {
    expect(
      read(
        `Acme Studio LLC\nInvoice ${number}\nDate: 2026-10-01\nLogo design $1,000.00\nTotal $1,000.00`,
      ),
    ).toEqual(no("unreadable"));
  });
});

describe("breaker rules the mutation pass found untested", () => {
  const HP =
    "INVOICE\nMarlow Design Studio\nInvoice #: MDS-2026-140\nDate: 11/04/2026\nBill to: Quarry Labs Inc.\nLogo animation\t$450.00\nTotal\t$450.00\n";

  it.each([
    ["Amount refunded on 11/03/2026"],
    ["This invoice has now been refunded."],
    ["Nothing to pay."],
  ])("refuses %j", (line) => expect(read(`${HP}${line}\n`)).toEqual(no("not_payable")));

  it("refuses a balance stated as paid behind an arrow", () => {
    expect(
      read(
        "INVOICE\nAcme Design LLC\nInvoice No: INV-1001\nDate: 2026-11-01\nBalance \u2192 Paid\nLogo design $700.00\nTotal: $700.00",
      ),
    ).toEqual(no("not_payable"));
  });

  it("reads US dollars written as a dotted code after in", () => {
    expect(read("INVOICE INV-1001\nAll amounts in u.s.d.\nTotal $1,000.00")).toEqual(
      pays("1000000000"),
    );
  });
});
