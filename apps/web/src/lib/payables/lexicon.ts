// The closed vocabulary of the invoice amount reader (amount.ts) and the identifier patterns it shares with the
// other facts (facts.ts). Every list here is an allowlist or a refusal list: a word that is not in a list is not
// guessed at. Words are written plainly and lower-case; amount.ts compiles them to its look-alike skeleton.

// ---------------------------------------------------------------------------------------------------------------
// Final-total lines: [prefix] label [qualifier] [infix] sep amount [tail]
// ---------------------------------------------------------------------------------------------------------------

/** The labels of a payable total. A line counts as a final total only when its whole text matches the grammar. */
export const FINAL_LABELS: readonly string[] = [
  "total amount due",
  "total amount",
  "total payable",
  "total to pay",
  "total owing",
  "total due",
  "total for this invoice",
  "total",
  "invoice amount",
  "amount due",
  "amount payable",
  "amount remaining",
  "amount owing",
  "balance due",
  "balance remaining",
  "outstanding balance",
  "please pay",
  "pay this amount",
];

/** Final labels that are also ordinary phrases ("Please pay within 30 days"): a label only when one is due. */
export const VERB_LABELS: ReadonlySet<string> = new Set([
  "please pay",
  "pay this amount",
  "total to pay",
]);

/** The only words allowed before a final label. */
export const FINAL_PREFIXES: readonly string[] = ["invoice", "order", "grand", "final"];

/** The only words allowed between a label and its separator: they state the currency. */
export const INFIXES: readonly string[] = ["(usd)", "(usdc)", "in usd", "in usdc"];

/**
 * The final labels that state the whole invoice, before anything it deducts. Every other final label states what
 * is left to pay, and only such a label, after the last deduction, settles one.
 */
export const GROSS_LABELS: ReadonlySet<string> = new Set([
  "total",
  "total amount",
  "invoice amount",
  "total for this invoice",
]);

// ---------------------------------------------------------------------------------------------------------------
// Non-final lines: label sep amount [tail]. They never pay; they only keep a payable-looking line from refusing.
// ---------------------------------------------------------------------------------------------------------------

/** Partial totals named with "Total" first: the same as "Sales tax" or "Subtotal", never what is due. */
const TOTAL_PARTIALS: readonly string[] = [
  "total sales tax",
  "total excluding tax",
  "total excl. tax",
  "total excl tax",
  "total before tax",
  "total pre-tax",
];

/**
 * Lines that change what is left to pay: a payment, deposit or credit already made, or a balance carried over.
 * With a non-zero figure on one of them, only a balance-type label written after it says what is due.
 */
export const DEDUCTION_LABELS: ReadonlySet<string> = new Set([
  "deposit paid",
  "deposit received",
  "deposit applied",
  "deposits",
  "deposit",
  "less deposit",
  "amount paid",
  "paid to date",
  "paid",
  "payments received",
  "payment received",
  "less payments",
  "less payment",
  "payments",
  "payment",
  "down payment",
  "partial payment",
  "prepayment",
  "retainer applied",
  "credits applied",
  "credit applied",
  "credits",
  "credit",
  "previous balance",
]);

export const NON_FINAL_LABELS: readonly string[] = [
  "subtotal",
  "sub-total",
  "sub total",
  ...TOTAL_PARTIALS,
  "sales tax",
  "tax total",
  "total tax",
  "total vat",
  "tax",
  "vat",
  "gst",
  "net total",
  "net amount",
  "discount",
  "shipping and handling",
  "shipping & handling",
  "shipping",
  "handling",
  "fees",
  "fee",
  ...DEDUCTION_LABELS,
  "page total",
  "year-to-date total",
  "contract total",
];

/**
 * Phrases that contain a final-label word but name a partial total; they are removed before a line is searched
 * for a final label, so "Sub total" or "Tax total" with no figure is not a final label without its figure.
 */
export const PARTIAL_PHRASES: readonly string[] = [
  "sub total",
  "sub-total",
  ...TOTAL_PARTIALS,
  "tax total",
  "total tax",
  "total vat",
  "net total",
  "page total",
  "year-to-date total",
  "year to date total",
  "contract total",
];

