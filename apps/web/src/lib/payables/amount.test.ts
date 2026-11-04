import { describe, expect, it } from "vitest";
import { MAX_READ_UNITS, readAmount } from "./amount";
import { extractFacts } from "./facts";

// The invoice amount reader, rule by rule, through the public extractFacts. It pays only a total written in the
// closed final grammar; everything else is "0" with a reason.

const H = "c".repeat(64);
const read = (text: string) => {
  const f = extractFacts(text, H, null);
  return { amount: f.amount, issue: f.amountIssue };
};
const pays = (amount: string) => ({ amount, issue: null });
const no = (issue: string) => ({ amount: "0", issue });

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
  ])("reads a line end written as %s", (_why, text) => expect(read(text)).toEqual(pays("5000000")));
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
  ])("reads an invoice with %s", (_why, text) => expect(read(text)).toEqual(pays("100000000")));
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
    ["NEAR tokens", "Total 100 USDC\nPaid as NEAR tokens"],
    ["near next to a figure, in lower case", "Total 100 USDC\nor 25 near"],
    ["in near, in lower case", "Total 100 USDC\nPayable in near"],
    ["near tokens, in lower case", "Total 100 USDC\nPaid as near tokens"],
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
    ["CAD as drawings", "CAD drawings and site plans\nTotal 100 USDC"],
    ["US$", "Total US$100"],
    ["a Currency: USD line", "Currency: USD\nTotal 100 USDC"],
  ])("reads %s", (_why, text) => expect(read(text)).toEqual(pays("100000000")));

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
    expect(read("Total 100 USDC\nAmount due $100.00")).toEqual(pays("100000000"));
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
  ])("reads the label of %j", (text, amount) => expect(read(text)).toEqual(pays(amount)));

  it.each([
    ["Total (USD) 1,250.50"],
    ["Total (USDC) 1,250.50"],
    ["Total in USD: 1,250.50"],
    ["Total in USDC 1,250.50"],
    ["Amount Due (USD): $1,250.50"],
  ])("reads the infix of %j", (text) => expect(read(text)).toEqual(pays("1250500000")));

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
  ])("reads the separator of %j", (text) => expect(read(text)).toEqual(pays("5000000")));

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
  ])("reads the amount form %s", (_why, text) => expect(read(text)).toEqual(pays("1250500000")));

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
  ])("reads a figure in %s", (_why, text, amount) => expect(read(text)).toEqual(pays(amount)));

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
  ])("reads the tail %s", (_why, text) => expect(read(text)).toEqual(pays("100000000")));

  it.each([
    ["a full stop right after the figure", "Total $100."],
    ["a date", "Total 100 USDC paid on 2026-10-30"],
    ["a status", "Total 100 USDC refunded"],
    ["a conversion", "Total 100 USDC (approx. 92)"],
    ["a rate", "Total 100 USDC / month"],
    ["a second amount", "Total 100 USDC 200 USDC"],
    ["a figure in words", "Total 100 USDC (nine thousand USDC)"],
    ["a percent", "Total 100 USDC 20%"],
    ["an (incl.) clause with a figure", "Total 100 USDC (incl. 20% VAT)"],
    ["an (incl.) clause naming a status", "Invoice INV-1\nTotal 100 USDC (incl. refund)"],
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
    expect(read(text)).toEqual(pays("700000000")),
  );

  it("refuses a two-word header, where Total is a label without its figure", () => {
    expect(read("Description\tTotal (USD)\nDesign\t400.00\nTotal\t400.00 USDC")).toEqual(
      no("unreadable"),
    );
  });

  it("reads a verb label used as prose (a payment instruction)", () => {
    expect(read("Total $100.00\nPlease pay within 30 days")).toEqual(pays("100000000"));
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
    expect(read(`${line}\nTotal $100.00`)).toEqual(pays("100000000")),
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
    ["Installment 3 of 9 $11.11"],
    ["Year-to-date total $900.00"],
    ["Contract total $9,000.00"],
  ])("ignores the non-final line %j", (line) =>
    expect(read(`${line}\nTotal $100.00`)).toEqual(pays("100000000")),
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
    expect(read(`Subtotal $140.00\n${line}\nBalance due $100.00`)).toEqual(pays("100000000"));
    expect(read(`Subtotal $140.00\n${line}\nAmount due: 100 USDC`)).toEqual(pays("100000000"));
  });

  it.each([
    ["an amount paid", "Total $1,000.00\nAmount paid $400.00"],
    ["a deposit", "Grand total 1,000.00 USDC\nDeposit paid 300.00 USDC"],
    ["a payment received", "Invoice total $1,000.00\nPayment received $1.00"],
    ["a previous balance", "Total $100.00\nPrevious balance $500.00"],
    ["a credit", "Total amount $1,000.00\nCredit applied $50.00"],
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
    // Below a title line: a first line naming a refund would be refused as not payable before it is read.
    expect(read(`INVOICE\n${line}\nTotal $100.00`)).toEqual(no("unreadable")),
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
    expect(read(`${line}\nTotal $100.00`)).toEqual(pays("100000000")),
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
    expect(read("Total 7.50 USDC").amount).toBe("7500000");
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
