import {
  CAPITAL_STAMPS,
  CURRENCY_CONTEXT_WORDS,
  CURRENCY_WORDS,
  DEDUCTION_LABELS,
  DOCUMENT_TYPES,
  FINAL_LABELS,
  FINAL_PREFIXES,
  FIRST_WORD_STAMPS,
  GROSS_LABELS,
  HEADER_WORDS,
  INFIXES,
  INVOICE_NO,
  INVOICE_TOKEN,
  ISO_CODES,
  ITEM_COLUMNS,
  LETTER_CURRENCY_SIGNS,
  LOOK_ALIKES,
  MONEY_WORDS,
  maskNearAccounts,
  NON_FINAL_LABELS,
  NOT_PAYABLE_PHRASES,
  NOTE_SCALE_WORDS,
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
  SUMMARY_COLUMNS,
  TITLE_ONLY_TYPES,
  TOKEN_CODES,
  VERB_LABELS,
  WORDLIKE_CODES,
} from "./lexicon";

// The invoice amount reader. The amount it returns is one of two readers the Payables agent needs before it pays
// on its own (the other is an attested model, see owner-confirms.ts), so it is an allowlist: it pays only a total
// stated on a line written in a plain, closed grammar, and refuses everything else as "0" with a reason. The
// order is fixed:
//   1. gates on the whole document: text it cannot trust, a document that is not a payable invoice, another
//      currency, more than one invoice;
//   2. every final-total line must match the final grammar;
//   3. every other line that looks payable must match the non-final grammar;
//   4. all final totals must agree, and a deduction must be settled by a balance written after it.
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