/** Words of a table header ("Item Qty Price Total"): such a line names columns, it is not a label. */
export const HEADER_WORDS: ReadonlySet<string> = new Set([
  "#",
  "no",
  "no.",
  "item",
  "items",
  "description",
  "desc",
  "details",
  "service",
  "services",
  "product",
  "products",
  "sku",
  "code",
  "qty",
  "quantity",
  "unit",
  "units",
  "price",
  "rate",
  "hours",
  "hrs",
  "days",
  "date",
  "period",
  "amount",
  "cost",
  "line",
  "tax",
  "vat",
  "discount",
  "subtotal",
  "total",
  "(usd)",
  "(usdc)",
]);

/** A header is a column header only with one of these: a column of items or quantities, not of sums. */
export const ITEM_COLUMNS: ReadonlySet<string> = new Set([
  "item",
  "items",
  "description",
  "desc",
  "details",
  "service",
  "services",
  "product",
  "products",
  "sku",
  "qty",
  "quantity",
  "unit",
  "units",
  "rate",
  "hours",
  "hrs",
]);

/** Summary columns: a header that names one of these lines up sums, and its next row would be their values. */
export const SUMMARY_COLUMNS: ReadonlySet<string> = new Set([
  "subtotal",
  "sub-total",
  "tax",
  "vat",
  "gst",
  "discount",
]);

// ---------------------------------------------------------------------------------------------------------------
// Payable-looking lines
// ---------------------------------------------------------------------------------------------------------------

/** A line holding one of these words and a digit-like character must be a final or a non-final line. */
export const PAYABLE_WORDS: readonly string[] = [
  "total",
  "due",
  "payable",
  "balance",
  "amount",
  "owing",
  "outstanding",
  "remit",
  "pay",
  "sum",
];

/**
 * Words of money that changes hands or is still owed: payments, credits, deposits, refunds, adjustments, what is
 * owed or remaining. A line holding one of these and a money token (a currency marker and a figure, or a figure
 * with decimals) must be a final or a non-final line, or the invoice is unreadable.
 */
export const MONEY_WORDS: readonly string[] = [
  "paid",
  "payment",
  "payments",
  "credit",
  "credits",
  "you owe",
  "owe",
  "owed",
  "adjustment",
  "adjustments",
  "refund",
  "refunds",
  "refunded",
  "deposit",
  "deposits",
  "received",
  "applied",
  "settle",
  "settled",
  "retainer",
  "write-off",
  "write off",
  "writeoff",
  "prepaid",
  "prepayment",
  "prepayments",
  "advance",
  "less",
  "minus",
  "withholding",
  "unpaid",
  "overpaid",
  "repaid",
  "repayment",
  "repayments",
  "arrears",
  "charged",
  "late fee",
  "gift card",
  "remaining",
  "amt",
  "bal",
  "tot",
  "value",
  "send",
];

/**
 * Words with a charge or deduction meaning. A money line holding one after the last final total (and no final total
 * after it) changes what is due, so the invoice is ambiguous.
 */
export const CHARGE_WORDS: readonly string[] = [
  "discount",
  "coupon",
  "credit",
  "credits",
  "fee",
  "fees",
  "tax",
  "taxes",
  "vat",
  "gst",
  "hst",
  "pst",
  "shipping",
  "handling",
  "freight",
  "delivery",
  "installment",
  "instalment",
  "milestone",
  "adjustment",
  "adjustments",
  "charge",
  "charges",
  "charged",
  "surcharge",
  "interest",
  "penalty",
  "late",
  "billed",
  "retainage",
  "deposit",
  "deposits",
  "payment",
  "payments",
  "paid",
  "unpaid",
  "arrears",
  "deduction",
  "rebate",
  "refund",
  "withholding",
  "plus",
  "less",
  "minus",
];

/** Compound nouns that hold a payable word but never state what is owed ("Due diligence", "Balance sheet"). */
export const NOT_PAYABLE_PHRASES: readonly string[] = [
  "due diligence",
  "pay-per-click",
  "pay per click",
  "balance sheet",
  "balance sheets",
];

