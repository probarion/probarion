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
  NOT_OWED_PHRASES,
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

// The invoice amount reader. The Payables agent pays on its own only when an attested model confirms the amount
// this code read (see owner-confirms.ts); the model is shown that amount, so the reader carries the weight and is an
// allowlist: it pays only a total stated on a line written in a plain, closed grammar, and refuses everything else
// as "0" with a reason. The order is fixed:
//   1. gates on the whole document: text it cannot trust, a document that is not a payable invoice, another
//      currency, more than one invoice, and (last, before paying) a document that does not say it is an invoice;
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
  /** For some refusals, why in words (a not_payable document with no invoice title). */
  why?: string;
}

/** Why a document with no invoice title in its first eight lines is not_payable. */
export const NOT_AN_INVOICE = "the document does not say it is an invoice";

/**
 * Past this many UTF-16 units nothing is read: the pipeline's MAX_TEXT_CHARS (extract.ts), so a direct call is
 * capped as the pipeline is. NFKC may expand the text to at most twice its length and at most MAX_NFKC_UNITS.
 */
export const MAX_READ_UNITS = 50_000;
export const MAX_NFKC_UNITS = 100_000;
/** The NFKC text, or null when NFKC expands it past twice its length or past MAX_NFKC_UNITS. */
export function cappedNfkc(text: string): string | null {
  if (text.length > MAX_READ_UNITS) return null;
  const out = text.normalize("NFKC");
  return out.length > 2 * Math.max(text.length, 1) || out.length > MAX_NFKC_UNITS ? null : out;
}
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
  ASCII.test(line)
    ? line
    : line
        .replace(INVISIBLE_G, "")
        .replace(MARK_G, "")
        .replace(SMALL_CAPITALS, (ch) => SMALL_CAPITAL_OF.get(ch) ?? ch);

/** Small capitals ("\u1d20\u1d0f\u026a\u1d05", "\u1d07\u1d1c\u0280") are capitals as far as stamps and codes go. */
const SMALL_CAPITAL_OF: ReadonlyMap<string, string> = new Map(
  [
    ["\u1d00", "A"],
    ["\u0299", "B"],
    ["\u1d04", "C"],
    ["\u1d05", "D"],
    ["\u1d07", "E"],
    ["\ua730", "F"],
    ["\u0262", "G"],
    ["\u029c", "H"],
    ["\u026a", "I"],
    ["\u1d0a", "J"],
    ["\u1d0b", "K"],
    ["\u029f", "L"],
    ["\u1d0d", "M"],
    ["\u0274", "N"],
    ["\u1d0f", "O"],
    ["\u1d18", "P"],
    ["\u0280", "R"],
    ["\ua731", "S"],
    ["\u1d1b", "T"],
    ["\u1d1c", "U"],
    ["\u1d20", "V"],
    ["\u1d21", "W"],
    ["\u028f", "Y"],
    ["\u1d22", "Z"],
  ].map(([k, v]) => [k, v] as [string, string]),
);
const SMALL_CAPITALS = new RegExp(`[${[...SMALL_CAPITAL_OF.keys()].join("")}]`, "gu");

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

/** What may stand between the letters of a letter-spaced word: spaces, tabs, dots, commas, slashes, quotes, bullets, dashes. */
const SPACING = "[\\s.,/'\\u00b7\\u2019\\u2022\\u2027~_-]{1,8}";
/** Runs of three or more single letters, separators apart: "t o t a l", "t.o.t.a.l", "p  a  l  d", "p\ta\tl\td". */
const SPACED = new RegExp(`(?<![a-z])[a-z](?:${SPACING}[a-z](?![a-z])){2,}`, "g");
const SEPARATOR_RUN = new RegExp(SPACING, "g");
/**
 * A letter-spaced run joined: the shortest separator of the run is the space between letters, and a longer one is
 * the space between words ("p a l d  l n  f u l l" -> "pald ln full").
 */
function joinSpaced(run: string): string {
  let shortest = Number.POSITIVE_INFINITY;
  for (const x of run.match(SEPARATOR_RUN) ?? []) if (x.length < shortest) shortest = x.length;
  return run.replace(SEPARATOR_RUN, (x) => (x.length > shortest ? " " : ""));
}
/** The skeleton with letter-spaced words joined ("t o t a l   $5" -> "total   $5"). */
const unspaced = (s: string): string => s.replace(SPACED, joinSpaced);

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
/**
 * Two words, a separator run apart (spaces, tabs, dots, quotes, bullets, dashes), as (first, second), with the
 * second taken by a lookahead so the pairs overlap.
 */