/** A lone surrogate becomes U+FFFD, as UTF-8 encoding does: the reader sees the text the hash and the ledger see. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export const wellFormed = (s: string): string => s.replace(LONE_SURROGATE, "\ufffd");

// ---------------------------------------------------------------------------------------------------------------
// Views of the text: the grammar view (NFKC, as shown), and per line the clean view (no invisible characters or
// marks), the skeleton (detection only) and the unspaced skeleton (letter-spaced words joined).
// ---------------------------------------------------------------------------------------------------------------

const ASCII = /^\p{ASCII}*$/u;
/** A C0 or C1 control other than tab and line feed, a replacement character, or a bidi control. */
const UNTRUSTED = /(?![\t\n])\p{Cc}|[\ufffd\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const NUMERAL_RUNS = /[\p{Nl}\p{No}]+|[^\p{Nl}\p{No}]+/gu;
const NUMERAL = /^[\p{Nl}\p{No}]/u;
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const INVISIBLE_G = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const MARK = /\p{M}/u;
const MARK_G = /\p{M}/gu;
const LETTER = /\p{L}/u;
const ASCII_LETTER = /^[A-Za-z]$/;

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

/** The line without invisible characters and combining marks: "V\u200bOID" is VOID, "E\u00adUR" is EUR. */
const cleanOf = (line: string): string =>
  ASCII.test(line) ? line : line.replace(INVISIBLE_G, "").replace(MARK_G, "");

const FOLD = new Map<string, string>();
for (const [to, from] of Object.entries(LOOK_ALIKES)) for (const c of from) FOLD.set(c, to);

/** The skeleton spelling of a plain ASCII word or phrase: lower case, with i and | folded to l. */
export const sk = (s: string): string => s.toLowerCase().replace(/[i|]/g, "l");

/** foldChar's answers, so a long text in one script folds each distinct character once (bounded). */
const FOLDED = new Map<string, string>();

/** The plain letter a character looks like (lower case, i as l), or the character itself. */
function foldChar(ch: string): string {
  const look = FOLD.get(ch);
  if (look !== undefined) return look;
  const known = FOLDED.get(ch);
  if (known !== undefined) return known;
  const folded = foldLetter(ch);
  if (FOLDED.size < 4096) FOLDED.set(ch, folded);
  return folded;
}

function foldLetter(ch: string): string {
  if (LETTER.test(ch)) {
    const base = ch.normalize("NFD")[0] ?? ch;
    if (base !== ch && ASCII_LETTER.test(base)) return sk(base);
    // A capital that is not in the table folds through its lower case ("\u0141" -> "\u0142" -> l).
    const lower = ch.toLowerCase();
    const again = FOLD.get(lower);
    if (again !== undefined) return again;
    if (ASCII_LETTER.test(lower)) return sk(lower);
    return lower;
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

/** The skeleton of a whole text (the duplicate guard reads its fingerprint through it). */
export const skeleton = (text: string): string => skeletonOf(text);

/** Runs of three or more single letters, one separator apart: "t o t a l", "t.o.t.a.l", "p a l d". */
const SPACED = /(?<![a-z])[a-z](?:[ .'\u00b7\u2019-][a-z]){2,}(?![a-z])/g;
/** The skeleton with letter-spaced words joined ("t o t a l   $5" -> "total   $5"). */
const unspaced = (s: string): string => s.replace(SPACED, (m) => m.replace(/[^a-z]/g, ""));

/** A 0 or a 1 written among letters, read as the letter it looks like ("pa1d" -> "pald", "v0id" -> "vold"). */
const digitLetters = (s: string) =>
  s.replace(/(?<=[a-z])[01]|[01](?=[a-z])/g, (d) => (d === "0" ? "o" : "l"));

// ---------------------------------------------------------------------------------------------------------------
// Word patterns on the skeleton
// ---------------------------------------------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const byLength = (words: readonly string[]) => [...words].sort((a, b) => b.length - a.length);
const alternation = (words: readonly string[]) =>
  byLength(words)
    .map((w) => escapeRe(sk(w)).replace(/ /g, "\\s+"))
    .join("|");
/** Whole words or phrases of the skeleton (spaces between words match any run of spaces). */
const phrases = (words: readonly string[], flags = "") =>
  new RegExp(`(?<![a-z])(?:${alternation(words)})(?![a-z])`, flags);

const PAYABLE = phrases(PAYABLE_WORDS);
const PAYABLE_G = phrases(PAYABLE_WORDS, "g");
const MONEY_WORD = phrases(MONEY_WORDS);
const MONEY_WORD_G = phrases(MONEY_WORDS, "g");
/** Compound nouns that are not payable words ("Due diligence"; "Accounts payable" before another word). */
const NOT_PAYABLE = new RegExp(
  `(?<![a-z])(?:${alternation(NOT_PAYABLE_PHRASES)}|accounts\\s+payable(?=\\s+[a-z]))(?![a-z])`,
  "g",
);
/** A final-label word glued to other letters ("Grandtotal", "Totals", "amountdue"), but not "Subtotal". */
const GLUED =
  /(?<![a-z])(?!subtotals?(?![a-z]))(?:[a-z]+total[a-z]*|total[a-z]+|amountdue|balancedue|amountpayable|amountowlng|amountremalnlng|balanceremalnlng|outstandlngbalance)(?![a-z])/;
const GLUED_G = new RegExp(GLUED.source, "g");
const NUMBER_WORD = phrases(NUMBER_WORDS);
const PARTIAL = phrases(PARTIAL_PHRASES, "g");
const NOUN_LABEL = phrases(FINAL_LABELS.filter((l) => !VERB_LABELS.has(l)));
const NOUN_LABEL_G = phrases(
  FINAL_LABELS.filter((l) => !VERB_LABELS.has(l)),
  "g",
);
/** A verb-phrase label ("Please pay") is a label only when a separator, a currency or a figure follows it. */
const VERB_LABEL = new RegExp(
  `(?<![a-z])(?:${alternation([...VERB_LABELS])})(?:\\s*(?:\\(usdc?\\)|ln\\s+usdc?))?(?=\\s*(?:$|[:=|.\\t]|\\$|\\d|us))`,
);

const count = (re: RegExp, s: string): number => {
  let n = 0;
  for (const _ of s.matchAll(re)) n++;
  return n;
};
/** How many payable words, money words, final labels and glued labels a skeleton holds. */
const labelWords = (s: string): number =>
  count(PAYABLE_G, s) + count(MONEY_WORD_G, s) + count(NOUN_LABEL_G, s) + count(GLUED_G, s);

/** Words a split or letter-spaced label joins into ("To tal", "Bal ance", "Tot-" + "al"). */
const JOIN_TARGETS: ReadonlySet<string> = new Set(
  [...PAYABLE_WORDS, ...MONEY_WORDS.filter((w) => !w.includes(" ") && w.length >= 4)].map(sk),
);
/** Two words, one separator apart, as (first, second) with the second taken by a lookahead (pairs overlap). */
const WORD_PAIR = /(?<![a-z])([a-z]{2,12})(?=[ .'\u00b7\u2019-]([a-z]{2,12})(?![a-z]))/g;

/**
 * 11. A label written so that it reads only once its pieces are joined: letter-spaced ("T o t a l"), split by a
 * space, a dot, a hyphen or an apostrophe ("To tal", "To-tal"), or with "rn" for "m" ("Arnount"). It is odd, so
 * the invoice is unreadable.
 */
function oddLabel(s: string, unspacedLine: string): boolean {
  // The unspaced view is computed once per line; only a line it changes, or one with "rn", can hide a label.
  if (unspacedLine !== s || s.includes("rn")) {
    const variant = unspaced(s).replace(/rn/g, "m");
    if (variant !== s && labelWords(variant) > labelWords(s)) return true;
  }
  for (const m of s.matchAll(WORD_PAIR)) {
    if (JOIN_TARGETS.has(`${m[1]}${m[2]}`)) return true;
  }
  return false;
}

/** A label split across a line end: "Tot-" or "To" at the end of one line, "al" or "tal" opening the next. */
function splitAcrossLines(s: string, next: string): boolean {
  // The last word of the line, read backwards by hand (a regex anchored at the end would scan the whole line).
  const isLetter = (c: number) => c >= 97 && c <= 122;
  let end = s.length;
  while (end > 0 && /\s/.test(s[end - 1] ?? "")) end--;
  const hyphen = end > 0 && s[end - 1] === "-";
  if (hyphen) end--;
  let start = end;
  while (start > 0 && isLetter(s.charCodeAt(start - 1))) start--;
  const tail = s.slice(start, end);
  if (tail === "" || tail.length > 12 || (!hyphen && tail.length > 4)) return false;
  const head = /^\s*([a-z]{1,12})(?![a-z])/.exec(next)?.[1];
  return head !== undefined && JOIN_TARGETS.has(`${tail}${head}`);
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Gates on the whole document
// ---------------------------------------------------------------------------------------------------------------

/** The per-line views every gate reads. */
interface Views {
  /** The raw text (line ends normalised), before NFKC: some currency signs become letters under NFKC. */
  raw: string;
  /** The NFKC text, split into lines. */
  g: readonly string[];
  /** Each line without invisible characters and marks. */
  c: readonly string[];
  /** Each line's skeleton. */
  s: readonly string[];
  /** Each line's skeleton with letter-spaced words joined and 0/1 among letters read as letters. */
  u: readonly string[];
  /** Each line's match of the non-final grammar (a money line, which no status phrase refuses), or null. */
  nonFinal: readonly (RegExpExecArray | null)[];
  /** Each clean line with letter-spaced capitals joined ("V O I D" -> "VOID"), and its words in capitals. */
  cu: readonly string[];
  capitals: readonly CapitalWord[][];
}

const STAMP_LINES: ReadonlySet<string> = new Set(STAMPS.map(sk));
/** "Paid by", "paid on", "paid via", "paid with": a payment already made ("to be paid by" is an instruction). */
const PAID_HOW = /(?<![a-z])(?<!\bbe\s{1,4})pald\s{1,4}(?:by|on|vla|wlth)(?![a-z])/;
const STATUS_PHRASE = phrases(STATUS_PHRASES);
/** "Status: Paid", "| Status | Paid |", "Status \u2013 Paid", "Status:     **Paid**". */
const STATUS_LINE = new RegExp(
  `^[\\W_]{0,10}(?:(?:lnvolce|payment)[ \\t]{1,4})?status(?:[ \\t:=|*\\-\\u2013\\u2014]{0,20})(?:${alternation(STATUS_VALUES)})(?![a-z])`,
);
const FIRST_WORD_STAMP = new RegExp(`^[\\W_]{0,10}(?:${alternation(FIRST_WORD_STAMPS)})(?![a-z])`);
/** A stamp behind a separator, ending the line: "INVOICE INV-90 - Void", "Invoice 12 | PAID", "Status \u2013 Paid". */
const SEPARATED_STAMP = new RegExp(`[\\-\\u2013\\u2014|:]\\s*(?:${alternation(STAMPS)})\\W*$`);
const DOCUMENT = phrases(DOCUMENT_TYPES);
const TITLE_DOCUMENT = phrases([...DOCUMENT_TYPES, ...TITLE_ONLY_TYPES]);
/** "Purchase order: PO-1001", "Purchase order no. 7781", "PURCHASE ORDER #4471-A": an invoice citing its PO. */
const PO_FIELD =
  /(?<![a-z])purchase\s+order\s*(?:no\.?|number|#|:)[\s:#.-]{0,6}[a-z0-9][a-z0-9/-]{0,31}\d/;
/** Off the first line, "Purchase order PO-1001" cites the PO too (on the first line it is the title). */
const PO_LOOSE = /(?<![a-z])purchase\s+order\s+(?:po)?-?\d[a-z0-9-]{0,30}/;
/** "Payment due upon receipt", "Due on receipt": a payment term, not a receipt. */
const ON_RECEIPT = /(?<![a-z])(?:upon|on|of)\s+recelpt(?![a-z])/g;
/** "From: Quote Masters Inc", "Vendor: ...": a name field, which may hold any word. */
const NAME_FIELD =
  /^\W{0,4}(?:from|vendor|suppller|payee|blll\s+from|blll\s+to|bllled\s+to|shlp\s+to|cllent|customer|company|attn)\s*:/;
/** A type word written as the title of what follows: "Credit Note for invoice INV-1", "Receipt #1234". */
const DOCUMENT_REF = new RegExp(
  `(?<![a-z])(?:${alternation(DOCUMENT_TYPES)})\\s*(?:for\\s+(?:lnvolce|lnv)|#|no\\.?\\s*\\d|number\\s*\\d)`,
);
/** The line is only a document type, with an optional number: "Quotation", "Receipt 1234", "Credit note CN-7". */
const DOCUMENT_ALONE = new RegExp(
  `^(?:${alternation(DOCUMENT_TYPES)})(?:[ \\t]{1,4}(?:no\\.?|#)?[ \\t]{0,4}[a-z0-9-]{0,30}\\d[a-z0-9-]{0,30})?$`,
);
/** The words the status and title checks look for (each phrase holds at least one of them), in skeleton spelling. */
const STATUS_OR_TYPE: ReadonlySet<string> = new Set(
  [
    ...new Set(
      [
        ...STAMPS,
        ...STATUS_PHRASES,
        ...STATUS_VALUES,
        ...FIRST_WORD_STAMPS,
        ...DOCUMENT_TYPES,
        ...TITLE_ONLY_TYPES,
      ]
        .flatMap((p) => p.split(/[ -]/))
        .filter(
          (w) =>
            w.length >= 3 &&
            !["not", "for", "the", "this", "has", "been", "you", "your", "was", "only"].includes(w),
        ),
    ),
    "status",
  ].map(sk),
);
/** The letter words of a skeleton line. */
const wordsOf = (s: string): string[] => s.match(/[a-z]+/g) ?? [];
/** A heading: a short line with no figure (at most six words). */
const isHeading = (u: string) => !/\d/.test(u) && u.trim().split(/\s+/).length <= 6;

/**
 * An upper-case word of 3 to 12 letters, in any script, folded to plain ASCII capitals ("\u0415UR" -> "EUR"). A 0 or a 1
 * among its letters reads as O or I ("V0ID"), and an I or l look-alike (or a plain l among capitals) reads as I or
 * L, whichever matches ("VO\u0406D" -> "VOID", "\u0406NR" -> "INR"). Run it on the clean view.
 */
const L_LIKE = `l${escapeRe(LOOK_ALIKES.l ?? "").replace(/-/g, "\\-")}`;
const CAPITAL_RUN = new RegExp(
  `(?<![\\p{L}\\p{N}])[\\p{Lu}01${L_LIKE}]{3,12}(?![\\p{L}\\p{N}])`,
  "gu",
);
const L_LIKE_SET: ReadonlySet<string> = new Set([...`l${LOOK_ALIKES.l ?? ""}`]);
const PLAIN_CAPITALS = /^[A-Z]+$/;

interface CapitalWord {
  word: string;
  /** Where the word ends in the line. */
  end: number;
  /** Every spelling it may stand for (I and L look-alikes give both). */
  spellings: string[];
}

function capitalWords(c: string): CapitalWord[] {
  const out: CapitalWord[] = [];
  for (const m of c.matchAll(CAPITAL_RUN)) {
    const w = m[0];
    const end = (m.index ?? 0) + w.length;
    if (PLAIN_CAPITALS.test(w)) {
      out.push({ word: w, end, spellings: [w] }); // the common case: plain ASCII capitals
      continue;
    }
    if ((w.match(/\p{Lu}/gu)?.length ?? 0) < 2) continue;
    let spellings = [""];
    for (const ch of w) {
      let options: string[];
      if (ch === "0") options = ["O"];
      else if (ch === "1") options = ["I"];
      else if (/^[A-Z]$/.test(ch)) options = [ch];
      else if (L_LIKE_SET.has(ch) || foldChar(ch) === "l")
        options = ["I", "L"]; // "\u0130", "\u00cd" too
      else options = [foldChar(ch).toUpperCase()];
      if (spellings.length * options.length > 8) options = options.slice(0, 1);
      spellings = spellings.flatMap((p) => options.map((o) => p + o));
    }
    out.push({ word: w, end, spellings });
  }
  return out;
}

const CAPITAL_STAMP: ReadonlySet<string> = new Set(CAPITAL_STAMPS);

/**
 * 1b. A document that is not a payable invoice:
 *   - a document type in the title (the first five lines), in a heading, or as "<type> for invoice" or
 *     "<type> #"; a name field ("From: Quote Masters") and an invoice's own PO reference are not titles;
 *   - a stamp line, a capital stamp (PAID unless the line is a money line), a stamp word that starts a line,
 *     a "Status:" line, or a status phrase (a money line such as "Payment received $400.00" is exempt).
 * Every check runs on the unspaced skeleton, so "P A I D", "R E C E I P T" and "RECE1PT" are seen.
 */
function notPayable(v: Views): boolean {
  let n = 0;
  let previousHeading: string | null = null;
  for (let i = 0; i < v.g.length; i++) {
    const u = (v.u[i] ?? "").trim();
    if (u === "") continue;
    n++;
    const money = v.nonFinal[i] !== null;
    const capitals = v.capitals[i] ?? [];
    if (
      capitals.some((w) =>
        w.spellings.some((s) => CAPITAL_STAMP.has(s) && !(s === "PAID" && money)),
      )
    )
      return true;
    // Every check below looks for one of these words; most lines (items, totals) hold none.
    if (!wordsOf(u).some((w) => STATUS_OR_TYPE.has(w))) {
      previousHeading = null;
      continue;
    }
    // A stamp may carry a date ("PAID 2026-11-01") but no other figure: "Paid 40" is a payment line.
    const undated = u.replace(DATES, " ");
    const bare = /\d/.test(undated) ? "" : undated.replace(/[^a-z]+/g, " ").trim();
    if (STAMP_LINES.has(bare) || STATUS_LINE.test(u)) return true;
    if (
      !money &&
      (STATUS_PHRASE.test(u) ||
        PAID_HOW.test(u) ||
        FIRST_WORD_STAMP.test(u) ||
        SEPARATED_STAMP.test(undated))
    )
      return true;
    // Titles. Markdown heading marks go; a name field and a cited PO are not titles; "upon receipt" is a term.
    const text = u.replace(/^#+\s*/, "").replace(ON_RECEIPT, " ");
    const named = NAME_FIELD.test(text);
    const withoutPo = (n > 1 ? text.replace(PO_LOOSE, " ") : text).replace(PO_FIELD, " ");
    // The first five lines are the title, but a money line among them (lines 2 to 5) is no title.
    const titleLine = n === 1 || (n <= 5 && !moneyToken(v.g[i] ?? ""));
    if (!named && titleLine && TITLE_DOCUMENT.test(withoutPo)) return true;
    if (!named && DOCUMENT_REF.test(withoutPo)) return true;
    if (
      !text.includes(":") &&
      DOCUMENT_ALONE.test(withoutPo.replace(/[^a-z0-9#. -]+/g, " ").trim())
    )
      return true;
    const heading = isHeading(withoutPo);
    if (heading && !named && DOCUMENT.test(withoutPo)) return true;
    // A title split over two heading lines ("CREDIT" / "NOTE").
    if (heading && previousHeading !== null && DOCUMENT.test(`${previousHeading} ${withoutPo}`))
      return true;
    previousHeading = heading && !named ? withoutPo : null;
  }
  return false;
}

/** Letter-spaced capitals joined ("V O I D" -> "VOID"), on the clean view. */
const unspacedCapitals = (c: string): string =>
  c.replace(/(?<![\p{L}\p{N}])\p{Lu}(?:[ .'\u00b7-]\p{Lu}){2,}(?![\p{L}\p{N}])/gu, (m) =>
    m.replace(/[^\p{Lu}]/gu, ""),
  );

const CURRENCY_WORD = phrases(CURRENCY_WORDS);
/** "Canadian dollars", "Australian $", "Canadian funds", "AU dollars", "Kiwi dollars", "dollars canadiens". */
const OTHER_DOLLAR = new RegExp(
  `(?<![a-z])(?:(?:${alternation(OTHER_DOLLARS.filter((w) => w.length > 2))})\\.?\\s*(?:dollars?|\\$|funds|currency)|(?:${alternation(OTHER_DOLLARS.filter((w) => w.length <= 2))})\\s+dollars?|dollars?\\s+(?:canad|austral|n[e\u00e9]o)[a-z]*)(?![a-z])`,
);
const OTHER_SYMBOL = /[^\P{Sc}$]/u;
const LETTER_SIGN = new RegExp(`[${LETTER_CURRENCY_SIGNS}]`);
/** "C$100", "HK$100", "NT$100", "Cdn.$": a dollar sign glued to a country's letters. */
const PREFIXED_DOLLAR = /(?<![A-Za-z])([A-Za-z]{1,3})\.?\$/g;
/** "C $100", "NZ $", "$ CA", "$AU": another dollar written with one space, or after the sign. */
const SPACED_DOLLAR =
  /(?<![A-Za-z])(?:C|CA|CAD|CDN|Cdn|AU|NZ|HK|SG|NT|MX|R)\s\$|\$\s?(?:CA|AU|NZ|HK|SG|NT|MX)(?![A-Za-z])/;
/** "Rs 500", "in Rs.", "500 kr", "RM 20", "Rp 10.000", "z\u0142", "K\u010d", "CDN": a currency written short. */
const SHORT_CURRENCY =
  /(?:(?<![A-Za-z])(?:Rs|Rs\.|kr|kr\.|Kr|RM|Rp|CDN|Cdn)(?=\s?\d)|(?<=\d\s?)(?:Rs|kr|RM|Rp)(?![A-Za-z])|(?<![A-Za-z])(?:in|en|are)\s(?:Rs|kr|RM|Rp|CDN|Cdn)\b\.?|z\u0142(?![a-z])|K\u010d(?![a-z]))/;
/** "Currency: EUR", "Currency code - CAD", "CURRENCY\tPHP", "Invoice currency = eur" (on the skeleton). */
const CURRENCY_FIELD =
  /(?<![a-z])currenc(?:y|les)(?:\s+(?:code|type))?(\s*[:=]\s*|[\s|\-\u2013\u2014]+)([^\s,;]+)(?:\s+([a-z]+))?/;
/** The value of a currency field that names US dollars. */
const US_VALUE = /^(?:usdc?|us\$?|u\.s\.?|\$)$/;
/** NEAR used as a currency: next to a figure, "in NEAR", "NEAR token(s)"; never ".near" in an account id. */
const NEAR_CURRENCY =
  /\d(?:[\d,]{0,20}\d)?(?:\.\d{1,6})?\s?near(?![a-z.])|(?<![a-z.])near\s?\$?\d|(?<![a-z])ln\s{1,4}near(?![a-z.])|(?<![a-z.])near\s{1,4}tokens?(?![a-z])/;
const CONTEXT_WORD = phrases(CURRENCY_CONTEXT_WORDS);
/** A word every match of CURRENCY_TEXT holds (skeleton spelling): it is run only on a line with one. */
const CURRENCY_TRIGGERS: ReadonlySet<string> = new Set(
  [
    ...CURRENCY_WORDS,
    ...OTHER_DOLLARS.flatMap((w) => w.split(" ")),
    "dollar",
    "dollars",
    "near",
    "tokens",
    "token",
  ].map(sk),
);
/** A currency word, another country's dollar or NEAR used as a currency, in one pass. */
const CURRENCY_TEXT = new RegExp(
  [CURRENCY_WORD.source, OTHER_DOLLAR.source, NEAR_CURRENCY.source].join("|"),
);
/** A code glued to a figure: "70EUR", "EUR70", "1.000,00EUR". */
const GLUED_CODE = /(?<![A-Za-z])([A-Z]{3,5})(?=\d)|(?<=\d)([A-Z]{3,5})(?![A-Za-z])/g;
/** A word in letters only, in any case (for lower- and title-case codes). */
const WORD = /(?<!\p{L})[A-Za-z]{3,5}(?!\p{L})/gu;

/** The strict contexts of a code used as a currency, compiled once per code (no RegExp per word). */
const CODE_USE = new Map<string, RegExp>();
function codeUse(code: string): RegExp {
  let re = CODE_USE.get(code);
  if (re === undefined) {
    const c = escapeRe(code);
    // NEAR right after USDC in brackets names the network ("USDC (NEAR)"), not a currency.
    const bracket = code === "NEAR" ? `(?<!usdc?[ \\t]?)\\(${c}\\)` : `\\(${c}\\)`;
    re = new RegExp(
      `(?<![A-Za-z])${c}[ \\t]?\\$?[ \\t]?\\d|\\d(?:[\\d,]{0,20}\\d)?(?:\\.\\d{1,6})?[ \\t]?${c}(?![A-Za-z])|${bracket}|(?<![A-Za-z])in[ \\t]{1,4}${c}(?![A-Za-z])|(?<![A-Za-z])${c}[ \\t]{1,4}tokens?(?![A-Za-z])|(?<![A-Za-z])${c}\\$|\\$[ \\t]?${c}(?![A-Za-z])`,
      "i",
    );
    CODE_USE.set(code, re);
  }
  return re;
}

const isCode = (s: string) => ISO_CODES.has(s) || TOKEN_CODES.has(s);

/**
 * A word in capitals on this line that is a code used as a currency (see otherCurrency). `prose`: some other word
 * of the document is written in capitals. Each code is tested once per line, so the line is read in linear time.
 */
function wordInCapitalsIsCurrency(
  c: string,
  sl: string,
  words: readonly CapitalWord[],
  prose: boolean,
): boolean {
  const codes = words.flatMap((w) => w.spellings.filter(isCode).slice(0, 1));
  if (codes.length === 0) return false;
  const onlyCodes =
    codes.length === words.length &&
    codes.some((x) => x !== "NEAR") &&
    c.replace(/[\p{Lu}\s\t|,/;:.()-]+/gu, "") === "";
  const cells =
    !/\d/.test(c) && c.includes("\t") ? new Set(c.split("\t").map((x) => x.trim())) : null;
  const context = CONTEXT_WORD.test(sl) || /(?<![a-z])are\s/.test(sl);
  for (const code of new Set(codes)) {
    if (!WORDLIKE_CODES.has(code)) return true;
    if (codeUse(code).test(c)) return true;
    if (code === "NEAR") continue;
    if (onlyCodes) return true; // a line of codes
    if (cells?.has(code)) return true; // a cell of a header row
    if (code === "ALL") continue; // "ALL PRICES IN USD": only the strict contexts above
    if (context || !prose) return true;
  }
  return false;
}

/**
 * 1c. Any currency other than US dollars, anywhere:
 *   - a currency sign other than $ (in the raw text and after NFKC), or a CJK or Hangul currency letter;
 *   - an X$ other than US$, another country's dollar, its abbreviation or nickname;
 *   - an ISO 4217 or token code in capitals, glued to a figure, or in lower or title case in a currency context;
 *   - a currency field other than US dollars, a currency word, NEAR used as a currency.
 * A code that is also a word (CAD, PHP, TRY, ...) counts only in a currency context: next to a figure, in
 * brackets, after "in", as "$X", in a currency field, as a cell of a header row, on a line of codes or of currency
 * words ("All prices CAD"), or anywhere when no other word of the document is written in capitals. NEAR keeps its
 * own narrow contexts, so "USDC on NEAR" is the network.
 */
function otherCurrency(v: Views, shown: string): boolean {
  if (OTHER_SYMBOL.test(v.raw) || OTHER_SYMBOL.test(shown) || LETTER_SIGN.test(shown)) return true;
  // On the skeleton too, so a look-alike letter ("\u0421$") is seen.
  for (const view of [shown, v.s.join("\n")]) {
    for (const m of view.matchAll(PREFIXED_DOLLAR)) {
      const letters = (m[1] ?? "").toUpperCase();
      if (letters !== "US" && letters !== "USD") return true;
    }
  }
  if (SPACED_DOLLAR.test(shown) || SHORT_CURRENCY.test(shown)) return true;

  // Words in capitals per line, once; "upper-case prose" is a capital word that is no code and no identifier.
  const capitals = v.capitals;
  let prose = false;
  for (let i = 0; i < capitals.length && !prose; i++) {
    const c = v.cu[i] ?? "";
    for (const m of capitals[i] ?? []) {
      if (m.spellings.some((x) => isCode(x) || x === "USD" || x === "USDC")) continue;
      if (/^[-#]?\d/.test(c.slice(m.end, m.end + 2))) continue; // "INV-1": an identifier
      prose = true;
      break;
    }
  }

  for (let i = 0; i < v.g.length; i++) {
    const c = v.c[i] ?? "";
    const sl = v.s[i] ?? "";
    const words = capitals[i] ?? [];
    if (words.length > 0 && wordInCapitalsIsCurrency(c, sl, words, prose)) return true;
    // Glued to a figure, in any case of the letters ISO writes in capitals.
    for (const m of /[A-Z]\d|\d[A-Z]/.test(c) ? c.matchAll(GLUED_CODE) : []) {
      const code = m[1] ?? m[2] ?? "";
      if (isCode(code) && code !== "USDC" && code !== "USD") return true;
    }
    // Lower or title case: after "in", next to a figure, in a field; a word-like code also needs a context word.
    for (const m of c.matchAll(WORD)) {
      const w = m[0];
      if (w === w.toUpperCase()) continue; // capitals were read above
      const code = w.toUpperCase();
      if (!isCode(code)) continue;
      const before = c.slice(Math.max(0, (m.index ?? 0) - 6), m.index ?? 0);
      const after = c.slice((m.index ?? 0) + w.length, (m.index ?? 0) + w.length + 4);
      const used =
        /(?:^|\W)(?:in|en)\s{1,3}$/i.test(before) || /\d\s?$/.test(before) || /^\s?\d/.test(after);
      if (!used) continue;
      if (code === "NEAR") continue; // NEAR_CURRENCY reads it below
      if (!WORDLIKE_CODES.has(code) || CONTEXT_WORD.test(sl)) return true;
    }
    const field = sl.includes("currenc") ? CURRENCY_FIELD.exec(sl) : null;
    if (field) {
      const value = (field[2] ?? "").replace(/[*_]+/g, "");
      const strict = /[:=]/.test(field[1] ?? "");
      const named = value.replace(/^\$/, "");
      const isUs =
        US_VALUE.test(value) ||
        (value === "us" && /^dollars?$/.test(field[3] ?? "")) ||
        value === "";
      // "Currency: X" names the currency: anything but US dollars refuses. "Currency X" (no colon) refuses a
      // code, a currency word, or a "$" with letters ("$CAD").
      if (strict && !isUs) return true;
      if (
        !strict &&
        (isCode(named.toUpperCase()) ||
          CURRENCY_WORD.test(named) ||
          (/^\$[a-z]/.test(value) && !/^\$us/.test(value)))
      )
        return true;
    }
    if (wordsOf(sl).some((w) => CURRENCY_TRIGGERS.has(w)) && CURRENCY_TEXT.test(sl)) return true;
  }
  return false;
}

const INVOICE_NOS = new RegExp(INVOICE_NO.source, "gi");
const INVOICE_TOKENS = new RegExp(INVOICE_TOKEN.source, "gi");

/** 1d. The invoice numbers a text states (read on the view without invisible characters and with dashes folded). */
export function invoiceNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(INVOICE_NOS)) out.add((m[1] ?? "").toUpperCase());
  for (const m of text.matchAll(INVOICE_TOKENS)) out.add(m[0].toUpperCase());
  return out;
}

/** Every Unicode dash and the minus sign, read as "-". */
const DASHES = /[\p{Pd}\u2212]/gu;
/** The text a number is read from: invisible characters removed, every dash as "-", every space as " ". */
export const numberView = (text: string): string =>
  ASCII.test(text)
    ? text
    : text
        .replace(INVISIBLE_G, "")
        .replace(DASHES, "-")
        .replace(/\p{Zs}/gu, " ");

/** A document header: an "INVOICE" or "BILL" title (alone or with a number), a "From:" or a "Bill to:" line. */
const HEADER_KINDS: readonly [string, RegExp][] = [
  [
    "title",
    /^\W{0,4}(?:tax\s+)?(?:lnvolce|blll)(?:[ \t]{0,4}#?[ \t]{0,4}[a-z0-9/-]{0,32}\d[a-z0-9/-]{0,32})?\W{0,4}$/,
  ],
  ["from", /^\W{0,4}from\s*:/],
  ["bill to", /^\W{0,4}(?:blll|bllled)\s+to(?![a-z])/],
];

/**
 * 1d. Two documents in one text: a header repeated, with a final total after each copy. A two-page invoice that
 * repeats its title states its total once, after the last copy, and reads.
 */
function twoDocuments(s: readonly string[], finalAt: readonly number[]): boolean {
  const finals = new Set(finalAt);
  for (const [, re] of HEADER_KINDS) {
    // One pass: count the headers that have a final total after them, before the next header.
    let headers = 0;
    let segments = 0;
    let open = false;
    for (let i = 0; i < s.length; i++) {
      if (re.test((s[i] ?? "").trim())) {
        headers++;
        open = true;
      } else if (open && finals.has(i)) {
        segments++;
        open = false;
      }
    }
    if (headers >= 2 && segments >= 2) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// 2. The final grammar: [prefix] label [qualifier] [infix] sep amount [tail], on the whole trimmed line
// ---------------------------------------------------------------------------------------------------------------

const words = (list: readonly string[]) =>
  byLength(list)
    .map((w) => escapeRe(w).replace(/ /g, "[ \\t]{1,4}"))
    .join("|");
const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DATE_FORMS = [
  "\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b",
  "\\b\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}\\b",
  `\\b${MONTH}[ \\t]{1,3}\\d{1,2}(?:st|nd|rd|th)?,?[ \\t]{1,3}\\d{4}\\b`,
  `\\b\\d{1,2}(?:st|nd|rd|th)?[ \\t]{1,3}${MONTH},?[ \\t]{1,3}\\d{4}\\b`,
  `\\b${MONTH}[ \\t]{1,3}\\d{4}\\b`,
  `\\b\\d{1,2}[-/ ]${MONTH}[-/ ]\\d{4}\\b`,
];
const DATES = new RegExp(DATE_FORMS.join("|"), "gi");
/** One date, for a qualifier and a due-by line: "December 1, 2026", "1 Dec 2026", "01-Dec-2026", "2026-12-01". */
const A_DATE = `(?:${MONTH}[ \\t]{1,3}\\d{1,2}(?:st|nd|rd|th)?,?[ \\t]{1,3}\\d{4}|\\d{1,2}[ \\t-]${MONTH}[ \\t-]\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{2,4})`;

const PREFIX = `(?:(?<prefix>${words(FINAL_PREFIXES)})[ \\t]{1,4})?`;
/** What a final label may say after it: when it is due, or that it includes tax. Same label, so they compete. */
const QUALIFIER = `(?<qual>[ \\t]{1,4}(?:\\(?(?:incl\\.?|including)[ \\t]{1,4}(?:sales[ \\t]{1,4})?(?:tax|vat|gst)\\)?|(?:upon|on)[ \\t]{1,4}receipt|(?:on|by)[ \\t]{1,4}${A_DATE}))?`;
const INFIX = `(?<infix>[ \\t]{0,4}(?:${words(INFIXES)}))?`;
/** One bounded separator: spaces, tabs, ":", "=", "|" and dot leaders; a dot never touches the figure. */
const SEP = "(?:[ \\t:=|.]{0,99}[ \\t:=|](?=\\d)|[ \\t:=|.]{1,100}(?=[$u]))";
/** The figure: plain digits or US grouping, with at most 6 decimals. Nothing else is a figure. */
const FIGURE = "(?:\\d{1,3}(?:,\\d{3}){1,4}|\\d{1,15})(?:\\.\\d{1,6})?";
/**
 * The allowed amount forms: $F, US$F, USD $F, USD F, USDC F, F USD, F USDC, $F USD, $F USDC, and a bare F (a figure
 * with no marker counts only after a currency infix, or to corroborate a marked total).
 */
const AMOUNT = `(?<amount>\\$[ \\t]?${FIGURE}(?:[ \\t]{1,2}usdc?)?|us[ \\t]?\\$[ \\t]?${FIGURE}|usdc?[ \\t]{1,2}\\$[ \\t]?${FIGURE}|usdc?[ \\t]{0,2}${FIGURE}|${FIGURE}(?:[ \\t]{0,2}usdc?)?)`;
const TAIL =
  "(?<tail>[ \\t]{0,4}(?:\\(usdc?\\)|[.,;]|\\((?:incl\\.?|including)[ \\t]{1,4}(?<incl>[a-z]{1,15}(?:[ \\t]{1,4}[a-z]{1,15}){0,2})[ \\t]{0,4}\\)|\\(net[ \\t]{1,4}\\d{1,3}\\)|,?[ \\t]{0,4}thank[ \\t]{1,4}you[.!]?))?";
const FINAL_LINE = new RegExp(
  `^${PREFIX}(?<label>${words(FINAL_LABELS)})${QUALIFIER}${INFIX}${SEP}${AMOUNT}${TAIL}[ \\t]*$`,
  "i",
);

const NON_FINAL = `(?:${words(NON_FINAL_LABELS)}|(?<installment>instal{1,2}ment[ \\t]{1,4}\\d{1,3}[ \\t]{1,4}of[ \\t]{1,4}\\d{1,3}))`;
const RATE =
  "(?:[ \\t]{0,4}(?:@[ \\t]{0,4})?\\(?[ \\t]{0,2}\\d{1,2}(?:\\.\\d{1,3})?[ \\t]?%[ \\t]{0,2}\\)?)?";
/** As SEP, but a non-final figure may carry a sign ("Discount -$50.00", "Amount paid ($300.00)"): it is never paid. */
const NON_FINAL_SEP =
  "(?:[ \\t:=|.]{0,99}[ \\t:=|](?=[\\d\\-\\u2212(])|[ \\t:=|.]{1,100}(?=[$u\\-\\u2212(]))";
const NON_FINAL_LINE = new RegExp(
  `^(?<nlabel>${NON_FINAL})${RATE}${INFIX}${NON_FINAL_SEP}[-\\u2212(]?${AMOUNT}\\)?${TAIL}[ \\t]*$`,
  "i",
);

/** "Total hours: 40", "Total items 3": a count, not a sum; a value written under it is still refused. */
const COUNT_LINE =
  /^total[ \t]{1,4}(?:hours|hrs|items|qty|quantity|units|pages|words|seats|sessions)[ \t]{0,4}[:=|]?[ \t]{0,4}\d{1,6}(?:\.\d{1,2})?$/i;

/**
 * "$1,277.35 USD due December 1, 2026", or with the invoice number and a page in a footer ("A1B2-0061 \u00b7 $1,277.35
 * USD due December 1, 2026 \u00b7 Page 1 of 1"): a final total that competes with the others. It needs a currency
 * marker and a document that states its invoice number; a number on the line must be that one.
 */
const DUE_BY = new RegExp(
  `^(?:(?<ref>[A-Z0-9][A-Z0-9-]{3,31})[ \\t]{1,4}[\\u00b7\\u2022|][ \\t]{1,4})?${AMOUNT}[ \\t]{1,4}due[ \\t]{1,4}(?:(?:on|by)[ \\t]{1,4})?(?:${A_DATE})(?<page>[ \\t]{1,4}[\\u00b7\\u2022|][ \\t]{1,4}page[ \\t]{1,4}\\d{1,3}[ \\t]{1,4}of[ \\t]{1,4}\\d{1,3})?[ \\t]*$`,
  "i",
);

const DENIED_INCL: ReadonlySet<string> = new Set([
  ...SCALE_WORDS,
  ...CURRENCY_WORDS,
  ...STATUS_WORDS,
  ...MONEY_WORDS.filter((w) => !w.includes(" ")),
]);

const collapse = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** A non-final line with a non-zero payment, deposit, credit, carried balance or installment in it. */
function isDeduction(m: RegExpExecArray): boolean {
  const deducts =
    m.groups?.installment !== undefined || DEDUCTION_LABELS.has(collapse(m.groups?.nlabel));
  return deducts && /[1-9]/.test(m.groups?.amount ?? "");
}

type Final =
  | { at: number; key: string; label: string; units: string; marked: boolean }
  | { issue: AmountIssue };

/** Base units of a figure that matched FIGURE, or null when it is not an exact, plain US-dollar amount. */
function unitsOf(figure: string): string | null {
  const [whole = "", frac = ""] = figure.split(".");
  const int = whole.replace(/,/g, "");
  if (int === "" || !/^\d+$/.test(int)) return null;
  if (int.length > 1 && int.startsWith("0")) return null; // "0100"
  if (!whole.includes(",") && frac.length === 3) return null; // "10.000" may be ten thousand
  const units = BigInt(int) * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0");
  return units > MAX_UNITS ? null : units.toString();
}

const figureOf = (amount: string) => /\d[\d,]*(?:\.\d+)?/.exec(amount)?.[0] ?? "";

/** A line that matched the final grammar: its total, or why it is not an exact US-dollar amount. */
function finalOf(m: RegExpExecArray, at: number): Final {
  const gr = m.groups ?? {};
  const amount = gr.amount ?? "";
  // Without a marker (and no currency infix) the figure only corroborates a marked total.
  const marked = /[$]|usd/i.test(amount) || gr.infix !== undefined;
  const tail = (gr.tail ?? "").trim();
  if (/^[.,;]$/.test(tail) && !/usdc?$/i.test(amount)) return { issue: "unreadable" }; // "$1," then "250.00"
  if (gr.incl?.split(/[ \t]+/).some((w) => DENIED_INCL.has(w.toLowerCase())))
    return { issue: "unreadable" };
  const units = unitsOf(figureOf(amount));
  if (units === null) return { issue: "unreadable" };
  // The key is the label alone: "Total" and "Grand total" are the same label, written twice.
  const label = collapse(gr.label);
  return { at, key: label, label, units, marked };
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Every other line that looks payable
// ---------------------------------------------------------------------------------------------------------------

/**
 * "Item Qty Price Total": no digit, at least three header words, one of them Total (once), a column of items or
 * quantities, and no summary column (Subtotal, Tax, ...). A row of sums under "Subtotal Tax Total" is no table.
 */
function isTableHeader(g: string): boolean {
  if (/\p{N}/u.test(g)) return false;
  const tokens = g
    .toLowerCase()
    .split(/[\s|]+/)
    .filter(Boolean);
  const named = tokens.filter((t) => t !== "(usd)" && t !== "(usdc)");
  return (
    named.length >= 3 &&
    named.filter((t) => t === "total").length === 1 &&
    named.some((t) => ITEM_COLUMNS.has(t)) &&
    !named.some((t) => SUMMARY_COLUMNS.has(t)) &&
    tokens.every((t) => HEADER_WORDS.has(t))
  );
}

/** A final label used on this line (not a partial total such as "Sub total" or "Tax total"). */
function hasFinalLabel(s: string): boolean {
  const rest = s.replace(PARTIAL, " ");
  return NOUN_LABEL.test(rest) || VERB_LABEL.test(rest);
}

const WORD_BREAK = /[\s:;,=|()[\]{}"'*$<>!?/\\-]+/;
/** A word without the dots, #, _, ~ and backticks at its ends (index loops: a long run stays linear). */
function trimEdges(w: string): string {
  const edge = (c: string) => c === "." || c === "#" || c === "_" || c === "~" || c === "`";
  let a = 0;
  let b = w.length;
  while (a < b && edge(w[a] ?? "")) a++;
  while (b > a && edge(w[b - 1] ?? "")) b--;
  return w.slice(a, b);
}
/** Look-alike targets by length (the skeleton spells i as l, so an "l" here also matches an "i"). */
const LOOK_TARGETS = new Map<number, string[]>();
for (const w of [...PAYABLE_WORDS, ...MONEY_WORDS.filter((x) => !x.includes(" "))]) {
  const t = w.toLowerCase();
  LOOK_TARGETS.set(t.length, [...(LOOK_TARGETS.get(t.length) ?? []), t]);
}

/** The pattern, with "." for any character and "l" for i or l, matches the word. */
function wildMatch(pattern: readonly string[], word: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    const w = word[i];
    if (p === ".") continue;
    if (p === "l" ? w !== "l" && w !== "i" : p !== w) return false;
  }
  return true;
}

/**
 * 3/12. A word with a non-ASCII character, or a digit next to a letter, whose form with the folded look-alikes as
 * plain letters and every other odd character as a wildcard is a payable or money word ("T\u00f8tal", "T\u0966tal",
 * "Tota1", "\u0422\u043et\u0430\u16c1"). It keeps at least two letters that are plain once folded, so a word in another script is
 * not one.
 */
function hasLookAlike(g: string): boolean {
  // Words end at spaces and at the ASCII separators a label meets ("Tota1:$10.57"); a non-ASCII symbol stays
  // inside the word ("T\u25catal"), so the wildcard sees it.
  for (const raw of g.split(WORD_BREAK)) {
    const all = [...trimEdges(raw)];
    if (all.length > 40) continue; // no payable word is this long, even with marks and invisible characters
    const cps = all.filter((ch) => !INVISIBLE.test(ch));
    let odd = cps.length !== all.length;
    const letters = cps.filter((ch) => !MARK.test(ch));
    if (letters.length !== cps.length) odd = true;
    if (letters.length < 3 || letters.length > 11) continue;
    let plain = 0;
    const pattern: string[] = [];
    for (let i = 0; i < letters.length; i++) {
      const c = letters[i] ?? "";
      if (ASCII_LETTER.test(c)) {
        plain++;
        pattern.push(sk(c));
      } else if (c.charCodeAt(0) >= 0x80) {
        odd = true;
        const f = foldChar(c);
        if (ASCII_LETTER.test(f)) {
          plain++;
          pattern.push(f);
        } else pattern.push(".");
      } else if (
        /^\d$/.test(c) &&
        (LETTER.test(letters[i - 1] ?? "") || LETTER.test(letters[i + 1] ?? ""))
      ) {
        odd = true;
        pattern.push(".");
      } else pattern.push(c);
    }
    if (!odd || plain < 2) continue;
    if ((LOOK_TARGETS.get(letters.length) ?? []).some((w) => wildMatch(pattern, w))) return true;
  }
  return false;
}

/**
 * Digits that state no amount: dates, day counts, percentages, and the identifiers the other facts read (invoice
 * numbers, PO references, EVM addresses, NEAR accounts). "Due date: 2026-12-01" or "Pay to 0x52..." holds a
 * payable word but no figure.
 */
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
/** On a line with no money token: street addresses, suites and PO boxes, phones, links, e-mails, labelled ids. */
const STREET =
  /(?<![\d,.$])\b\d{1,6}[ \t]+(?:[A-Za-z][A-Za-z.'-]*[ \t]+){1,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl|parkway|pkwy|highway|hwy|square|sq|terrace|ter|circle|cir)\b\.?/gi;
const SUITE =
  /\b(?:suite|ste|apt|apartment|floor|fl|room|rm|p\.?o\.?[ \t]?box)\.?[ \t]{0,2}#?[ \t]{0,2}\d{1,6}[a-z]?\b/gi;
const ZIP =
  /,[ \t]{0,2}(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR)[ \t]{1,2}\d{5}(?:-\d{4})?\b/g;
const PHONE =
  /\(\d{3}\)[ \t]?\d{3}[-.]\d{4}\b|\b\d{3}-\d{3}-\d{4}\b|\+1[ \t-]?\d{3}[ \t-]\d{3}[ \t-]\d{4}\b/g;
const LABELLED_ID =
  /\b(?:customer|client|account|acct|member|order|reference|ref)\.?[ \t]{0,4}(?:id|no\.?|number|num\.?|#)[ \t]{0,4}[:#]?[ \t]{0,4}([A-Z0-9][A-Z0-9-]{0,30})(?![A-Z0-9-])/gi;
const LINK =
  /\bhttps?:\/\/[^\s]{1,200}|\bwww\.[^\s]{1,200}|[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,5}/gi;

/** A currency marker: $, any currency sign, USD or USDC, (US) dollars. */
const MARKER =
  /[$]|\p{Sc}|(?<![A-Za-z])(?:usdc?|dollars?)(?![A-Za-z])|(?<![A-Za-z])US(?![A-Za-z])/iu;
const PERCENT = /\d{1,3}(?:\.\d{1,3})?[ \t]?%/g;

/**
 * A money token: a currency marker with a figure, or a figure with decimals (dates and percentages are not
 * figures). Masking identifiers and the payee exemption apply only to a line without one.
 */
function moneyToken(g: string): boolean {
  if (!/\d/.test(g)) return false;
  if (MARKER.test(g)) return true;
  return /\d[.,]\d/.test(g.replace(DATES, " ").replace(PERCENT, " "));
}

/** The line with every date, term, percentage, address and identifier blanked out (each pass is linear). */
function masked(g: string): string {
  const blank = (m: string, id?: string) => (id ? m.replace(id, " ") : m);
  const t = g.replace(NOT_A_FIGURE, " ").replace(PO_LABELLED_G, blank).replace(INVOICE_NOS, blank);
  const linked = t.replace(LINK, " ");
  const street = linked.replace(STREET, " ");
  // A ZIP code counts only on a line that also holds a street address.
  const zipped = street !== linked ? street.replace(ZIP, " ") : street;
  return maskNearAccounts(
    zipped.replace(SUITE, " ").replace(PHONE, " ").replace(LABELLED_ID, blank),
  );
}

/** "Pay to ...", "Remit to ...", "Make checks payable to ...": a payee line, with an address. */
const PAYEE_LINE =
  /^(?:please\s+)?(?:(?:pay|remlt)(?:\s+payment)?\s+to|make\s+(?:checks?|cheques?|payments?)\s+payable\s+to|payable\s+to)(?![a-z])/;

/**
 * A line with a payable word and a figure (a digit or a number word that is not a date, term or identifier). A
 * line with a money token is payable-ish as it is: no masking and no payee exemption. A payee line is exempt up to
 * a tab or a second payable word, and the rest of the line is read as any other.
 */
function payableIsh(g: string, s: string): boolean {
  if (!PAYABLE.test(s) && !GLUED.test(s)) return false;
  if (moneyToken(g)) return true;
  const ss = s.trimStart();
  const payee = PAYEE_LINE.exec(ss);
  if (payee) {
    // The skeleton of an ASCII line has the line's own length, so a cut in one is a cut in the other.
    if (!ASCII.test(g)) return /\p{N}/u.test(masked(g)) || NUMBER_WORD.test(s);
    const gs = g.trimStart();
    const start = payee[0].length;
    const second = ss.slice(start).search(PAYABLE);
    const cuts = [gs.indexOf("\t", start), second < 0 ? -1 : second + start].filter((x) => x >= 0);
    if (cuts.length === 0) return NUMBER_WORD.test(s); // the whole line names the payee
    const cut = Math.min(...cuts);
    return payableIsh(gs.slice(cut), ss.slice(cut));
  }
  return (/\p{N}/u.test(g) && /\p{N}/u.test(masked(g))) || NUMBER_WORD.test(s);
}

/**
 * "Retainer" names a charge ("Monthly retainer $3,000.00") or a credit ("Retainer applied ($400.00)"). It is a
 * money word only as a credit: with a negative figure or a deduction word, or written after a final total.
 */
const RETAINER = /(?<![a-z])retalner(?![a-z])/;
const CREDIT_CUE =
  /(?<![a-z])(?:applled|credlt|credlted|pald|deposlt|less|mlnus|used|drawn|drawdown|deducted)(?![a-z])|(?<![\w])[-\u2212]\s?(?:\$|usdc?)?\s?\d|\(\s?(?:\$|usdc?)?\s?\d/;
/** Every money word but "retainer", which moneyLine reads on its own. */
const MONEY_WORD_BUT_RETAINER = phrases(MONEY_WORDS.filter((w) => w !== "retainer"));

/**
 * 2. A money word with a money token ("Paid $400.00", "Deposit paid 10/01/2026 -$400.00", "You owe: $5.00"). A
 * retainer counts as a credit only (above); `afterTotal`: a final total was read on an earlier line.
 */
const moneyLine = (g: string, s: string, afterTotal: boolean) =>
  moneyToken(g) &&
  (MONEY_WORD_BUT_RETAINER.test(s) || (RETAINER.test(s) && (afterTotal || CREDIT_CUE.test(s))));

/** A row of amounts and nothing else ("$4.50\t$0.50\t$5.00"): the values of a header row above it. */
const moneyRow = (line: string): boolean =>
  /\d/.test(line) &&
  line
    .replace(/(?:us\$|\$|usdc?)?[ \t]?[-\u2212(]?\d[\d,.]*\)?(?:[ \t]?usdc?)?/gi, " ")
    .replace(/[\s|*]+/g, "") === "";

/** A line that is only an amount, decorated or not ("$9,999.00", "= 470.00 USDC", "| $9,999.00 |", "USD $9,999.00*"). */
function orphanFigure(line: string): boolean {
  const t = line
    .replace(/[|*]/g, " ")
    .replace(/\((?:usdc?|incl\.?[^)]{0,40}|including[^)]{0,40})\)/gi, " ")
    .trim();
  return /^[=:\-\u2212+(]?[ \t]*(?:us\$|\$|usdc?[ \t]?\$?)?[ \t]?\d[\d,.]*(?:[ \t]?usdc?)?\)?\.?$/i.test(
    t,
  );
}

/** 10. A line that continues the figure above it: ",500.00", ".50", "+ $9,999.00", "250.00", "$9,999.00". */
const continuesFigure = (line: string) =>
  /^(?:[.,]\d|[+=])/.test(line) ||
  orphanFigure(line) ||
  /^\(?(?:\$|us\$|usdc?[ \t]?)?\d{1,3}(?:,\d{3})+(?![\d/-])/i.test(line) ||
  /^\(?(?:\$|us\$|usdc?[ \t]?)?\d+\.\d/i.test(line);

const NOTE_SCALE = phrases(NOTE_SCALE_WORDS);
/** k, m, mn, bn next to a figure ("1.2m", "250 k") or "in k". */
const LETTER_SCALE =
  /\d\s?(?:k|m|mm|mn|bn)(?![a-z])|(?<![a-z])(?:k|m|mm|mn|bn)\s?\$?\d|(?<![a-z])ln\s+(?:k|m|mn|bn)(?![a-z])/;
/** "per month", "per seat", "/ month", "x 20", "\u00d7 12", "20 x": a per-unit or multiplier note. */
const PER_UNIT =
  /(?<![a-z])per\s+[a-z]|^\s*\/\s*[a-z]|(?<![a-z])(?:x|\u00d7)\s*\d|\d\s*(?:x|\u00d7)(?![a-z])/;

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
  const lf = wellFormed(normaliseLineEnds(text));
  // 1a. Text the reader cannot trust.
  if (UNTRUSTED.test(lf)) return refuse("unreadable");
  const shown = nfkc(lf);
  if (shown.length > MAX_READ_UNITS) return refuse("unreadable");
  const g = shown.split("\n");
  const rows = g.map((line) => withoutBorders(line.trim()));
  // Blanked to the same length, so an ASCII line and its skeleton stay aligned.
  const s = g.map((line) => skeletonOf(line).replace(NOT_PAYABLE, (m) => " ".repeat(m.length)));
  const c = g.map(cleanOf);
  const cu = c.map(unspacedCapitals);
  const v: Views = {
    raw: lf,
    g,
    c,
    s,
    // Table pipes are separators here (the skeleton would read a "|" as an l).
    u: g.map((line, i) =>
      digitLetters(
        unspaced(
          line.includes("|")
            ? skeletonOf(line.replace(/\|/g, " - ")).replace(NOT_PAYABLE, " ")
            : (s[i] ?? ""),
        ),
      ),
    ),
    nonFinal: rows.map((row) => NON_FINAL_LINE.exec(row)),
    cu,
    capitals: cu.map(capitalWords),
  };
  // 1b, 1c, 1d (the numbers).
  if (notPayable(v)) return refuse("not_payable");
  if (otherCurrency(v, shown)) return refuse("currency");
  const numbers = invoiceNumbers(numberView(shown));
  if (numbers.size > 1) return refuse("ambiguous");

  const finals: Final[] = [];
  /** Where a final total was read (marked or not, any label), for the deduction order and two documents. */
  const finalAt: number[] = [];
  // The line above holds a payable word but no figure ("Balance", "Total hours: 40", a table header): a line
  // holding only an amount below it, before the next line with a digit, is that label's value in a column.
  let labelAbove = false;
  // The last line that deducts a payment, deposit, credit, carried balance or installment.
  let lastDeduction = -1;
  /** After a final or non-final line, the next non-blank line must not continue its figure. */
  let continues = false;
  const lines: number[] = [];
  for (let i = 0; i < g.length; i++) if ((g[i] ?? "").trim() !== "") lines.push(i);

  for (let k = 0; k < lines.length; k++) {
    const i = lines[k] ?? 0;
    const line = (g[i] ?? "").trim();
    const sl = s[i] ?? "";
    const row = rows[i] ?? "";
    if (continues && continuesFigure(row)) finals.push({ issue: "unreadable" });
    continues = false;
    const next = lines[k + 1];
    if (next !== undefined && splitAcrossLines(sl, s[next] ?? ""))
      finals.push({ issue: "unreadable" });
    if (oddLabel(sl, v.u[i] ?? "")) finals.push({ issue: "unreadable" });

    const due = /due/i.test(row) ? DUE_BY.exec(row) : null;
    if (due) {
      const units = unitsOf(figureOf(due.groups?.amount ?? ""));
      const ref = due.groups?.ref;
      if (
        !/[$]|usd/i.test(due.groups?.amount ?? "") ||
        units === null ||
        numbers.size === 0 ||
        (ref !== undefined && !numbers.has(ref.toUpperCase()))
      )
        finals.push({ issue: "unreadable" });
      else {
        const footer = ref !== undefined || due.groups?.page !== undefined;
        const key = footer ? "due by date (footer)" : "due by date";
        finals.push({ at: i, key, label: "due by date", units, marked: true });
        finalAt.push(i);
      }
      labelAbove = false;
      continues = true;
      continue;
    }
    if (COUNT_LINE.test(row)) {
      labelAbove = true;
      continue;
    }

    const final = FINAL_LINE.exec(row);
    const partial = final ? null : (v.nonFinal[i] ?? null);
    let ignored = false;
    if (final) {
      const f = finalOf(final, i);
      finals.push(f);
      if ("units" in f) finalAt.push(i);
      continues = true;
    } else if (partial) {
      if (isDeduction(partial)) lastDeduction = i; // a partial total or a payment line: never paid
      continues = true;
    } else if (isTableHeader(line)) {
      labelAbove = true; // a column header: a lone amount under it is a value with no label
      continue;
    } else if (
      hasFinalLabel(sl) ||
      ((!ASCII.test(line) || /[A-Za-z]\d|\d[A-Za-z]/.test(line)) && hasLookAlike(line)) ||
      payableIsh(line, sl) ||
      moneyLine(line, sl, finalAt.length > 0)
    ) {
      finals.push({ issue: "unreadable" }); // a payable line the grammar cannot read
    } else if (labelAbove && (orphanFigure(row) || moneyRow(row))) {
      finals.push({ issue: "unreadable" });
    } else ignored = true;
    if (!ignored) labelAbove = false;
    else if (PAYABLE.test(sl) || MONEY_WORD.test(sl) || GLUED.test(sl)) labelAbove = true;
    else if (/\p{N}/u.test(line)) labelAbove = false;
  }

  // 4. A scale or per-unit note near a final total, or in brackets anywhere.
  const near = new Set<number>();
  const position = new Map<number, number>(lines.map((line, k) => [line, k]));
  for (const f of finalAt) {
    const k = position.get(f) ?? -10;
    for (let d = -2; d <= 2; d++) {
      const at = lines[k + d];
      if (at !== undefined && at !== f) near.add(at);
    }
    const after = lines[k + 1];
    if (after !== undefined && PER_UNIT.test(s[after] ?? "")) return refuse("unreadable");
  }
  for (const i of lines) {
    const sl = s[i] ?? "";
    const note = /^\s*\(.*\)\s*$/.test(sl);
    if ((near.has(i) || note) && (NOTE_SCALE.test(sl) || LETTER_SCALE.test(sl)))
      return refuse("unreadable");
  }

  const totals = finals.flatMap((f) => ("units" in f ? [f] : []));
  const marked = totals.filter((f) => f.marked);
  const markedKeys = new Set(marked.map((f) => f.key));
  if (markedKeys.size < marked.length) return refuse("ambiguous"); // the same final label twice: two documents
  if (twoDocuments(s, finalAt)) return refuse("ambiguous");
  const issue = finals.find((f): f is { issue: AmountIssue } => "issue" in f);
  if (issue) return refuse(issue.issue);
  // An unmarked figure only corroborates a marked total: equal to it, and under a label of its own.
  const unmarked = totals.filter((f) => !f.marked);
  const values = new Set(marked.map((f) => f.units));
  if (unmarked.length > 0) {
    if (marked.length === 0) return refuse("unreadable");
    if (unmarked.some((u) => values.size !== 1 || !values.has(u.units)))
      return refuse("unreadable");
    if (new Set(totals.map((f) => f.key)).size < totals.length) return refuse("unreadable");
  }
  // After a deduction, only a balance-type label written after it says what is left to pay, and no total may be
  // stated before it (it may be the amount before the deduction).
  if (lastDeduction >= 0 && totals.length > 0) {
    if (totals.some((f) => f.at < lastDeduction)) return refuse("ambiguous");
    if (!marked.some((f) => f.at > lastDeduction && !GROSS_LABELS.has(f.label)))
      return refuse("ambiguous");
  }
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