/** Numbers written in words count as digits ("Amount in words: nine thousand"). */
export const NUMBER_WORDS: readonly string[] = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "billion",
];

/** Words that change what a figure means; on a final-total line, or in its "(incl. ...)", they make it unreadable. */
export const SCALE_WORDS: readonly string[] = [
  "cent",
  "cents",
  "base",
  "unit",
  "units",
  "decimal",
  "decimals",
  "wei",
  "gwei",
  "lamport",
  "lamports",
  "yocto",
  "yoctonear",
  "micro",
  "satoshi",
  "satoshis",
  "sats",
  "hundred",
  "hundreds",
  "thousand",
  "thousands",
  "million",
  "millions",
  "billion",
  "billions",
  "lakh",
  "lakhs",
  "crore",
  "crores",
  "k",
  "m",
  "mm",
  "mn",
  "bn",
];

/**
 * Scale and denomination words of a note on another line ("(USDC base units, 6 decimals)", "All figures in
 * thousands"): near a final total, or in a note in brackets, they make the invoice unreadable.
 */
export const NOTE_SCALE_WORDS: readonly string[] = [
  "cent",
  "cents",
  "penny",
  "pennies",
  "pence",
  "minor unit",
  "minor units",
  "atomic unit",
  "atomic units",
  "smallest unit",
  "smallest units",
  "sub-unit",
  "sub-units",
  "subunit",
  "subunits",
  "decimal places",
  "dp",
  "base unit",
  "base units",
  "decimal",
  "decimals",
  "wei",
  "gwei",
  "lamport",
  "lamports",
  "yocto",
  "yoctonear",
  "micro",
  "satoshi",
  "satoshis",
  "sats",
  "hundred",
  "hundreds",
  "thousand",
  "thousands",
  "million",
  "millions",
  "billion",
  "billions",
  "lakh",
  "lakhs",
  "crore",
  "crores",
];

/** Words that may not stand in an "(incl. ...)" tail: they state a status, not what the total includes. */
export const STATUS_WORDS: readonly string[] = [
  "paid",
  "void",
  "voided",
  "refund",
  "refunds",
  "refunded",
  "cancelled",
  "canceled",
  "credit",
  "credits",
  "credited",
  "deposit",
  "deposits",
  "estimate",
  "estimated",
  "prior",
  "sample",
  "draft",
];

// ---------------------------------------------------------------------------------------------------------------
// Documents that are not a payable invoice
// ---------------------------------------------------------------------------------------------------------------

/** A title or heading naming one of these makes the document not payable. */
export const DOCUMENT_TYPES: readonly string[] = [
  "remittance advice",
  "receipt",
  "quotation",
  "quote",
  "estimate",
  "purchase order",
  "credit note",
  "credit memo",
  "debit note",
  "refund",
  "statement of account",
  "statement",
  "pro forma",
  "pro-forma",
  "proforma",
  "proposal",
  "bid",
  "tender",
  "sales order",
  "order confirmation",
  "order summary",
  "packing slip",
  "packing list",
  "delivery note",
  "work order",
  "payment confirmation",
  "credit invoice",
  "cancellation invoice",
  "reversal invoice",
  "preliminary invoice",
  "pre-invoice",
  "reversal of invoice",
  "reversal for invoice",
  "cancellation of invoice",
  "cancellation for invoice",
  "credit of invoice",
  "credit for invoice",
  "credit advice",
  "credit slip",
  "credit voucher",
  "debit memo",
  "order acknowledgement",
  "order acknowledgment",
  "receipted",
];

/**
 * Types that count only in the title (the first lines): an invoice may carry a remittance or payment slip, and a
 * heading "INVOICE" over a "Credit card payments accepted." line is no "invoice credit".
 */
export const TITLE_ONLY_TYPES: readonly string[] = [
  "remittance",
  "payment advice",
  "invoice reversal",
  "invoice cancellation",
  "invoice credit",
];