const WORD_PAIR =
  /(?<![a-z])([a-z]{1,12})(?=[\s.'\u00b7\u2019\u2022\u2027~_-]{1,8}([a-z]{1,12})(?![a-z]))/g;
/**
 * A pair joins into a hidden label when the join is a payable or money word and each piece has two letters, or the
 * join is a label of five letters or more ("T otal", "Tota l"; "year's end" does not join into "send").
 */
const joinsLabel = (a: string, b: string): boolean =>
  JOIN_TARGETS.has(`${a}${b}`) && ((a.length >= 2 && b.length >= 2) || a.length + b.length >= 5);

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
    if (joinsLabel(m[1] ?? "", m[2] ?? "")) return true;
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
  /** Each line's match of the final grammar, or null. */
  finalLine: readonly (RegExpExecArray | null)[];
  /** Each clean line with letter-spaced capitals joined ("V O I D" -> "VOID"), and its words in capitals. */
  cu: readonly string[];
  capitals: readonly CapitalWord[][];
}

const STAMP_LINES: ReadonlySet<string> = new Set(STAMPS.map(sk));
/**
 * "Paid by", "paid on", "paid via", "paid with", "paid through", with up to three words between ("Paid 2026-11-01 via
 * ACH", "Paid today by card"): a payment already made.
 */
const PAID_HOW_G =
  /(?<![a-z])(?:pald|refunded)(?:[ \t]{1,4}[^\s]{1,24}){0,3}?[ \t]{1,4}(?:by|on|vla|wlth|through|thru)(?![a-z])/g;
/** Before "paid", an instruction or a term: "to be paid by", "if not paid by the due date", "discount if paid by". */
const PAID_TERM =
  /(?:^|[^a-z])(?:be|lf|unless|not|when|once|untll)(?:[ \t]{1,4}[^\s]{1,24}){0,2}[ \t]{1,4}$/;
/** After "paid ... on": the network ("Paid in USDC on NEAR"), not a date. */
const ON_NETWORK = /^\s+(?:the\s+)?near(?![a-z.])/;
function paidHow(u: string): boolean {
  for (const m of u.matchAll(PAID_HOW_G)) {
    const at = m.index ?? 0;
    if (
      m[0].endsWith("on") &&
      PAID_INSTRUCTION.test(u.slice(at)) &&
      ON_NETWORK.test(u.slice(at + m[0].length, at + m[0].length + 12))
    )
      continue;
    if (!PAID_TERM.test(u.slice(Math.max(0, at - 60), at))) return true;
  }
  return false;
}
/** "This invoice has now been paid", "was fully paid", "is paid": a payment already made. */
const PAID_STATE =
  /(?<![a-z])(?:has|have|had|was|were|ls)(?:\s+(?:now|already|been|fully|partlally|since|then))*\s+(?:pald|refunded)(?![a-z])/;
/** "Payment made in full on 11/02/2026", "Payment was made on Nov 2, 2026". */
const PAYMENT_MADE =
  /(?<![a-z])payment\s+(?:was\s+|has\s+been\s+)?made\s+(?:ln\s+full|on\s+\d|on\s+[a-z]{3,9}\.?\s+\d)/;
/** A "Status:" label alone on its line; its value is on the next line. */
const STATUS_LABEL = /^[\W_]{0,10}(?:(?:lnvolce|payment)\s+)?status[\s:=|*-]*$/;
/** "Paid in USDC", "Paid in native USDC on NEAR": how to pay, not a payment made. */
const PAID_INSTRUCTION = /^\W{0,4}pald\s+ln\s+(?:natlve\s+)?usdc?\s+on\s+(?:the\s+)?near\W*$/;
/** "Paid search $500.00", "Paid social management": an item named with a money word, before any final total. */
const ITEM_NAMED =
  /^\W{0,4}(?:pald|deposlt)\s+(?!(?:by|on|vla|wlth|through|thru|ln|to|from|at|for|date|amount|lnvolce|thank|thanks|recelved|applled|ln\s+full)(?![a-z]))[a-z]{3,}/;
const ITEM_FIRST = /^\W{0,4}(?:pald|deposlt)(?![a-z])/;
const ITEM_DEDUCTS =
  /(?<![a-z])(?:recelved|refund|refunded|returned|held|applled|balance)(?![a-z])/;
/**
 * Minor 7. "Paid search $500.00", "Paid social management", "Deposit box rental $50.00": a line item named with a
 * money word, written before any final total, with no other money or payable word, no credit cue and no negative
 * figure after its first word. It is read as an item, not as a payment or a stamp.
 */
function itemRow(s: string, beforeFinal: boolean): boolean {
  if (!beforeFinal || !ITEM_NAMED.test(s)) return false;
  const rest = s.slice(ITEM_FIRST.exec(s)?.[0].length ?? 0);
  return (
    !MONEY_WORD_BUT_RETAINER.test(rest) &&
    !PAYABLE.test(rest) &&
    !CREDIT_CUE.test(rest) &&
    !ITEM_DEDUCTS.test(rest)
  );
}
/** "Balance<TAB>Paid", "Balance: paid": a balance stated as paid. */
const BALANCE_PAID = /^\W{0,4}balance[^a-z0-9]{1,12}pald\W*$/;
const STATUS_PHRASE = phrases(STATUS_PHRASES);
/** B7: nothing is owed from this document (lexicon NOT_OWED_PHRASES). */
const NOT_OWED = phrases(NOT_OWED_PHRASES);
/** "Status: Paid", "| Status | Paid |", "Status \u2013 Paid", "Status:     **Paid**". */
const STATUS_LINE = new RegExp(
  `^[\\W_]{0,10}(?:(?:lnvolce|payment)[ \\t]{1,4})?status(?:[^a-z0-9]{0,20})(?:${alternation(STATUS_VALUES)})(?![a-z])`,
);
const FIRST_WORD_STAMP = new RegExp(`^[\\W_]{0,10}(?:${alternation(FIRST_WORD_STAMPS)})(?![a-z])`);
/** A stamp behind a separator, ending the line: "INVOICE INV-90 - Void", "Invoice 12 | PAID", "Status \u2013 Paid". */
const SEPARATED_STAMP = new RegExp(
  `[\\-\\u2013\\u2014|:(\\[\\u00b7\\u2022/>]\\s*(?:${alternation(STAMPS)})\\W*$`,
);
/** An invoice title line that ends in a stamp behind a space: "Invoice INV-1001 void", "Invoice #1001 Draft". */
const TITLE_STAMP = new RegExp(
  `^\\W{0,4}(?:(?:tax|commerclal|sales)\\s+)?lnvolce(?![a-z]).*\\s\\W{0,2}(?:${alternation(STAMPS)})\\W*$`,
);
const DOCUMENT = phrases(DOCUMENT_TYPES);
const TITLE_DOCUMENT = phrases([...DOCUMENT_TYPES, ...TITLE_ONLY_TYPES]);
/** "Purchase order: PO-1001", "Purchase order no. 7781", "PURCHASE ORDER #4471-A": an invoice citing its PO. */
const PO_FIELD =
  /(?<![a-z])purchase\s+order\s*(?:no\.?|number|#|:)[\s:#.-]{0,6}[a-z0-9][a-z0-9/-]{0,31}\d/;
/** Off the first line, "Purchase order PO-1001" cites the PO too (on the first line it is the title). */
const PO_LOOSE = /(?<![a-z])purchase\s+order\s+(?:po)?-?\d[a-z0-9-]{0,30}/;
/** "Purchase order: PO-1001": a field with a colon, which cites the PO on any line, the first one too. */
const PO_COLON = /(?<![a-z])purchase\s+order\s*:\s*[a-z0-9][a-z0-9/-]{0,31}\d/;
/** "Sales order: SO-1001", "Work order #WO-17": an invoice citing its order, off the first line. */
const ORDER_FIELD =
  /(?<![a-z])(?:sales|work)\s+order\s*(?:no\.?|number|#|:)[\s:#.-]{0,6}[a-z0-9][a-z0-9/-]{0,31}\d/;
/** "Payment due upon receipt", "Due on receipt": a payment term, not a receipt ("Proof of receipt" is one). */
const ON_RECEIPT = /(?<![a-z])(?:upon|on)\s+recelpt(?![a-z])/g;
/** "From: Quote Masters Inc", "Vendor: ...": a name field, which may hold any word. */
const NAME_FIELD =
  /^\W{0,4}(?:from|vendor|suppller|payee|blll\s+from|blll\s+to|bllled\s+to|shlp\s+to|cllent|customer|company|attn)\s*:/;
/**
 * A type word written as the title or field of what follows: "Credit Note for invoice INV-1", "Receipt #1234",
 * "Quotation No.: Q-88120", "Quote Number: Q-1", "Quote Ref: Q-77", "Statement Date: 10/31/2026".
 */
const DOCUMENT_REF = new RegExp(
  `(?<![a-z])(?:${alternation(DOCUMENT_TYPES)})\\s*(?:for\\s+(?:lnvolce|lnv)|(?:#|no\\.?|number|num\\.?|ref\\.?|ld|date|valld(?:\\s+untll)?)\\s*[:#.\\t-]?\\s*[a-z0-9])`,
);
/**
 * A sentence that names the document's type, on any line: "This document is a quotation", "This is a receipt",
 * "This credit note reduces the balance", "This receipt confirms the transaction".
 */
const THIS_TYPE = new RegExp(
  `(?<![a-z])thls\\s+(?:(?:document\\s+)?ls\\s+(?:a|an)\\s+(?:${alternation(DOCUMENT_TYPES)})|(?:${alternation(DOCUMENT_TYPES)})\\s+(?:conflrms|reduces))(?![a-z])`,
);
/** Where a name field's exemption ends: a tab, a dash or bar between spaces, or a second "label:". */
const NAME_FIELD_END = /\t| [-\u2013\u2014|] |\s[a-z][a-z ]{1,20}:/;
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
        ...NOT_OWED_PHRASES,
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
  /** The previous non-blank line, for a phrase wrapped across a line end ("Paid in" / "full"). */
  let previous: { u: string; money: boolean } | null = null;
  /** The cell of the previous line that is a "Status" header cell, or -1. */
  let statusCell = -1;
  /** The previous non-blank line is a "Status:" label alone. */
  let statusAbove = false;
  const firstFinal = v.finalLine.findIndex((m) => m !== null);
  for (let i = 0; i < v.g.length; i++) {
    const u = (v.u[i] ?? "").trim();
    if (u === "") continue;
    n++;
    const money = v.nonFinal[i] !== null;
    // An item named with a money word ("Paid search $500.00"), written before any final total.
    const item = itemRow(u, firstFinal < 0 || i < firstFinal) && moneyToken(v.g[i] ?? "");
    const capitals = v.capitals[i] ?? [];
    if (
      capitals.some((w) =>
        w.spellings.some((s) => CAPITAL_STAMP.has(s) && !(s === "PAID" && (money || item))),
      )
    )
      return true;
    // A Paid or Void cell under a "Status" header cell.
    const cells = (v.g[i] ?? "").includes("\t") ? (v.g[i] ?? "").split("\t") : null;
    if (
      statusCell >= 0 &&
      STATUS_CELL.test(skeletonOf((cells ?? [v.g[i] ?? ""])[statusCell] ?? "").trim())
    )
      return true;
    statusCell = cells ? cells.findIndex((c) => skeletonOf(c).trim() === "status") : -1;
    if (statusAbove && STATUS_CELL.test(u)) return true;
    statusAbove = STATUS_LABEL.test(u);
    const wrapped = previous;
    previous = { u, money };
    // A stamp cut by a pipe ("VO|D"): the skeleton reads the pipe as an l.
    if ((v.g[i] ?? "").includes("|")) {
      const sb = (v.s[i] ?? "").trim();
      if (!/\d/.test(sb) && STAMP_LINES.has(sb.replace(/[^a-z]+/g, " ").trim())) return true;
    }
    // Every check below looks for one of these words; most lines (items, totals) hold none.
    if (!wordsOf(u).some((w) => STATUS_OR_TYPE.has(w))) {
      previousHeading = null;
      continue;
    }
    // A stamp may carry a date ("PAID 2026-11-01") but no other figure: "Paid 40" is a payment line.
    const undated = u.replace(DATES, " ");
    const bare = /\d/.test(undated) ? "" : undated.replace(/[^a-z]+/g, " ").trim();
    if (STAMP_LINES.has(bare) || STATUS_LINE.test(u) || BALANCE_PAID.test(u)) return true;

    // "Paid" starting a line is a stamp, except on a money line, in an item row and in "Paid in USDC".
    const first = FIRST_WORD_STAMP.exec(u);
    const paidFirst = first !== null && /^\W{0,10}(?:pald|refunded)/.test(u);
    if (first && !(paidFirst && (money || item || PAID_INSTRUCTION.test(u)))) return true;
    if (!money && NOT_OWED.test(u) && !moneyToken(v.g[i] ?? "")) return true;
    if (
      !money &&
      (STATUS_PHRASE.test(u) ||
        paidHow(u) ||
        PAID_STATE.test(u) ||
        PAYMENT_MADE.test(u) ||
        SEPARATED_STAMP.test(undated) ||
        TITLE_STAMP.test(undated))
    )
      return true;
    // A phrase wrapped across a line end: it reads only once the two lines are joined.
    if (wrapped && !wrapped.money && !money) {
      const joined = `${wrapped.u} ${u}`;
      if (
        (STATUS_PHRASE.test(joined) && !STATUS_PHRASE.test(wrapped.u)) ||
        (paidHow(joined) && !paidHow(wrapped.u))
      )
        return true;
    }
    // Titles. Markdown heading marks go; a name field (up to a tab, a dash or a second label) and a cited PO or
    // order are not titles; "upon receipt" is a term.
    const text = u.replace(/^#+\s*/, "").replace(ON_RECEIPT, " ");
    const named = NAME_FIELD.test(text);
    const end = named ? text.slice(1).search(NAME_FIELD_END) : -1;
    const own = named ? (end >= 0 ? text.slice(end + 2) : "") : text;
    const cited = own.replace(PO_COLON, " ");
    const withoutPo =
      n > 1 ? cited.replace(PO_LOOSE, " ").replace(PO_FIELD, " ").replace(ORDER_FIELD, " ") : cited;
    // The first eight lines are the title, beside an amount too ("RECEIPT 100.00 USDC").
    if (n <= HEADER_LINES && TITLE_DOCUMENT.test(withoutPo)) return true;
    if (DOCUMENT_REF.test(withoutPo) || THIS_TYPE.test(u)) return true;
    if (!own.includes(":") && DOCUMENT_ALONE.test(withoutPo.replace(/[^a-z0-9#. -]+/g, " ").trim()))
      return true;
    const heading = !named && isHeading(withoutPo);
    if (heading && DOCUMENT.test(withoutPo)) return true;
    // A title split over two heading lines ("CREDIT" / "NOTE").
    if (heading && previousHeading !== null && DOCUMENT.test(`${previousHeading} ${withoutPo}`))
      return true;
    previousHeading = heading ? withoutPo : null;
  }
  return false;
}

/** A status value alone in a cell ("Paid", "Void", "Refunded"). */
const STATUS_CELL = new RegExp(`^[\\W_]{0,4}(?:${alternation(STATUS_VALUES)})[\\W_]{0,4}$`);

/** Letter-spaced capitals joined ("V O I D", "S  E  T  T  L  E  D", "C.A.D." -> "VOID", "SETTLED", "CAD"), on the clean view. */
const SPACED_CAPITALS = new RegExp(
  `(?<![\\p{L}\\p{N}])\\p{Lu}(?:${SPACING}\\p{Lu}(?![\\p{L}\\p{N}])){2,}`,
  "gu",
);
const unspacedCapitals = (c: string): string => c.replace(SPACED_CAPITALS, joinSpaced);

const CURRENCY_WORD = phrases(CURRENCY_WORDS);
/** "Canadian dollars", "Australian $", "Canadian funds", "AU dollars", "Kiwi dollars", "dollars canadiens". */
const OTHER_DOLLAR = new RegExp(
  `(?<![a-z])(?:(?:${alternation(OTHER_DOLLARS.filter((w) => w.length > 2))})\\.?\\s*(?:dollars?|\\$|funds|currency)|(?:${alternation(OTHER_DOLLARS.filter((w) => w.length <= 2))})\\s+dollars?|dollars?\\s+(?:canad|austral|n[e\u00e9]o)[a-z]*)(?![a-z])`,
);
const OTHER_SYMBOL = /[^\P{Sc}$]/u;
/** On the raw text: the full-width and small dollar signs are "$" once NFKC has run. */
const OTHER_RAW_SYMBOL = /[^\P{Sc}$\uff04\ufe69]/u;
const LETTER_SIGN = new RegExp(`[${LETTER_CURRENCY_SIGNS}]`);
/** "C$100", "HK$100", "NT$100", "Cdn.$": a dollar sign glued to a country's letters. */
const PREFIXED_DOLLAR = /(?<![A-Za-z])([A-Za-z]{1,3})\.?\$/g;
/** "C $100", "NZ $", "$ CA", "$AU": another dollar written with one space, or after the sign. */
const SPACED_DOLLAR =
  /(?<![A-Za-z])(?:C|CA|CAN|CAD|CDN|Cdn|AU|NZ|HK|SG|NT|MX|R)\s+\$|\$\s*(?:A|CA|CAN|AU|NZ|HK|SG|NT|MX)(?![A-Za-z])/;
/** "Rs 500", "in Rs.", "500 kr", "RM 20", "Rp 10.000", "z\u0142", "K\u010d", "CDN": a currency written short. */
const SHORT_CURRENCY =
  /(?:(?<![A-Za-z])(?:Rs|Rs\.|kr|kr\.|Kr|RM|Rp|CDN|Cdn|KSh|USh|TSh|TL)(?=\s?\d)|(?<=\d\s?)(?:Rs|kr|RM|Rp|KSh|USh|TSh|TL)(?![A-Za-z])|(?<![A-Za-z])(?:in|en|are)\s(?:Rs|kr|KR|Kr|RM|Rp|CDN|Cdn|KSh|USh|TSh|TL)\b\.?|z\u0142(?![a-z])|K\u010d(?![a-z])|(?<!\p{L})\u043b\u0432\.?(?!\p{L}))/u;
/** "Currency: EUR", "Currency code - CAD", "CURRENCY\tPHP", "Invoice currency = eur" (on the skeleton). */
const CURRENCY_FIELD =
  /(?<![a-z])(currenc(?:y|les)(?:\s+(?:code|type))?|curr\.?|cur\.|ccy|money|(?:settlement|payment)\s+(?:currency|asset|token)|settlement|asset|token)(\s*[:=]\s*|[\s|\-\u2013\u2014]+)([^\s,;]+)(?:\s+([a-z]+))?/;
/** "Prices in A $", "amounts in S  $": the Australian or Singapore dollar after "in", the sign a space away. */
const IN_SPACED_DOLLAR = /(?<![A-Za-z])[Ii][Nn][ \t]+[AS][ \t]+\$/;
/** "Prices in c.a.d.", "in e.u.r.": a dotted code after "in", in any case. */
const IN_DOTTED = /(?<![A-Za-z])in[ \t]+((?:[A-Za-z]\.[ \t]?){2,3}[A-Za-z]?)(?![A-Za-z])/gi;
/** Other dollars named by their country's adjective ("Canadian", "Australian"), in skeleton spelling. */
const DOLLAR_ADJECTIVES: ReadonlySet<string> = new Set(
  OTHER_DOLLARS.filter((w) => /(?:an|ese|ie)$/.test(w) || w === "cdn").map(sk),
);
/** "All amounts are in Canadian", "in Australian": another dollar by its adjective. */
const IN_OTHER_DOLLAR = new RegExp(
  `(?<![a-z])(?:ln|are)\\s+(?:${alternation([...DOLLAR_ADJECTIVES])})(?![a-z])`,
);
/** "Pay in BNB", "payable in USDt", "settled in EURC": the currency named after "in"; US dollars are USD or USDC. */
const PAY_IN_G =
  /(?<![A-Za-z])(?:pay|payable|paid|settle|settled|settlement|remit|remitted|denominated|invoiced|billed|priced)\s+in\s+([A-Za-z]{2,7})(?![A-Za-z0-9])/gi;
/** A word written like a code: capitals, with at most one small letter at either end ("BNB", "USDt", "wBTC"). */
const CODE_SHAPE = /^[A-Za-z]?[A-Z]{2,5}[a-z]?$/;
/** Words in capitals that may follow "pay in" and name no currency. */
const PAY_IN_WORDS: ReadonlySet<string> = new Set([
  "USD",
  "USDC",
  "US",
  "FULL",
  "ONE",
  "TWO",
  "THREE",
  "FOUR",
  "FIVE",
  "SIX",
  "EQUAL",
  "ADVANCE",
  "ARREARS",
  "PERSON",
  "KIND",
  "PARTS",
  "TOTAL",
  "CASH",
]);
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

/** Currency names written like codes that ISO does not list (the renminbi, the CFA franc). */
const CODE_ALIASES: ReadonlySet<string> = new Set(["RMB", "FCFA", "CFA"]);
const isCode = (s: string) => ISO_CODES.has(s) || TOKEN_CODES.has(s) || CODE_ALIASES.has(s);
/** Word-like codes beyond ISO's: CFA is also a professional title. */
const isWordLike = (s: string) => WORDLIKE_CODES.has(s) || s === "CFA";
/** The spellings an l-for-I folded word may stand for ("lnr" -> "INR"). */
const codeOf = (upper: string): string | undefined => {
  if (isCode(upper)) return upper;
  if (!upper.includes("L")) return undefined;
  const alt = upper.replace(/L/g, "I");
  return isCode(alt) ? alt : undefined;
};

/**
 * A word in capitals on this line that is a code used as a currency (see otherCurrency). `prose`: some other word
 * of the document is written in capitals. Each code is tested once per line, so the line is read in linear time.
 */
/** The line with each non-ASCII letter folded to the plain letter it looks like ("\u0441ad" -> "cad"). */
const foldedLetters = (c: string): string => {
  let out = "";
  for (const ch of c) out += ch.charCodeAt(0) < 0x80 || !LETTER.test(ch) ? ch : foldChar(ch);
  return out;
};

/** A capital word that is a code, and where it stands in the plain line. */
interface CodeSpan {
  code: string;
  start: number;
  end: number;
}

/**
 * The clean line with each capital word replaced by its first spelling (a code, if it is one), and where each code
 * stands in it.
 */
function plainCapitals(
  cu: string,
  words: readonly CapitalWord[],
): { text: string; spans: CodeSpan[] } {
  let out = "";
  let at = 0;
  const spans: CodeSpan[] = [];
  for (const w of words) {
    const start = w.end - w.word.length;
    out += cu.slice(at, start);
    const code = w.spellings.find(isCode);
    if (code !== undefined) spans.push({ code, start: out.length, end: out.length + code.length });
    out += code ?? w.spellings[0] ?? w.word;
    at = w.end;
  }
  return { text: out + cu.slice(at), spans };
}

/** The text around a word, which holds every strict context of a code (a figure of up to 34 characters before it). */
const around = (c: string, span: CodeSpan): string =>
  c.slice(Math.max(0, span.start - 40), span.end + 16);

function wordInCapitalsIsCurrency(
  c: string,
  spans: readonly CodeSpan[],
  sl: string,
  words: readonly CapitalWord[],
  prose: boolean,
): boolean {
  const codes = words.flatMap((w) => w.spellings.filter(isCode).slice(0, 1));
  if (codes.length === 0) return false;
  // A line of codes: any code but NEAR, or NEAR written twice or more ("NEAR NEAR NEAR").
  const onlyCodes =
    codes.length === words.length &&
    (codes.some((x) => x !== "NEAR") || codes.length >= 2) &&
    c.replace(/[\p{Lu}\s\t|,/;:.()-]+/gu, "") === "";
  const cells =
    !/\d/.test(c) && c.includes("\t") ? new Set(c.split("\t").map((x) => x.trim())) : null;
  const context = CONTEXT_WORD.test(sl) || /(?<![a-z])are\s/.test(sl);
  if (onlyCodes) return true; // a line of codes
  for (const code of new Set(codes)) {
    if (!isWordLike(code)) return true;
    const use = codeUse(code);
    if (spans.some((sp) => sp.code === code && use.test(around(c, sp)))) return true;
    if (code === "NEAR") continue;
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
  if (OTHER_RAW_SYMBOL.test(v.raw) || OTHER_SYMBOL.test(shown) || LETTER_SIGN.test(shown))
    return true;
  // On the skeleton too, so a look-alike letter ("\u0421$") is seen.
  for (const view of [shown, v.s.join("\n")]) {
    for (const m of view.matchAll(PREFIXED_DOLLAR)) {
      const letters = (m[1] ?? "").toUpperCase();
      if (letters !== "US" && letters !== "USD") return true;
    }
  }
  // On the clean view, so an invisible character between "C" and "$" does not hide it.
  const clean = v.c.join("\n");
  if (SPACED_DOLLAR.test(clean) || SHORT_CURRENCY.test(shown)) return true;

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

  const done = new Set<string>();
  for (let i = 0; i < v.g.length; i++) {
    const line = v.g[i] ?? "";
    if (done.has(line)) continue; // an equal line was read and did not refuse
    if (line.length <= MEMO_LINE) done.add(line);
    const c = v.c[i] ?? "";
    const sl = v.s[i] ?? "";
    const words = capitals[i] ?? [];
    // The contexts are read on the line with each capital word in its plain spelling ("Payable in C\u0410D", "C.A.D.").
    if (words.length > 0) {
      const plain = plainCapitals(v.cu[i] ?? "", words);
      if (wordInCapitalsIsCurrency(plain.text, plain.spans, sl, words, prose)) return true;
    }
    // Glued to a figure, in any case of the letters ISO writes in capitals.
    for (const m of /[A-Z]\d|\d[A-Z]/.test(c) ? c.matchAll(GLUED_CODE) : []) {
      const code = m[1] ?? m[2] ?? "";
      if (isCode(code) && code !== "USDC" && code !== "USD") return true;
    }
    // Lower or title case: after "in", next to a figure, in a field; a word-like code also needs a context word.
    // Look-alike letters are folded first, so "\u0441ad" is "cad".
    const folded = !ASCII.test(c);
    const lw = folded ? foldedLetters(c) : c;
    for (const m of lw.matchAll(WORD)) {
      const w = m[0];
      if (!folded && w === w.toUpperCase()) continue; // capitals were read above
      const upper = w.toUpperCase();
      const code = folded ? codeOf(upper) : isCode(upper) ? upper : undefined;
      if (code === undefined) continue;
      const before = lw.slice(Math.max(0, (m.index ?? 0) - 6), m.index ?? 0);
      const after = lw.slice((m.index ?? 0) + w.length, (m.index ?? 0) + w.length + 4);
      const used =
        /(?:^|\W)(?:in|en)\s{1,3}$/i.test(before) || /\d\s?$/.test(before) || /^\s?\d/.test(after);
      if (code === "NEAR") continue; // NEAR_CURRENCY reads it below
      // A code that is no word ("Eur", "gbp") counts with a context word too ("All prices Eur").
      if (!used && !isWordLike(code) && CONTEXT_WORD.test(sl)) return true;
      if (!used) continue;
      if (!isWordLike(code) || CONTEXT_WORD.test(sl)) return true;
    }
    const field = /cur|ccy|settlement|money|asset|token/.test(sl) ? CURRENCY_FIELD.exec(sl) : null;
    if (field) {
      const value = (field[3] ?? "").replace(/[*_]+/g, "");
      // "Currency: X", "Curr: X", "Ccy: X" name the currency; "Settlement: X" may name a date or a method.
      const strict = /[:=]/.test(field[2] ?? "") && !/^settlement$/.test(field[1] ?? "");
      const named = value.replace(/^\$/, "");
      const isUs =
        US_VALUE.test(value) ||
        (value === "us" && /^dollars?$/.test(field[4] ?? "")) ||
        value === "";
      // "Currency: X" names the currency: anything but US dollars refuses. "Currency X" (no colon) refuses a
      // code, a currency word, or a "$" with letters ("$CAD").
      if (strict && !isUs) return true;
      if (
        !strict &&
        (isCode(named.toUpperCase()) ||
          CURRENCY_WORD.test(named) ||
          DOLLAR_ADJECTIVES.has(named) ||
          (/^\$[a-z]/.test(value) && !/^\$us/.test(value)))
      )
        return true;
    }
    if (wordsOf(sl).some((w) => CURRENCY_TRIGGERS.has(w)) && CURRENCY_TEXT.test(sl)) return true;
    if (IN_OTHER_DOLLAR.test(sl) || IN_SPACED_DOLLAR.test(c)) return true;
    for (const m of /\.[ \t]?[A-Za-z]\./.test(c) ? c.matchAll(IN_DOTTED) : []) {
      const code = (m[1] ?? "").replace(/[^A-Za-z]/g, "").toUpperCase();
      if (code !== "USD" && code !== "USDC" && isCode(code)) return true;
    }
    for (const m of /\sin\s/i.test(c) ? c.matchAll(PAY_IN_G) : []) {
      const w = m[1] ?? "";
      if (CODE_SHAPE.test(w) && !PAY_IN_WORDS.has(w.toUpperCase())) return true;
    }
  }
  return false;
}

const INVOICE_NOS = new RegExp(INVOICE_NO.source, "gi");
const INVOICE_TOKENS = new RegExp(INVOICE_TOKEN.source, "gi");

/**
 * Every dash-like character, read as "-": the Unicode dashes and the minus sign, the modifier minus, the hyphen
 * bullet, box-drawing lines, the heavy minus, the long-vowel marks, the small and full-width hyphen-minus and the
 * Ogham space mark (drawn as a dash).
 */
const DASHES =
  /[\p{Pd}\u2212\u02d7\u2043\u2500\u2501\u2796\u30fc\uff70\ufe63\uff0d\u1680\u2010-\u2015]/gu;
/** Characters that render as a blank space but are no space: Hangul fillers and the Braille blank. */
const BLANKS = /[\u115f\u1160\u3164\uffa0\u2800]/gu;
/** A run of digits and digit look-alikes: O, o, Cyrillic and Greek O, l, I, |, Cyrillic and Greek I. */
const DIGIT_RUN = /[0-9Oo\u041e\u043e\u039f\u03bflI|\u0406\u0456\u0399\u03b9\u04c0\u04cf]+/g;
const ZERO_LIKE = /[Oo\u041e\u043e\u039f\u03bf]/g;
const ONE_LIKE = /[lI|\u0406\u0456\u0399\u03b9\u04c0\u04cf]/g;
/** In a run that holds a real digit, a look-alike is the digit it looks like: "1OO1" is 1001, "l00l" is 1001. */
const foldDigitLookAlikes = (text: string): string =>
  text.replace(DIGIT_RUN, (run) =>
    /[0-9]/.test(run) ? run.replace(ZERO_LIKE, "0").replace(ONE_LIKE, "1") : run,
  );

/**
 * The text an invoice number and the fingerprint are read from: blank-rendering characters as spaces, invisible
 * characters removed, every dash-like character as "-", every space as " ", and digit look-alikes inside a number
 * as digits.
 */
export function numberView(text: string): string {
  // The reader, extractFacts and the fingerprint read the same text in turn: the last view is kept.
  if (text === lastNumberView.text) return lastNumberView.view;
  const view = foldDigitLookAlikes(
    ASCII.test(text)
      ? text
      : text
          .replace(BLANKS, " ")
          .replace(INVISIBLE_G, "")
          .replace(DASHES, "-")
          .replace(/\p{Zs}/gu, " "),
  );
  lastNumberView = { text, view };
  return view;
}
let lastNumberView = { text: "", view: "" };

/** The key form of an invoice number: its skeleton in capitals, letters and digits only ("INV 1001" is INV-1001). */
export const numberKey = (n: string): string =>
  skeletonOf(numberView(n.normalize("NFKC")))
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");

/** "No. 5520", "N\u00b0 5520": a bare number label at the start of a header line. */
const BARE_NUMBER =
  /^\W{0,3}(?:no\.?|n[\u00b0\u00ba]|nr\.?)[ \t]{0,4}[:#]?[ \t]{0,4}((?=[A-Z0-9/-]{0,31}[0-9])[A-Z0-9][A-Z0-9/-]{0,31})(?![A-Z0-9/-])/i;
/** A line that is only an invoice-number label, its value on the next line: "Invoice number:", "Invoice #". */
const NUMBER_LABEL_ALONE =
  /^\W{0,3}(?:invoice|inv\.?)[ \t]{0,4}(?:#|no\.?|n[\u00b0\u00ba]|number|num\.?|id|ref\.?)?[ \t]{0,4}[:#]?\W{0,3}$/i;
/** An invoice-number cell of a header row: "Invoice #", "Invoice No.", "Invoice Number". */
const NUMBER_CELL =
  /^(?:invoice|inv\.?)[ \t]{0,4}(?:#|no\.?|n[\u00b0\u00ba]|number|num\.?)[ \t]{0,4}:?$/i;
const ID = /^[#: \t]{0,3}((?=[A-Z0-9/-]{0,31}[0-9])[A-Z0-9][A-Z0-9/-]{0,31})(?![A-Z0-9/-])/i;
/** How many non-blank lines are the header, where a bare "No. N" is the invoice number. */
const HEADER_LINES = 8;

/**
 * The invoice numbers a text states, in order, read on the number view: after an invoice label ("Invoice INV-1",
 * "Invoice: #1001", "Bill #1001", "Invoice ref. A-1"), as a token ("INV-2026-07", "# INV-000415", "INV 2026-0451"),
 * as a bare "No. N" in the header, on the line after an "Invoice number:" label, and under an "Invoice #" cell of a
 * header row. Each pass is linear in the text.
 */
export function readInvoiceNumbers(text: string): string[] {
  if (text === lastNumbers.text) return [...lastNumbers.numbers];
  const numbers = readNumbers(text);
  lastNumbers = { text, numbers };
  return [...numbers];
}
let lastNumbers: { text: string; numbers: readonly string[] } = { text: "", numbers: [] };

function readNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(INVOICE_NOS)) out.push(m[1] ?? "");
  for (const m of text.matchAll(INVOICE_TOKENS)) out.push(m[0]);
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  for (let k = 0; k < lines.length; k++) {
    const line = (lines[k] ?? "").trim();
    if (k < HEADER_LINES) {
      const bare = BARE_NUMBER.exec(line)?.[1];
      if (bare !== undefined) out.push(bare);
    }
    const next = (lines[k + 1] ?? "").trim();
    if (NUMBER_LABEL_ALONE.test(line)) {
      const id = ID.exec(next)?.[1];
      if (id !== undefined) out.push(id);
    }
    // A header row of labels only ("Invoice #\tDate"): its values are on the next line.
    if (line.includes("\t") && !/\d/.test(line)) {
      const cells = line.split("\t").map((c) => c.trim());
      const at = cells.findIndex((c) => NUMBER_CELL.test(c));
      if (at >= 0) {
        const id = ID.exec((next.split("\t")[at] ?? "").trim())?.[1];
        if (id !== undefined) out.push(id);
      }
    }
  }
  return out;
}

/** 1d. The invoice numbers a text states, in their key form: two different ones are two documents. */
export function invoiceNumbers(text: string): Set<string> {
  return new Set(
    readInvoiceNumbers(text)
      .map(numberKey)
      .filter((k) => k !== ""),
  );
}

/** "jan", "aprll", "september": a month in skeleton spelling. */
const MONTH_SK =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:ll)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** "Invoice", "Tax invoice", "Commercial invoice", "Sales invoice" (skeleton spelling). */
const INVOICE_WORD = "(?:(?:tax|commerclal|sales)\\s+)?lnvolce";
/** Before a title: decoration only, or a name and a dash or a bar ("Acme Ltd \u2014 Invoice"). */
const TITLE_LEAD = "(?:[^a-z0-9]{0,10}|[^\\n]{1,60}?\\s[-\\u2013\\u2014|:\\u00b7\\u2022]\\s{1,4})";
/**
 * A title that starts a document, for two invoices in one text: "INVOICE" alone, "Sales Invoice", "Commercial
 * Invoice #12", "Acme Ltd \u2014 Invoice", "Invoice for October".
 */
const STRONG_TITLE = new RegExp(
  `^(?:${TITLE_LEAD}${INVOICE_WORD}[^a-z0-9]*$|[^a-z0-9]{0,10}(?:tax|commerclal|sales)\\s+lnvolce(?![a-z])|[^a-z0-9]{0,10}lnvolce\\s+for\\s+(?:the\\s+month\\s+of\\s+)?${MONTH_SK}(?![a-z]))`,
);
/** A document header: an invoice title, a "From:", "Bill to:" or customer line. */
const HEADER_KINDS: readonly [string, RegExp][] = [
  [
    "title",
    /^\W{0,4}(?:(?:tax|commerclal|sales)\s+)?(?:lnvolce|blll)(?:[ \t]{0,4}#?[ \t]{0,4}[a-z0-9/-]{0,32}\d[a-z0-9/-]{0,32})?\W{0,4}$/,
  ],
  ["strong title", STRONG_TITLE],
  ["number label", /^\W{0,3}lnvolce[ \t]{0,4}(?:#|no\.?|number|num\.?)[ \t]{0,4}:?\W{0,3}$/],
  ["from", /^\W{0,4}from\s*:/],
  ["bill to", /^\W{0,4}(?:blll|bllled)\s+to(?![a-z])/],
  ["customer", /^\W{0,4}(?:customer|cllent|sold\s+to|shlp\s+to)\s*:/],
];
/** A page marker: "Page 2", "Page 2 of 3", "(continued)". */
const PAGE_MARK =
  /(?<![a-z])(?:page\s{1,4}\d{1,3}(?:\s{1,4}of\s{1,4}\d{1,3})?|contlnued|cont'd)(?![a-z])|^\W{0,4}\d{1,3}\s{1,4}of\s{1,4}\d{1,3}\W{0,4}$/;
/** A line as a title is read: heading marks gone, trimmed (the unspaced view already reads table pipes as dashes). */
const titleText = (u: string): string => u.trim().replace(/^#{1,6}\s*/, "");

/**
 * 1d. Two invoice titles in one text ("Sales Invoice" twice, "Acme Ltd \u2014 Invoice" twice). A two-page invoice that
 * repeats its title on each page reads when it has page markers and states its total only after the last title.
 */
function twoTitles(
  u: readonly string[],
  lines: readonly number[],
  finalAt: readonly number[],
): boolean {
  const titles = lines.filter((i) => STRONG_TITLE.test(titleText(u[i] ?? "")));
  if (titles.length < 2) return false;
  const last = titles[titles.length - 1] ?? 0;
  const paged = lines.some((i) => PAGE_MARK.test(u[i] ?? ""));
  return !(paged && finalAt.every((f) => f > last));
}

/**
 * The invoice title a payable document must have in its first eight non-blank lines, on the unspaced skeleton: the
 * title alone ("INVOICE", "Tax Invoice", "Commercial invoice", "Sales invoice", "Acme Ltd \u2014 Invoice"), with a
 * number label ("Invoice #", "Invoice No.", "Invoice number"), or with a number on the line ("Invoice INV-1001",
 * "Invoice: 1001", "Invoice 2026-09").
 */
const INVOICE_TITLE = new RegExp(
  `^${TITLE_LEAD}${INVOICE_WORD}(?![a-z])(?:[^a-z0-9]*$|[ \\t]*(?:#|no\\.?(?![a-z])|number|num\\.?(?![a-z])|n\\u00b0)?[ \\t:#.]*(?:[^a-z0-9]*$|(?=[^\\s]*\\d)[^\\s(]+))`,
);
function invoiceTitled(v: Views, lines: readonly number[]): boolean {
  for (const i of lines.slice(0, HEADER_LINES)) {
    // A total or partial line ("Invoice total $700.00", "Invoice amount: $700.00") states an amount, not a title.
    if (v.finalLine[i] !== null || v.nonFinal[i] !== null) continue;
    if (INVOICE_TITLE.test(titleText(v.u[i] ?? ""))) return true;
  }
  return false;
}

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
    // The rest of the line is read as any line, once, with no second payee exemption: one pass, no recursion.
    const rest = gs.slice(cut);
    const restS = ss.slice(cut);
    if (!PAYABLE.test(restS) && !GLUED.test(restS)) return false;
    return (/\p{N}/u.test(rest) && /\p{N}/u.test(masked(rest))) || NUMBER_WORD.test(restS);
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
  /^\(?(?:\$|us\$|usdc?[ \t]?)?\d+\.\d/i.test(line) ||
  continuedAmount(line);

/** Commas that look like a comma: the low quote, the Arabic and ideographic commas, the small and full-width ones. */
const COMMA_LIKE = /[\u201a\u066c\u060c\u3001\ufe50\uff0c]/g;
/** Decoration around a value: spaces, brackets, stars, bars, quotes, dashes. */
const DECORATION: ReadonlySet<string> = new Set([..." \t[](){}*|_'\"!>\u2013\u2014-"]);
/** The text without decoration at either end (by hand: a regex anchored at the end would scan the line again). */
function trimDecoration(t: string): string {
  let a = 0;
  let b = t.length;
  while (a < b && DECORATION.has(t[a] ?? "")) a++;
  while (b > a && DECORATION.has(t[b - 1] ?? "")) b--;
  return t.slice(a, b);
}
/** A value as a continuation or an orphan is read: the clean line, comma look-alikes as ",", decoration and "only" gone. */
function figureView(clean: string): string {
  const t = trimDecoration(clean.replace(COMMA_LIKE, ","));
  const lower = t.toLowerCase();
  const only =
    lower.endsWith(" only") || lower.endsWith("\tonly") ? 5 : lower.endsWith(" only.") ? 6 : 0;
  return only > 0 ? trimDecoration(t.slice(0, t.length - only)) : t;
}
const CURRENCY_FIRST = new RegExp(`^(?:${alternation(CURRENCY_WORDS)})(?![a-z])`);
/**
 * "500 dollars", "500 USD only", "000 000.00", "500": a figure (grouped by spaces, commas, dots or quotes) followed
 * by a currency word, a marker, "only" or nothing. A street number is followed by a name ("1200 Congress Avenue").
 */
function continuedAmount(line: string): boolean {
  const m = /^\d{1,15}(?:[ ,.'\u066c]\d{3}){0,6}(?:\.\d{1,6})?/.exec(line);
  if (!m) return false;
  const rest = line.slice(m[0].length).trim();
  return (
    rest === "" ||
    /^(?:only|usdc?|us|dollars?)(?![a-z])|^[$\p{Sc}]/iu.test(rest) ||
    CURRENCY_FIRST.test(sk(rest))
  );
}

const NOTE_SCALE = phrases(NOTE_SCALE_WORDS);
/** k, m, mn, bn next to a figure ("1.2m", "250 k") or "in k". */
const LETTER_SCALE =
  /\d\s?(?:k|m|mm|mn|bn)(?![a-z])|(?<![a-z])(?:k|m|mm|mn|bn)\s?\$?\d|(?<![a-z])ln\s+(?:k|m|mn|bn)(?![a-z])/;
/** "$k", "USD MM", "'000", "000s": a scale written short (on the skeleton). */
const SHORT_SCALE =
  /\$\s?(?:k|m|mm|mn|bn)(?![a-z])|'000(?!\d)|(?<![\d,.])000s(?![a-z])|(?<![a-z])usd\s?(?:k|m|mm|mn|bn)(?![a-z])/;
/** "\u00b5USDC", "\u03bc$": a micro unit before a currency (on the NFKC text). */
const MICRO = /[\u00b5\u03bc]\s?(?:usdc?|\$|dollars?|near)/i;
const SCALE_ALT = alternation(NOTE_SCALE_WORDS);
/** "in cents", "as thousands", "in USD '000": a scale after "in" or "as" (a header note). */
const IN_SCALE = new RegExp(
  `(?<![a-z])(?:ln|as)\\s+(?:usd\\s+|us\\s+dollars\\s+|\\$\\s?)?(?:(?:${SCALE_ALT})(?![a-z])|'000|000s|k(?![a-z])|mm?(?![a-z])|mn(?![a-z])|bn(?![a-z]))`,
);
/** "All amounts are shown in cents", "Prices quoted in thousands": a denomination note, on any line. */
const DENOMINATION = new RegExp(
  `(?<![a-z])(?:amounts?|flgures|prlces|values|totals?|numbers)(?![a-z])[^.\\n]{0,40}?${IN_SCALE.source}`,
);
/** After the last total, a charge word on a line with no money token ("Shipping 25", "plus 8% sales tax"). */
const AFTER_TOTAL_CHARGE =
  /(?<![a-z])(?:tax|taxes|vat|gst|hst|pst|shlpplng|frelght|handllng|fee|fees|surcharge|dlscount)(?![a-z])/;
/** ... with an open amount: a plus, excl., extra or not-included note. */
const AFTER_TOTAL_OPEN =
  /(?<![a-z])(?:plus|excl|excludes?|excludlng|extra|addltlonal|not\s+lncluded|to\s+be\s+added)(?![a-z])/;
/** ... unless it is a term ("2% discount if paid within 10 days", "Payment terms"). */
const AFTER_TOTAL_TERM = /(?<![a-z])(?:lf|wlthln|when|before|terms|net\s*\d)(?![a-z])/;
/** The money figures of a line: after $ or USD(C), before USD(C) or dollars, or with cents. */
const MONEY_FIGURES =
  /(?:\$|usdc?)[ \t]?\$?[ \t]?(\d[\d,]*(?:\.\d{1,6})?)|(?<![\d,])(\d[\d,]*(?:\.\d{1,6})?)[ \t]?(?:usdc?|dollars?)(?![a-z])|(?<![A-Za-z\d.,/:-])(\d[\d,]*\.\d{2})(?![\d.,/-])/gi;
/** "per month", "per seat", "/ month", "x 20", "\u00d7 12", "20 x": a per-unit or multiplier note. */
const PER_UNIT =
  /(?<![a-z])per\s+[a-z]|^\s*\/\s*[a-z]|(?<![a-z\d])(?:x|\u00d7)\s*\d|\d\s*(?:x|\u00d7)(?![a-z\d])|\d\s*\/\s*(?:mo|mth|month|yr|year|hr|hour|wk|week|day|seat|user|unit)(?![a-z])/;
/** A late-fee, interest or finance-charge term, in skeleton spelling. */
const LATE_TERM = /(?<![a-z])(?:late|overdue|lnterest|flnance|penalty|past\s+due)(?![a-z])/;
/** "per month", "per annum": a period, which on a late-fee term is the rate's. */
const PER_PERIOD_PHRASE = /(?<![a-z])per\s+(?:month|annum|year|day|week|quarter)(?![a-z])/g;
/** "monthly, billed annually": a frequency, which after a total says the total is per period. */
const PER_PERIOD =
  /(?<![a-z])(?:monthly|annually|yearly|weekly|blweekly|quarterly|hourly|dally)(?![a-z])/;

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

/**
 * B4: an invoice-number token (after "Invoice #/No./n\u00b0/number/num.", "INV" or "#") that still holds a non-ASCII
 * character once the number view has folded dashes, blanks and look-alike digits ("INV-1\u3007 01", "1\u0555\u05551").
 * The token is read up to 64 characters, so the check stays linear on a long run with no space.
 */
const UNFOLDED_NUMBER =
  /(?:(?<![a-z])invoice\s*(?:#|no\.?|n\u00b0|number|num\.?)\s*[:#.]?\s*|(?<![a-z])inv|(?:^|\s)#\s*)[^\s]{0,64}[^\p{ASCII}\s]/imu;

/** Lines up to this long share their views and checks with equal lines (longer ones are rare and read alone). */
const MEMO_LINE = 512;

/** One line's views (see Views). */
interface LineViews {
  row: string;
  s: string;
  c: string;
  cu: string;
  u: string;
  nonFinal: RegExpExecArray | null;
  finalLine: RegExpExecArray | null;
  capitals: CapitalWord[];
}

function lineViews(line: string): LineViews {
  const row = withoutBorders(line.trim());
  // Blanked to the same length, so an ASCII line and its skeleton stay aligned.
  const s = skeletonOf(line).replace(NOT_PAYABLE, (m) => " ".repeat(m.length));
  const c = cleanOf(line);
  const cu = unspacedCapitals(c);
  // Table pipes are separators in the unspaced view (the skeleton would read a "|" as an l).
  const u = digitLetters(
    unspaced(
      line.includes("|") ? skeletonOf(line.replace(/\|/g, " - ")).replace(NOT_PAYABLE, " ") : s,
    ),
  );
  return {
    row,
    s,
    c,
    cu,
    u,
    nonFinal: NON_FINAL_LINE.exec(row),
    finalLine: FINAL_LINE.exec(row),
    capitals: capitalWords(cu),
  };
}

function read(text: string): AmountRead {
  if (text.length > MAX_READ_UNITS) return refuse("unreadable"); // before any NFKC or numeral work
  const lf = wellFormed(normaliseLineEnds(text));
  // 1a. Text the reader cannot trust.
  if (UNTRUSTED.test(lf)) return refuse("unreadable");
  const shown = nfkc(lf);
  // NFKC that expands the text ("\ufdfa" is 18 letters) would multiply the work: such a text is not read.
  if (shown.length > 2 * Math.max(lf.length, 1) || shown.length > MAX_NFKC_UNITS)
    return refuse("unreadable");
  if (UNFOLDED_NUMBER.test(numberView(shown))) return refuse("unreadable");
  const g = shown.split("\n");
  // Each distinct line's views are computed once: a text of many equal lines costs one line's work for each.
  const memo = new Map<string, LineViews>();
  const lv = g.map((line) => {
    let x = memo.get(line);
    if (x === undefined) {
      x = lineViews(line);
      if (line.length <= MEMO_LINE) memo.set(line, x);
    }
    return x;
  });
  const rows = lv.map((x) => x.row);
  const s = lv.map((x) => x.s);
  const c = lv.map((x) => x.c);
  const v: Views = {
    raw: lf,
    g,
    c,
    s,
    u: lv.map((x) => x.u),
    nonFinal: lv.map((x) => x.nonFinal),
    finalLine: lv.map((x) => x.finalLine),
    cu: lv.map((x) => x.cu),
    capitals: lv.map((x) => x.capitals),
  };
  /** The pure checks of a line, once per distinct line (keyed by the line as written), one table per check. */
  const tables: Map<string, boolean>[] = [];
  const once = (slot: number, key: string, check: () => boolean): boolean => {
    let table = tables[slot];
    if (table === undefined) {
      table = new Map();
      tables[slot] = table;
    }
    let r = table.get(key);
    if (r === undefined) {
      r = check();
      if (key.length <= MEMO_LINE) table.set(key, r);
    }
    return r;
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
  /**
   * The non-final amounts (partial totals, payments, deposits), for the deduction arithmetic; `paid`: an amount
   * already paid (a payment, deposit or credit; an installment is due, not paid).
   */
  const partials: { at: number; units: string | null; paid: boolean }[] = [];
  const firstFinal = v.finalLine.findIndex((m) => m !== null);
  /** After a final or non-final line, the next non-blank line must not continue its figure. */
  let continues = false;
  const lines: number[] = [];
  for (let i = 0; i < g.length; i++) if ((g[i] ?? "").trim() !== "") lines.push(i);

  for (let k = 0; k < lines.length; k++) {
    const i = lines[k] ?? 0;
    const line = (g[i] ?? "").trim();
    const sl = s[i] ?? "";
    const row = rows[i] ?? "";
    // A line with no letter or digit ("," or "..." or an invisible character) does not end a figure: the line
    // after it may continue it.
    if (continues && !/[\p{L}\p{N}]/u.test(c[i] ?? "")) continue;
    let figure: string | undefined;
    const figureOfLine = (): string => {
      figure ??= figureView(withoutBorders((c[i] ?? "").trim()));
      return figure;
    };
    if (continues && (continuesFigure(row) || continuesFigure(figureOfLine())))
      finals.push({ issue: "unreadable" });
    continues = false;
    const next = lines[k + 1];
    if (
      next !== undefined &&
      once(4, `${g[i]}\n${g[next]}`, () => splitAcrossLines(sl, s[next] ?? ""))
    )
      finals.push({ issue: "unreadable" });
    if (once(0, g[i] ?? "", () => oddLabel(sl, v.u[i] ?? ""))) finals.push({ issue: "unreadable" });

    const due = /due/i.test(row) ? DUE_BY.exec(row) : null;
    if (due) {
      const units = unitsOf(figureOf(due.groups?.amount ?? ""));
      const ref = due.groups?.ref;
      if (
        !/[$]|usd/i.test(due.groups?.amount ?? "") ||
        units === null ||
        numbers.size === 0 ||
        (ref !== undefined && !numbers.has(numberKey(ref)))
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

    const final = v.finalLine[i] ?? null;
    const partial = final ? null : (v.nonFinal[i] ?? null);
    let ignored = false;
    if (final) {
      const f = finalOf(final, i);
      finals.push(f);
      if ("units" in f) finalAt.push(i);
      continues = true;
    } else if (partial) {
      const deduction = isDeduction(partial);
      if (deduction) lastDeduction = i; // a partial total or a payment line: never paid
      const paid = deduction && partial.groups?.installment === undefined;
      partials.push({ at: i, units: unitsOf(figureOf(partial.groups?.amount ?? "")), paid });
      continues = true;
    } else if (once(3, g[i] ?? "", () => isTableHeader(line))) {
      labelAbove = true; // a column header: a lone amount under it is a value with no label
      continue;
    } else if (
      once(5, g[i] ?? "", () => hasFinalLabel(sl)) ||
      ((!ASCII.test(line) || /[A-Za-z]\d|\d[A-Za-z]/.test(line)) &&
        once(1, g[i] ?? "", () => hasLookAlike(line))) ||
      once(2, g[i] ?? "", () => payableIsh(line, sl)) ||
      ((finalAt.length > 0
        ? once(6, g[i] ?? "", () => moneyLine(line, sl, true))
        : once(7, g[i] ?? "", () => moneyLine(line, sl, false))) &&
        !itemRow(sl, firstFinal < 0 || i < firstFinal))
    ) {
      finals.push({ issue: "unreadable" }); // a payable line the grammar cannot read
    } else if (labelAbove && (orphanFigure(row) || orphanFigure(figureOfLine()) || moneyRow(row))) {
      finals.push({ issue: "unreadable" });
    } else ignored = true;
    if (!ignored) labelAbove = false;
    else if (once(8, g[i] ?? "", () => PAYABLE.test(sl) || MONEY_WORD.test(sl) || GLUED.test(sl)))
      labelAbove = true;
    else if (/\p{N}/u.test(line)) labelAbove = false;
  }

  // 4. A scale or per-unit note within two lines of a final total; a scale note in brackets or in the header (the
  // first eight lines); a denomination note anywhere. Before the total, a per-unit note on a line with an amount
  // of its own is a line item ("Rate: $100.00 per hour").
  const near = new Set<number>();
  const position = new Map<number, number>(lines.map((line, k) => [line, k]));
  for (const f of finalAt) {
    const k = position.get(f) ?? -10;
    for (let d = -2; d <= 2; d++) {
      const at = lines[k + d];
      if (at === undefined || at === f) continue;
      near.add(at);
      const sl = s[at] ?? "";
      // A late-fee, interest or finance-charge term ("A 1.5% monthly finance charge", "1.5% per month on late
      // payments") states a rate per period, not a note on the total; any other per-unit phrase on it still counts.
      const term = LATE_TERM.test(sl);
      const unit = term ? sl.replace(PER_PERIOD_PHRASE, " ") : sl;
      if (PER_UNIT.test(unit) && (d > 0 || !moneyToken(g[at] ?? ""))) return refuse("unreadable");
      if (d > 0 && !term && PER_PERIOD.test(sl)) return refuse("unreadable");
    }
  }
  for (let k = 0; k < lines.length; k++) {
    const i = lines[k] ?? 0;
    const sl = s[i] ?? "";
    const note = /^\s*\(.*\)\s*$/.test(sl);
    const scale = () =>
      NOTE_SCALE.test(sl) ||
      LETTER_SCALE.test(sl) ||
      SHORT_SCALE.test(sl) ||
      MICRO.test(g[i] ?? "");
    if ((near.has(i) || note) && scale()) return refuse("unreadable");
    if (
      k < HEADER_LINES &&
      (IN_SCALE.test(sl) ||
        SHORT_SCALE.test(sl) ||
        MICRO.test(g[i] ?? "") ||
        (PER_UNIT.test(sl) && !moneyToken(g[i] ?? "") && !LATE_TERM.test(sl)))
    )
      return refuse("unreadable");
    if (once(9, g[i] ?? "", () => DENOMINATION.test(sl))) return refuse("unreadable");
  }

  const totals = finals.flatMap((f) => ("units" in f ? [f] : []));
  const marked = totals.filter((f) => f.marked);
  const markedKeys = new Set(marked.map((f) => f.key));
  if (markedKeys.size < marked.length) return refuse("ambiguous"); // the same final label twice: two documents
  if (twoDocuments(v.u, finalAt) || twoTitles(v.u, lines, finalAt)) return refuse("ambiguous");
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
  // 6. After the last final total, a money-token line whose figures are not all zero changes what is due, the total
  // restated too ("Pay $1,000.00 to acme.near", "Visa ****4417 $700.00"), and so does a charge line with a bare
  // figure or a plus, excl. or extra note ("Shipping 25", "Excl. VAT") unless it is a term (ruling W-T13-B10); no
  // later total settles it.
  let lastFinal = -1;
  for (const f of finalAt) if (f > lastFinal) lastFinal = f;
  if (lastFinal >= 0) {
    for (const i of lines) {
      if (i <= lastFinal) continue;
      if (!moneyToken(g[i] ?? "")) {
        const su = v.u[i] ?? "";
        const term = LATE_TERM.test(su) || AFTER_TOTAL_TERM.test(su);
        const charge = AFTER_TOTAL_CHARGE.test(su);
        const open = /\d/.test(su) || AFTER_TOTAL_OPEN.test(su);
        if (charge && open && !term) return refuse("ambiguous");
        continue;
      }
      // Dates and percentages are no figures; a zero ("Amount paid $0.00") changes nothing.
      const row = (rows[i] ?? "").replace(DATES, " ").replace(PERCENT, " ");
      const figures = [...row.matchAll(MONEY_FIGURES)].map((m) =>
        unitsOf(m[1] ?? m[2] ?? m[3] ?? ""),
      );
      const nonzero = figures.filter((u) => u !== "0");
      if (nonzero.some((u) => u !== only)) return refuse("ambiguous");
      const zeroOnly = figures.length > 0 && nonzero.length === 0;
      if (!zeroOnly) return refuse("ambiguous");
    }
  }
  // 10. After a deduction, a balance equal to any money figure written before it ("Gross $1,000.00", a line item)
  // is ambiguous.
  if (lastDeduction >= 0) {
    for (const i of lines) {
      if (i >= lastDeduction) break;
      const row = (rows[i] ?? "").replace(DATES, " ").replace(PERCENT, " ");
      for (const m of row.matchAll(MONEY_FIGURES))
        if (unitsOf(m[1] ?? m[2] ?? m[3] ?? "") === only) return refuse("ambiguous");
    }
  }
  // Nor is it a partial total written before the deduction, or an amount already paid.
  if (
    lastDeduction >= 0 &&
    partials.some((p) => p.units === only && (p.paid || p.at < lastDeduction))
  )
    return refuse("ambiguous");
  // 1e. Last: a document pays only when it says it is an invoice.
  if (!invoiceTitled(v, lines)) return { amount: "0", issue: "not_payable", why: NOT_AN_INVOICE };
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
