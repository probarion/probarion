import {
  BALANCE_LABELS,
  CAPITAL_STAMPS,
  CURRENCY_WORDS,
  DEDUCTION_LABELS,
  DOCUMENT_TYPES,
  FINAL_LABELS,
  FINAL_PREFIXES,
  HEADER_WORDS,
  INFIXES,
  INVOICE_NO,
  INVOICE_TOKEN,
  ISO_CODES,
  LOOK_ALIKES,
  maskNearAccounts,
  NON_FINAL_LABELS,
  NUMBER_WORDS,
  OTHER_DOLLARS,
  PARTIAL_PHRASES,
  PAYABLE_WORDS,
  PO_LABELLED,
  PO_TOKEN,
  SCALE_WORDS,
  STAMPS,
  STATUS_PHRASES,
  STATUS_VALUES,
  STATUS_WORDS,
  TOKEN_CODES,
  VERB_LABELS,
  WORDLIKE_CODES,
} from "./lexicon";

// The invoice amount reader. In rules-only mode the amount it returns goes straight to `spend`, so it is an
// allowlist: it pays only a total stated on a line written in a plain, closed grammar, and refuses everything
// else as "0" with a reason. The order is fixed:
//   1. gates on the whole document: text it cannot trust, a document that is not a payable invoice, another
//      currency, more than one invoice;
//   2. every final-total line must match the final grammar;
//   3. every other line that looks payable must match the non-final grammar;
//   4. all final totals must agree.
// A refusal costs the owner a click; a wrong payment costs money.

/**
 * Why the amount is "0" (rule `invoice.amount_invalid` refuses it, and the console says why), or null when it was
 * read. The list is also the `invoices.amount_issue` check constraint and `invoice_insert`'s check (migration
 * 0006).
 */
export const AMOUNT_ISSUES = [
  "not_found",
  "ambiguous",
  "unreadable",
  "currency",
  "truncated",
  "zero",
  "not_payable",
] as const;
export type AmountIssue = (typeof AMOUNT_ISSUES)[number];

export interface AmountRead {
  /** USDC base units as a canonical non-negative integer string; "0" when refused. */
  amount: string;
  issue: AmountIssue | null;
}

/** Past this many UTF-16 units, before or after NFKC, nothing is read. The pipeline passes at most 50,000. */
export const MAX_READ_UNITS = 200_000;
/** The largest total paid: 10^12 USDC. */
const MAX_UNITS = 10n ** 18n;

const refuse = (issue: AmountIssue): AmountRead => ({ amount: "0", issue });

/** Every line end the model, the hash and the reader treat as one: CRLF, CR, VT, FF, NEL, LS and PS. */
const LINE_ENDS = /\r\n?|[\v\f\u0085\u2028\u2029]/g;
export const normaliseLineEnds = (s: string): string => s.replace(LINE_ENDS, "\n");

// ---------------------------------------------------------------------------------------------------------------
// Views of the text: the grammar view (NFKC, as shown) and, per line, the skeleton (detection only).
// ---------------------------------------------------------------------------------------------------------------