/**
 * Wordings that say nothing is owed from this document (ruling W-T13-B7): the vendor collects it itself, it is a
 * test or cancelled in prose, or it was settled. Read per line, on a line with no money token.
 */
export const NOT_OWED_PHRASES: readonly string[] = [
  "no action is needed",
  "no action is required",
  "no payment needed",
  "no payment is needed",
  "no payment is required",
  "no action or payment needed",
  "no action or payment is needed",
  "no action or payment required",
  "no action or payment is required",
  "do not send payment",
  "autopay",
  "auto pay",
  "auto-pay",
  "direct debit",
  "direct-debit",
  "automatically charged",
  "automatically debited",
  "automatically drafted",
  "automatically collected",
  "charged automatically",
  "debited automatically",
  "drafted automatically",
  "collected automatically",
  "card on file will be charged",
  "will be drawn",
  "test invoice",
  "testing purposes",
  "disregard this invoice",
  "issued in error",
  "no longer valid",
  "superseded",
  "has been reversed",
  "received with thanks",
  "payment has been processed",
  "payment was processed",
  "payment has been captured",
  "payment was captured",
  "payment has been made",
  "payment was made",
  "marked paid",
  "marked as paid",
  "nothing to pay",
  "in credit",
  "prepaid",
];

/** Stamps: a line that holds only one of these (decorated or not) makes the document not payable. */
export const STAMPS: readonly string[] = [
  "paid",
  "paid in full",
  "void",
  "voided",
  "cancelled",
  "canceled",
  "sample",
  "specimen",
  "draft",
  "duplicate",
  "do not pay",
  "refunded",
  "test",
  "example",
  "template",
  "demo",
];

/** Stamp words that count anywhere when written in capitals ("INVOICE INV-90 - VOID"). */
export const CAPITAL_STAMPS: readonly string[] = [
  "VOID",
  "VOIDED",
  "CANCELLED",
  "CANCELED",
  "SAMPLE",
  "SPECIMEN",
  "DRAFT",
  "DUPLICATE",
  "PAID",
  "REFUNDED",
  "TEST",
  "EXAMPLE",
  "TEMPLATE",
  "DEMO",
];

/**
 * Stamp words that refuse a line they start, in any case ("Draft invoice", "Void - reissued", "Paid, thank you").
 * "Paid" is exempt on a non-final money line ("Paid $400.00"), in an item row ("Paid search $500.00"), in a terms
 * sentence and in an instruction ("Paid in USDC on NEAR"): amount.ts reads those.
 */
export const FIRST_WORD_STAMPS: readonly string[] = [
  "paid",
  "refunded",
  "void",
  "voided",
  "cancelled",
  "canceled",
  "sample",
  "specimen",
  "draft",
  "duplicate",
];

/** Phrases that count anywhere, in any case. */
export const STATUS_PHRASES: readonly string[] = [
  "fully refunded",
  "payment refunded",
  "was refunded",
  "do not pay",
  "don't pay",
  "don\u2019t pay",
  "dont pay",
  "this is not an invoice",
  "not an invoice",
  "not for payment",
  "not a tax invoice",
  "paid in full",
  "fully paid",
  "already paid",
  "payment received",
  "received in full",
  "payment complete",
  "payment completed",
  "thank you for your payment",
  "no action needed",
  "no action required",
  "no payment required",
  "no payment due",
  "settled",
  "for illustration only",
  "has been cancelled",
  "has been canceled",
  "has been voided",
  "has been paid",
  "has already been paid",
  "has been refunded",
  "invoice is void",
  "invoice is voided",
  "invoice is cancelled",
  "invoice is canceled",
  "invoice is paid",
  "invoice was paid",
  "invoice was voided",
  "invoice was cancelled",
  "invoice was canceled",
  "do not remit",
  "for your records only",
  "for reference only",
  "date paid",
  "invoice paid",
  "payment was received",
  "payment has been received",
  "received your payment",
  "thanks for your payment",
  "thank you for paying",
  "payment successful",
  "payment succeeded",
  "payment confirmed",
  "payment processed",
  "charged to",
];

/** The values of a "Status:" line that make the document not payable. */
export const STATUS_VALUES: readonly string[] = [
  "paid",
  "succeeded",
  "closed",
  "processed",
  "paid in full",
  "fully paid",
  "payment received",
  "settled",
  "complete",
  "completed",
  "void",
  "voided",
  "cancelled",
  "canceled",
  "refunded",
  "draft",
];

// ---------------------------------------------------------------------------------------------------------------
// Currencies. The vault pays USDC, so a document that names any other currency is refused.
// ---------------------------------------------------------------------------------------------------------------

/** ISO 4217 codes (active codes and funds), without USD and its fund codes, and without XXX and XTS. */
export const ISO_CODES: ReadonlySet<string> = new Set(
  (
    "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BYR " +
    "BZD CAD CDF CHE CHF CHW CLF CLP CNH CNY COP COU CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD " +
    "FKP GBP GEL GGP GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS IMP INR IQD IRR ISK JEP JMD JOD JPY " +
    "KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRO MRU MUR MVR " +
    "MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD " +
    "SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STD STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TVD TWD TZS UAH " +
    "UGX UYI UYU UYW UZS VED VEF VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU " +
    "XUA YER ZAR ZMW ZWG ZWL"
  ).split(" "),
);

/** Token codes other than USDC (NEAR and SOL count only when used as a currency, see below). */
export const TOKEN_CODES: ReadonlySet<string> = new Set([
  "USDT",
  "DAI",
  "EURC",
  "PYUSD",
  "BTC",
  "WBTC",
  "ETH",
  "WETH",
  "XRP",
  "NEAR",
  "SOL",
]);

/**
 * Codes that are also ordinary words or abbreviations ("ALL PRICES", "CAD drawings", "AMD", "PHP", "NEAR" as a
 * network): they count only where they are used as a currency (amount.ts lists the forms).
 */
export const WORDLIKE_CODES: ReadonlySet<string> = new Set([
  "ALL",
  "AMD",
  "BAM",
  "BOB",
  "BTN",
  "CAD",
  "CUP",
  "CVE",
  "GEL",
  "MAD",
  "MDL",
  "MOP",
  "NEAR",
  "PEN",
  "PHP",
  "SOL",
  "SOS",
  "SVC",
  "TOP",
  "TRY",
  "RUB",
  "STD",
]);

/** Words that put a code on their line in a currency context ("All prices CAD", "Amounts are PHP"). */
export const CURRENCY_CONTEXT_WORDS: readonly string[] = [
  "currency",
  "currencies",
  "price",
  "prices",
  "pricing",
  "priced",
  "amount",
  "amounts",
  "billed",
  "payable",
  "payment",
  "only",
  "funds",
  "figures",
  "settle",
  "settlement",
];

/** Currency words, matched whole-word in any case. */
export const CURRENCY_WORDS: readonly string[] = [
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
  "kronor",
  "krone",
  "kroner",
  "real",
  "reais",
  "rand",
  "rands",
  "lira",
  "lire",
  "liras",
  "ruble",
  "rubles",
  "rouble",
  "roubles",
  "dirham",
  "dirhams",
  "riyal",
  "riyals",
  "rial",
  "rials",
  "ringgit",
  "rupiah",
  "shekel",
  "shekels",
  "zloty",
  "zlotys",
  "forint",
  "forints",
  "dinar",
  "dinars",
  "hryvnia",
  "tenge",
  "naira",
  "cedi",
  "cedis",
  "kwacha",
  "shilling",
  "shillings",
  "taka",
  "lempira",
  "quetzal",
  "guarani",
  "boliviano",
  "bolivar",
  "afghani",
  "lari",
  "manat",
  "somoni",
  "tugrik",
  "kyat",
  "riel",
  "lek",
  "denar",
  "bitcoin",
  "bitcoins",
  "ether",
  "tether",
  "loonie",
  "loonies",
  "toonie",
  "toonies",
  "koruna",
  "koruny",
  "korun",
  "leva",
  "kuna",
  "kune",
  "dalasi",
  "birr",
  "ouguiya",
  "rufiyaa",
];