const ASCII = /^\p{ASCII}*$/u;
/** A C0 or C1 control other than tab and line feed, a replacement character, or a bidi control. */
const UNTRUSTED = /(?![\t\n])\p{Cc}|[\ufffd\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const NUMERAL_RUNS = /[\p{Nl}\p{No}]+|[^\p{Nl}\p{No}]+/gu;
const NUMERAL = /^[\p{Nl}\p{No}]/u;
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const MARK = /\p{M}/u;
const LETTER = /\p{L}/u;

/**
 * NFKC, so full-width digits, labels and spaces read as the plain ones they show. Numerals that are not plain
 * digits (superscripts, circled numbers, fractions, Roman numerals) are kept as they are: NFKC would turn "100\u00b2"
 * into "1002". Kept, they are not ASCII, so no grammar matches them.
 */
function nfkc(text: string): string {
  if (ASCII.test(text)) return text;
  let out = "";
  for (const run of text.match(NUMERAL_RUNS) ?? [])
    out += NUMERAL.test(run) ? run : run.normalize("NFKC");
  return out;
}

const FOLD = new Map<string, string>();
for (const [to, from] of Object.entries(LOOK_ALIKES)) for (const c of from) FOLD.set(c, to);

/** The skeleton spelling of a plain ASCII word or phrase: lower case, with i and | folded to l. */
export const sk = (s: string): string => s.toLowerCase().replace(/[i|]/g, "l");

function foldChar(ch: string): string {
  const look = FOLD.get(ch);
  if (look !== undefined) return look;
  if (LETTER.test(ch)) {
    const base = ch.normalize("NFD")[0] ?? ch;
    if (base !== ch && /^[A-Za-z]$/.test(base)) return sk(base);
    return ch.toLowerCase();
  }
  return ch;
}

/**
 * The skeleton of a line: invisible characters and combining marks removed, look-alike and accented letters
 * folded to the plain letter they look like, lower case, i and | as l. It finds disguised words; it never pays.
 */
function skeletonOf(line: string): string {
  if (ASCII.test(line)) return sk(line);
  let out = "";
  for (const ch of line) {
    if (ch.charCodeAt(0) < 0x80) out += sk(ch);
    else if (!INVISIBLE.test(ch) && !MARK.test(ch)) out += foldChar(ch);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Word patterns on the skeleton
// ---------------------------------------------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const byLength = (words: readonly string[]) => [...words].sort((a, b) => b.length - a.length);
/** Whole words or phrases of the skeleton (spaces between words match any run of spaces). */
const phrases = (words: readonly string[], flags = "") =>
  new RegExp(
    `(?<![a-z])(?:${byLength(words)
      .map((w) => escapeRe(sk(w)).replace(/ /g, "\\s+"))
      .join("|")})(?![a-z])`,
    flags,
  );

const PAYABLE = phrases(PAYABLE_WORDS);
/** A final-label word glued to other letters ("Grandtotal", "Totals", "amountdue"), but not "Subtotal". */
const GLUED =
  /(?<![a-z])(?!subtotals?(?![a-z]))(?:[a-z]+total[a-z]*|total[a-z]+|amountdue|balancedue|amountpayable|amountowlng|amountremalnlng|balanceremalnlng|outstandlngbalance)(?![a-z])/;
const NUMBER_WORD = phrases(NUMBER_WORDS);
const PARTIAL = phrases(PARTIAL_PHRASES, "g");
const NOUN_LABEL = phrases(FINAL_LABELS.filter((l) => !VERB_LABELS.has(l)));
/** A verb-phrase label ("Please pay") is a label only when a separator, a currency or a figure follows it. */
const VERB_LABEL = new RegExp(
  `(?<![a-z])(?:${byLength([...VERB_LABELS])
    .map((w) => escapeRe(sk(w)).replace(/ /g, "\\s+"))
    .join("|")})(?:\\s*(?:\\(usdc?\\)|ln\\s+usdc?))?(?=\\s*(?:$|[:=|.\\t]|\\$|\\d|us))`,
);

// ---------------------------------------------------------------------------------------------------------------
// 1. Gates on the whole document
// ---------------------------------------------------------------------------------------------------------------

const STAMP_LINES: ReadonlySet<string> = new Set(STAMPS.map(sk));
const STATUS_PHRASE = phrases(STATUS_PHRASES);
const STATUS_LINE = new RegExp(
  `^\\W{0,10}(?:(?:lnvolce|payment)[ \\t]{1,4})?status[ \\t]{0,4}[:=-]?[ \\t]{0,4}(?:${byLength(
    STATUS_VALUES,
  )
    .map((w) => escapeRe(sk(w)).replace(/ /g, "\\s+"))
    .join("|")})(?![a-z])`,
);
const DOCUMENT = phrases(DOCUMENT_TYPES);
const PURCHASE_ORDER = sk("purchase order");
/** The line is only a document type, with an optional number: "Quotation", "Receipt 1234", "Credit note CN-7". */
const DOCUMENT_ALONE = new RegExp(
  `^(?:${byLength(DOCUMENT_TYPES)
    .map((w) => escapeRe(sk(w)).replace(/ /g, "\\s+"))
    .join("|")})(?:[ \\t]{1,4}(?:no\\.?|#)?[ \\t]{0,4}[a-z0-9-]{0,30}\\d[a-z0-9-]{0,30})?$`,
);
const ALL_CAPS = (g: string) => !/\p{Ll}/u.test(g) && (g.match(/\p{L}/gu)?.length ?? 0) >= 3;

/**
 * An upper-case word of 3 to 12 letters, in any script, folded to plain ASCII capitals ("\u0415UR" -> "EUR"); a 0 or
 * a 1 among its letters reads as O or I ("V0ID" -> "VOID").
 */
function capitalWords(g: string): { word: string; folded: string }[] {
  const out: { word: string; folded: string }[] = [];
  for (const m of g.matchAll(/(?<![\p{L}\p{N}])[\p{Lu}01]{3,12}(?![\p{L}\p{N}])/gu)) {
    if ((m[0].match(/\p{Lu}/gu)?.length ?? 0) < 2) continue;
    const folded = [...m[0]]
      .map((c) =>
        c === "0" ? "O" : c === "1" ? "I" : c.charCodeAt(0) < 0x80 ? c : foldChar(c).toUpperCase(),
      )
      .join("");
    out.push({ word: m[0], folded: folded.toUpperCase() });
  }
  return out;
}

/** A 0 or a 1 written among letters, read as the letter it looks like ("pa1d" -> "pald", "v0id" -> "vold"). */
const digitLetters = (s: string) =>
  s.replace(/(?<=[a-z])[01]|[01](?=[a-z])/g, (d) => (d === "0" ? "o" : "l"));
const CAPITAL_STAMP: ReadonlySet<string> = new Set(CAPITAL_STAMPS);

/**
 * 1b. A document that is not a payable invoice: its title (the first non-blank line, or a heading in capitals)
 * names another document type, or the text carries a status stamp, a "Status:" line or a status phrase. A field
 * such as "Purchase order: PO-1001" is not a title: an invoice cites its PO.
 */
function notPayable(g: readonly string[], s: readonly string[]): boolean {
  let first = true;
  for (let i = 0; i < g.length; i++) {
    const line = (s[i] ?? "").trim();
    if (line === "") continue;
    // A stamp may carry a date ("PAID 2026-11-01") but no other figure: "Paid 40" is a payment line.
    const undated = digitLetters(line.replace(DATES, " "));
    const bare = /\d/.test(undated) ? "" : undated.replace(/[^a-z]+/g, " ").trim();
    if (STAMP_LINES.has(bare) || STATUS_LINE.test(line) || STATUS_PHRASE.test(line)) return true;
    if (capitalWords(g[i] ?? "").some((w) => CAPITAL_STAMP.has(w.folded))) return true;
    const title = first || ALL_CAPS(g[i] ?? "");
    if (title) {
      const colon = line.indexOf(":");
      const label = colon < 0 ? line : line.slice(0, colon).trim();
      const m = DOCUMENT.exec(label);
      // "Receipt: #1234" or "QUOTATION Q-2026-11" is a title; "Purchase order: PO-1001" is a field, and "From:
      // Quote Masters" names a vendor.
      if (m && !(m[0].replace(/\s+/g, " ") === PURCHASE_ORDER && (!first || colon >= 0)))
        return true;
    }
    if (!line.includes(":")) {
      const alone = DOCUMENT_ALONE.exec(line.replace(/[^a-z0-9#. -]+/g, " ").trim());
      if (alone && !(alone[0].startsWith(PURCHASE_ORDER) && !first)) return true;
    }
    first = false;
  }
  return false;
}

const CURRENCY_WORD = phrases(CURRENCY_WORDS);
const OTHER_DOLLAR = new RegExp(
  `(?<![a-z])(?:${byLength(OTHER_DOLLARS)
    .map((w) => escapeRe(sk(w)).replace(/ /g, "\\s+"))
    .join("|")})\\s+dollars?(?![a-z])`,
);
const OTHER_SYMBOL = /[^\P{Sc}$]/u;
/** "C$100", "HK$100", "NT$100": a dollar sign glued to a country's letters. */
const PREFIXED_DOLLAR = /(?<![A-Za-z])([A-Za-z]{1,3})\$/g;
/** "Currency: EUR", "Invoice currency = eur" (in the skeleton). */
const CURRENCY_FIELD = /(?<![a-z])currenc(?:y|les)\s*[:=]\s*([^\s,;]+)/;
/** NEAR used as a currency: next to a figure, "in NEAR", "NEAR token(s)"; never ".near" in an account id. */
const NEAR_CURRENCY =
  /\d(?:[\d,]{0,20}\d)?(?:\.\d{1,6})?\s?near(?![a-z.])|(?<![a-z.])near\s?\$?\d|(?<![a-z])ln\s{1,4}near(?![a-z.])|(?<![a-z.])near\s{1,4}tokens?(?![a-z])/;

/** A code that is also an ordinary word counts only where it is used as a currency, or stands alone on its line. */
function usedAsCurrency(line: string, code: string): boolean {
  const c = escapeRe(code);
  if (line.replace(/[^\p{L}\p{N}]+/gu, "") === code) return true;
  return new RegExp(
    `(?<![A-Za-z])${c}[ \\t]?\\$?[ \\t]?\\d|\\d(?:[\\d,]{0,20}\\d)?(?:\\.\\d{1,6})?[ \\t]?${c}(?![A-Za-z])|\\(${c}\\)|(?<![A-Za-z])in[ \\t]{1,4}${c}(?![A-Za-z])|(?<![A-Za-z])${c}[ \\t]{1,4}tokens?(?![A-Za-z])|(?<![A-Za-z])${c}\\$`,
  ).test(line);
}

/**
 * 1c. Any currency other than US dollars, anywhere: a currency symbol other than $, an X$ other than US$, an ISO
 * 4217 or token code in capitals, a "Currency:" value other than US dollars, a currency word, another country's
 * dollar.
 */
function otherCurrency(text: string, g: readonly string[], s: readonly string[]): boolean {
  if (OTHER_SYMBOL.test(text)) return true;
  for (const m of text.matchAll(PREFIXED_DOLLAR)) {
    const letters = (m[1] ?? "").toUpperCase();
    if (letters !== "US" && letters !== "USD") return true;
  }
  for (let i = 0; i < g.length; i++) {
    const line = g[i] ?? "";
    for (const w of capitalWords(line)) {
      if (!ISO_CODES.has(w.folded) && !TOKEN_CODES.has(w.folded)) continue;
      if (!WORDLIKE_CODES.has(w.folded) || usedAsCurrency(line, w.word)) return true;
    }
    const sl = s[i] ?? "";
    const field = CURRENCY_FIELD.exec(sl)?.[1];
    if (field !== undefined && !/^(?:us|\$|u\.s)/.test(field)) return true;
    if (CURRENCY_WORD.test(sl) || OTHER_DOLLAR.test(sl) || NEAR_CURRENCY.test(sl)) return true;
  }
  return false;
}

const INVOICE_NOS = new RegExp(INVOICE_NO.source, "gi");
const INVOICE_TOKENS = new RegExp(INVOICE_TOKEN.source, "gi");

/** 1d. The invoice numbers a text states: two different ones are two documents. */
function invoiceNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(INVOICE_NOS)) out.add((m[1] ?? "").toUpperCase());
  for (const m of text.matchAll(INVOICE_TOKENS)) out.add(m[0].toUpperCase());
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 2. The final grammar: [prefix] label [infix] sep amount [tail], on the whole trimmed line (NFKC, any case)
// ---------------------------------------------------------------------------------------------------------------

const words = (list: readonly string[]) =>
  byLength(list)
    .map((w) => escapeRe(w).replace(/ /g, "[ \\t]{1,4}"))
    .join("|");
const PREFIX = `(?:(?<prefix>${words(FINAL_PREFIXES)})[ \\t]{1,4})?`;
const INFIX = `(?<infix>[ \\t]{0,4}(?:${words(INFIXES)}))?`;
/** One bounded separator: spaces, tabs, ":", "=", "|" and dot leaders; a dot never touches the figure. */
const SEP = "(?:[ \\t:=|.]{0,99}[ \\t:=|](?=\\d)|[ \\t:=|.]{1,100}(?=[$u]))";
/** The figure: plain digits or US grouping, with at most 6 decimals. Nothing else is a figure. */
const FIGURE = "(?:\\d{1,3}(?:,\\d{3}){1,4}|\\d{1,15})(?:\\.\\d{1,6})?";
/** The allowed amount forms: $F, US$F, USD F, USDC F, F USD, F USDC, $F USD, $F USDC, and a bare F after an infix. */
const AMOUNT = `(?<amount>\\$[ \\t]?${FIGURE}(?:[ \\t]{1,2}usdc?)?|us[ \\t]?\\$[ \\t]?${FIGURE}|usdc?[ \\t]{0,2}${FIGURE}|${FIGURE}(?:[ \\t]{0,2}usdc?)?)`;
const TAIL =
  "(?<tail>[ \\t]{0,4}(?:[.,;]|\\((?:incl\\.?|including)[ \\t]{1,4}(?<incl>[a-z]{1,15}(?:[ \\t]{1,4}[a-z]{1,15}){0,2})[ \\t]{0,4}\\)|\\(net[ \\t]{1,4}\\d{1,3}\\)|,?[ \\t]{0,4}thank[ \\t]{1,4}you[.!]?))?";
const FINAL_LINE = new RegExp(
  `^${PREFIX}(?<label>${words(FINAL_LABELS)})${INFIX}${SEP}${AMOUNT}${TAIL}[ \\t]*$`,
  "i",
);

const NON_FINAL = `(?:${words(NON_FINAL_LABELS)}|instal{1,2}ment[ \\t]{1,4}\\d{1,3}[ \\t]{1,4}of[ \\t]{1,4}\\d{1,3})`;
const RATE =
  "(?:[ \\t]{0,4}(?:@[ \\t]{0,4})?\\(?[ \\t]{0,2}\\d{1,2}(?:\\.\\d{1,3})?[ \\t]?%[ \\t]{0,2}\\)?)?";
/** As SEP, but a non-final figure may carry a sign ("Discount -$50.00", "Amount paid ($300.00)"): it is never paid. */
const NON_FINAL_SEP =
  "(?:[ \\t:=|.]{0,99}[ \\t:=|](?=[\\d\\-\\u2212(])|[ \\t:=|.]{1,100}(?=[$u\\-\\u2212(]))";
const NON_FINAL_LINE = new RegExp(
  `^(?<nlabel>${NON_FINAL})${RATE}${INFIX}${NON_FINAL_SEP}[-\\u2212(]?${AMOUNT}\\)?${TAIL}[ \\t]*$`,
  "i",
);

const DENIED_INCL: ReadonlySet<string> = new Set([
  ...SCALE_WORDS,
  ...CURRENCY_WORDS,
  ...STATUS_WORDS,
]);

const collapse = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** A non-final line with a non-zero payment, deposit, credit or carried balance in it. */
function isDeduction(m: RegExpExecArray): boolean {
  return DEDUCTION_LABELS.has(collapse(m.groups?.nlabel)) && /[1-9]/.test(m.groups?.amount ?? "");
}

type Final = { key: string; label: string; units: string } | { issue: AmountIssue };

/** Base units of a figure that matched FIGURE, or null when it is not an exact, plain US-dollar amount. */
function unitsOf(figure: string): string | null {
  const [whole = "", frac = ""] = figure.split(".");
  const int = whole.replace(/,/g, "");
  if (int.length > 1 && int.startsWith("0")) return null; // "0100"
  if (!whole.includes(",") && frac.length === 3) return null; // "10.000" may be ten thousand
  const units = BigInt(int) * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0");
  return units > MAX_UNITS ? null : units.toString();
}

/** A line that matched the final grammar: its total, or why it is not an exact US-dollar amount. */
function finalOf(m: RegExpExecArray): Final {
  const gr = m.groups ?? {};
  const amount = gr.amount ?? "";
  const marked = /[$]|usd/i.test(amount);
  if (!marked && gr.infix === undefined) return { issue: "unreadable" }; // the currency marker is required
  const tail = (gr.tail ?? "").trim();
  if (/^[.,;]$/.test(tail) && !/usdc?$/i.test(amount)) return { issue: "unreadable" }; // "$1," then "250.00"
  if (gr.incl?.split(/[ \t]+/).some((w) => DENIED_INCL.has(w.toLowerCase())))
    return { issue: "unreadable" };
  const units = unitsOf(/\d[\d,]*(?:\.\d+)?/.exec(amount)?.[0] ?? "");
  if (units === null) return { issue: "unreadable" };
  return {
    key: collapse(`${gr.prefix ?? ""} ${gr.label ?? ""}`),
    label: collapse(gr.label),
    units,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Every other line that looks payable
// ---------------------------------------------------------------------------------------------------------------

/** "Item Qty Price Total": no digit, and at least three header words (one of them Total), nothing else. */
function isTableHeader(g: string): boolean {
  if (/\p{N}/u.test(g)) return false;
  const tokens = g
    .toLowerCase()
    .split(/[\s|]+/)
    .filter(Boolean);
  const named = tokens.filter((t) => t !== "(usd)" && t !== "(usdc)");
  return named.length >= 3 && named.includes("total") && tokens.every((t) => HEADER_WORDS.has(t));
}

/** A final label used on this line (not a partial total such as "Sub total" or "Tax total"). */
function hasFinalLabel(s: string): boolean {
  const rest = s.replace(PARTIAL, " ");
  return NOUN_LABEL.test(rest) || VERB_LABEL.test(rest);
}

const WORD_BREAK = /[\s:;,=|()[\]{}"'*$<>!?/\\-]+/;
const EDGE_PUNCT = /^[.#_~`]+|[.#_~`]+$/g;
const LOOK_TARGETS = PAYABLE_WORDS.map((w) => w.toLowerCase());

/**
 * A word with a non-ASCII character, or a digit next to a letter, whose form with those characters as wildcards is
 * a payable word ("T\u00f8tal", "T\u0966tal", "Tota1", "Am\u0966unt"). It keeps at least two plain letters, so a word in
 * another script ("\u6771\u4eac\u90fd") is not one.
 */
function hasLookAlike(g: string): boolean {
  // Words end at spaces and at the ASCII separators a label meets ("Tota1:$10.57"); a non-ASCII symbol stays
  // inside the word ("T\u25catal"), so the wildcard sees it.
  for (const raw of g.split(WORD_BREAK)) {
    const cps = [...raw.replace(EDGE_PUNCT, "")];
    if (cps.length < 3 || cps.length > 11) continue;
    let ascii = 0;
    let odd = false;
    let pattern = "";
    for (let i = 0; i < cps.length; i++) {
      const c = cps[i] ?? "";
      if (/^[A-Za-z]$/.test(c)) {
        ascii++;
        pattern += c.toLowerCase();
      } else if (c.charCodeAt(0) >= 0x80) {
        odd = true;
        pattern += ".";
      } else if (
        /^\d$/.test(c) &&
        (/\p{L}/u.test(cps[i - 1] ?? "") || /\p{L}/u.test(cps[i + 1] ?? ""))
      ) {
        odd = true;
        pattern += ".";
      } else pattern += escapeRe(c);
    }
    if (!odd || ascii < 2) continue;
    const re = new RegExp(`^${pattern}$`);
    if (LOOK_TARGETS.some((w) => w.length === cps.length && re.test(w))) return true;
  }
  return false;
}

/**
 * Digits that state no amount: dates, day counts, percentages, and the identifiers the other facts read (invoice
 * numbers, PO references, EVM addresses, NEAR accounts). "Due date: 2026-12-01" or "Pay to 0x52..." holds a
 * payable word but no figure.
 */
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]{0,6}\\.?";
const DATE_FORMS = [
  "\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b",
  "\\b\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}\\b",
  `\\b${MONTH}[ \\t]{1,3}\\d{1,2}(?:st|nd|rd|th)?,?[ \\t]{1,3}\\d{4}\\b`,
  `\\b\\d{1,2}(?:st|nd|rd|th)?[ \\t]{1,3}${MONTH},?[ \\t]{1,3}\\d{4}\\b`,
  `\\b${MONTH}[ \\t]{1,3}\\d{4}\\b`,
];
const DATES = new RegExp(DATE_FORMS.join("|"), "gi");
const NOT_A_FIGURE = new RegExp(
  [
    ...DATE_FORMS,
    "\\b\\d{1,3}[ \\t-]?(?:business[ \\t]+|calendar[ \\t]+|working[ \\t]+)?days?\\b",
    "\\bnet[ \\t-]?\\d{1,3}\\b",
    "\\b\\d{1,2}(?:st|nd|rd|th)\\b",
    "\\d{1,3}(?:\\.\\d{1,3})?[ \\t]?%",
    "\\b0x[0-9a-fA-F]{40}\\b",
    PO_TOKEN.source,
    INVOICE_TOKEN.source,
  ].join("|"),
  "gi",
);
const PO_LABELLED_G = new RegExp(PO_LABELLED.source, "gi");
const MONEY = /[$]|\p{Sc}|(?<![A-Za-z])usdc?(?![A-Za-z])|\d[.,]\d/iu;
/** "Pay to ...", "Remit to ...", "Make checks payable to ...": a payee, with an address, and no amount. */
const PAYEE_LINE =
  /^(?:please\s+)?(?:(?:pay|remlt)(?:\s+payment)?\s+to|make\s+(?:checks?|cheques?|payments?)\s+payable\s+to|payable\s+to)(?![a-z])/;

/** The line with every date, term, percentage and identifier blanked out (each pass is one linear replace). */
function masked(g: string): string {
  const blank = (m: string, id?: string) => (id ? m.replace(id, " ") : m);
  return maskNearAccounts(
    g.replace(NOT_A_FIGURE, " ").replace(PO_LABELLED_G, blank).replace(INVOICE_NOS, blank),
  );
}

/** A line with a payable word and a figure (a digit or a number word that is not a date, term or identifier). */
function payableIsh(g: string, s: string): boolean {
  if (!PAYABLE.test(s) && !GLUED.test(s)) return false;
  if (PAYEE_LINE.test(s.trim()) && !MONEY.test(g) && !NUMBER_WORD.test(s)) return false;
  return /\p{N}/u.test(masked(g)) || NUMBER_WORD.test(s);
}

/** A line that is only an amount ("$9,999.00", "= 470.00 USDC"): a value whose label is on another line. */
const ORPHAN_AMOUNT =
  /^[=:\-\u2212(]?[ \t]*(?:\$|us\$|usdc?)?[ \t]?\d[\d,.]*(?:[ \t]?usdc?)?\)?[ \t]*$/i;

// ---------------------------------------------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------------------------------------------

/** A Markdown table row without its outer pipes ("| Total | $770.00 |"); string methods, so it stays linear. */
function withoutBorders(line: string): string {
  let row = line;
  if (row.startsWith("|")) row = row.slice(1).trimStart();
  if (row.endsWith("|")) row = row.slice(0, -1).trimEnd();
  return row;
}

function read(text: string): AmountRead {
  if (text.length > MAX_READ_UNITS) return refuse("unreadable"); // before any NFKC or numeral work
  const lf = normaliseLineEnds(text);
  // 1a. Text the reader cannot trust.
  if (UNTRUSTED.test(lf)) return refuse("unreadable");
  const shown = nfkc(lf);
  if (shown.length > MAX_READ_UNITS) return refuse("unreadable");
  const g = shown.split("\n");
  const s = g.map(skeletonOf);
  // 1b, 1c, 1d.
  if (notPayable(g, s)) return refuse("not_payable");
  if (otherCurrency(shown, g, s)) return refuse("currency");
  if (invoiceNumbers(shown).size > 1) return refuse("ambiguous");

  const finals: Final[] = [];
  // The line above was ignored but holds a payable word ("Balance", "Please pay today"): a line holding only an
  // amount right after it is that label's value, written in a column.
  let labelAbove = false;
  // A payment, deposit or credit the invoice deducts, or a balance it carries over.
  let deducted = false;
  for (let i = 0; i < g.length; i++) {
    const line = (g[i] ?? "").trim();
    if (line === "") continue;
    const sl = s[i] ?? "";
    const row = withoutBorders(line);
    const final = FINAL_LINE.exec(row);
    const partial = final ? null : NON_FINAL_LINE.exec(row);
    let ignored = false;
    if (final) finals.push(finalOf(final));
    else if (partial) {
      deducted ||= isDeduction(partial); // a partial total or a payment line: never paid
    } else if (isTableHeader(line)) {
      // a column header
    } else if (hasFinalLabel(sl) || hasLookAlike(line) || payableIsh(line, sl)) {
      finals.push({ issue: "unreadable" }); // a payable line the grammar cannot read
    } else if (labelAbove && ORPHAN_AMOUNT.test(line)) {
      finals.push({ issue: "unreadable" });
    } else ignored = true;
    labelAbove = ignored && (PAYABLE.test(sl) || GLUED.test(sl));
  }

  const totals = finals.flatMap((f) => ("units" in f ? [f] : []));
  const keys = new Set(totals.map((f) => f.key));
  if (keys.size < totals.length) return refuse("ambiguous"); // the same final label twice: two documents
  const issue = finals.find((f): f is { issue: AmountIssue } => "issue" in f);
  if (issue) return refuse(issue.issue);
  // After a deduction a plain Total is the amount before it: a balance-type label must say what is left to pay.
  if (deducted && totals.length > 0 && !totals.some((f) => BALANCE_LABELS.has(f.label))) {
    return refuse("ambiguous");
  }
  const values = new Set(totals.map((f) => f.units));
  const [only, ...more] = [...values];
  if (only === undefined) return refuse("not_found");
  if (more.length > 0) return refuse("ambiguous");
  if (only === "0") return refuse("zero");
  return { amount: only, issue: null };
}

/**
 * The invoice amount in USDC base units, failing closed. It returns the single total that every final-total line
 * agrees on, or "0" with the reason. It does not throw: an internal error is "0" with `unreadable`.
 */
export function readAmount(text: string): AmountRead {
  try {
    return read(text);
  } catch {
    return refuse("unreadable");
  }
}