/** "<country> dollar(s)", "<country> $", "<country> funds", "<country> currency": another country's money. */
export const OTHER_DOLLARS: readonly string[] = [
  "australian",
  "aussie",
  "bahamian",
  "barbadian",
  "belize",
  "bermudian",
  "brunei",
  "canadian",
  "cdn",
  "caymanian",
  "east caribbean",
  "fijian",
  "guyanese",
  "hong kong",
  "jamaican",
  "kiwi",
  "liberian",
  "namibian",
  "new taiwan",
  "new zealand",
  "singapore",
  "singaporean",
  "solomon islands",
  "surinamese",
  "taiwan",
  "taiwanese",
  "trinidad and tobago",
  "zimbabwean",
  "au",
  "nz",
  "ca",
  "hk",
  "sg",
];

/** Currency signs that are letters, not `\p{Sc}`: yen and yuan (CJK), won (Hangul). */
export const LETTER_CURRENCY_SIGNS = "\u5186\u5143\u5706\u5713\uc6d0";

// ---------------------------------------------------------------------------------------------------------------
// Look-alike letters: folded to the plain letter they look like, so a disguised word is still seen. Accented
// letters fold through NFD, and full-width or mathematical letters through NFKC, in amount.ts. "l" also stands
// for i, I and |, which look like it.
// ---------------------------------------------------------------------------------------------------------------

export const LOOK_ALIKES: Readonly<Record<string, string>> = {
  a: "\u0430\u0251\u03b1\u237a\uab64\u0410\u0391\u13aa\u15c5\ua4ee\u1d00\u0250\u2c65",
  b: "\u042c\u044c\u13cf\u15af\u0184\u0412\u0432\u0392\u13f4\u15f7\ua4d0\u0299",
  c: "\u0441\u1d04\u2ca5\uabaf\u0421\u13df\ua4da\u2ca4\u217d\u216d",
  d: "\u0501\u146f\ua4d2\u13a0\u15ea\ua4d3\u217e\u216e\u1d05",
  e: "\u0435\u04bd\u0454\u212e\u0415\u0395\u13ac\ua4f0\u2d39\u1d07",
  f: "\ua730",
  g: "\u0261\u0581\u13c0\u050c\ua4d6\u13f3\u0262",
  h: "\u04bb\u0570\u041d\u0397\u13bb\ua4e7\u029c",
  j: "\u0458\u0408\u037f\u13ab\ua4d9\u1d0a",
  k: "\u043a\u039a\u13e6\ua4d7\u1d0b",
  l: "\u04cf\u01c0\u217c\ua4f2\ua4e1\u13de\u14aa\u2cd0\u216c\u0456\u0131\u0269\u03b9\ua647\u0406\u0399\u04c0\u2170\u2160\u029f\u026a\u0142\u019a\u026b\u026d\u0140\u2223",
  m: "\u043c\u041c\u039c\u13b7\ua4df\u03fa\u217f\u216f\u1d0d",
  n: "\u0578\u057c\u043f\u039d\ua4e0\u0274\u03b7",
  o: "\u043e\u03bf\u03c3\u0585\u0ed0\u12d0\u2c9f\u041e\u039f\u0555\u2c9e\ua4f3\u1d0f\u13eb\u00f8\u0275\u1d11\u25cb\u25ef\u2218",
  p: "\u0440\u03c1\u2ca3\u0420\u03a1\u13e2\ua4d1\u1d18",
  q: "\u051b\ua7af",
  r: "\u0433\u1d26\u2c85\uab47\uab48\u0280\u13d2\ua4e3\u13a1",
  s: "\u0455\ua731\u01bd\u0405\u13da\ua4e2",
  t: "\u0442\u03c4\u0422\u03a4\u13a2\ua4d4\u2ca6\u1d1b\u0167\u0166\u01ad\u0288\u2020",
  u: "\u03c5\u057d\u1d1c\uab4e\ua79f\u054d\u144c\ua4f4",
  v: "\u03bd\u0475\u1d20\u13d9\ua4e6",
  w: "\u0461\u051d\u1d21\u13b3\ua4ea",
  x: "\u0445\u0425\u03a7\u2cac\ua4eb",
  y: "\u0443\u04af\u03b3\u0263\u0423\u04ae\u03a5\u13a9\ua4ec\u028f",
  z: "\u1d22\u0396\u13c3\ua4dc",
};

// ---------------------------------------------------------------------------------------------------------------
// Identifiers. They are facts of their own (facts.ts), and the amount reader does not count their digits as a
// figure. Every quantifier is bounded, and no two of them can share the same run of characters.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The number after an invoice label: "Invoice INV-1", "Invoice # 12", "INVOICE NO. 123", "Invoice: #1001",
 * "Invoice n\u00b0 1001", "Inv. No. 1001", "Bill #1001". Read it from the text with invisible characters removed and
 * dashes folded (facts.ts `invoiceView`).
 */
export const INVOICE_NO =
  /\b(?:invoice|inv\.|inv(?=[ \t]{1,4}(?:#|no\b|number\b))|bill(?![a-z]))[ \t]{0,40}(?:(?:#|no\.?|n[\u00b0\u00ba]|number|num\.?|id|ref\.?)[ \t]{0,40})?(?:[:#-][ \t]{0,40}){0,3}((?=[A-Z0-9/-]{0,31}[0-9])[A-Z0-9][A-Z0-9/-]{0,31})(?![A-Z0-9/-])/i;
/**
 * An invoice-number token on its own: "INV-2026-07", "# INV-000415", "INV 2026-0451"; not the "-INV-" segment of
 * another id ("CCC-INV-4410" is one number, read whole by INVOICE_NO).
 */
export const INVOICE_TOKEN =
  /(?<![A-Z0-9/-])INV(?:[-#]|[ \t]{1,4})?[0-9][A-Z0-9/-]{0,30}(?![A-Z0-9/-])/i;

/** A reference that starts with PO itself: "PO-4471", "PO4471" ("PO" must be a word, and hold a digit). */
export const PO_TOKEN = /\b(PO[-#]?[0-9][A-Z0-9-]{1,30})(?![A-Z0-9-])/i;
/** A labelled reference: "PO: 4471", "P.O. number 7781", "Purchase order #4471-A". */
export const PO_LABELLED =
  /\b(?:P\.?O\b\.?|purchase[ \t]{1,40}order\b)[ \t]{0,40}(?:(?:#|no\.?|number)[ \t]{0,40})?(?:[:-][ \t]{0,40})?((?=[A-Z0-9-]{0,31}[0-9])[A-Z0-9][A-Z0-9-]{2,31})(?![A-Z0-9-])/i;

export const EVM_ADDRESS = /\b(0x[0-9a-fA-F]{40})\b/;

/** One part of a NEAR account id: lower-case letters and digits, joined by single "-" or "_". */
const NEAR_PART = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
/** Runs of the characters an id is made of, in either case (one linear pass, no nested quantifier). */
const ACCOUNT_RUN = /[A-Za-z0-9_.-]+/g;

/**
 * The NEAR accounts in a text, in order: a whole run of id characters that ends in ".near" or ".testnet", is at
 * most 64 characters long (dots at its ends dropped) and whose parts are lower-case. Linear: the text is cut into
 * runs once, and only a short run with the right ending has its parts checked.
 */
export function nearAccounts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ACCOUNT_RUN)) {
    const account = accountOf(m[0]);
    if (account !== null) out.push(account);
  }
  return out;
}

/** The text with every NEAR account blanked out (one linear replace). */
export function maskNearAccounts(text: string): string {
  return text.replace(ACCOUNT_RUN, (run) => (accountOf(run) === null ? run : " "));
}

/** The NEAR account a run of id characters is, or null. */
function accountOf(raw: string): string | null {
  if (raw.length > 66) return null;
  const run = raw.replace(/^\.+|\.+$/g, "");
  if (run.length > 64 || !(run.endsWith(".near") || run.endsWith(".testnet"))) return null;
  const parts = run.split(".");
  parts.pop();
  return parts.length > 0 && parts.every((p) => NEAR_PART.test(p)) ? run : null;
}
