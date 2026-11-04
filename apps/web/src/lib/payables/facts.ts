import type { InvoiceFacts, PayeeHint } from "@probarion/core";
import { parseUsdc } from "@/lib/near/units";

// Deterministic, code-level facts read from the extracted invoice text (interfaces §8). Nothing here decides
// anything: the amount is checked by the policy and the contract, and the payee hint is only evidence for
// `mandate.payee_mismatch`. The destination is always the mandate's payee, never something read from an invoice.

/**
 * Why the amount is "0" (rule `invoice.amount_invalid` refuses it, and the console says why), or null when it was
 * read: no final total; final totals that disagree; a total the code cannot read exactly (a sign, a figure in
 * another format, a label written with look-alike or hidden characters); another currency; a text cut short (a
 * PDF with more pages than are read, or text past the length limit), whose total may be missing; or a total of
 * zero. The list is also the `invoices.amount_issue` check constraint (migration 0006).
 */
export const AMOUNT_ISSUES = [
  "not_found",
  "ambiguous",
  "unreadable",
  "currency",
  "truncated",
  "zero",
] as const;
export type AmountIssue = (typeof AMOUNT_ISSUES)[number];

// ---------------------------------------------------------------------------------------------------------------
// The reading text. The amount is read from a normalised copy of the invoice text, never from the text itself:
//   - NFKC (W-T13-R2 b), so full-width digits, labels and spaces read as the plain ones they look like. Numerals
//     that are not plain digits (superscripts, circled numbers, fractions, Roman numerals) are kept as they are:
//     NFKC would turn "100\u00b2" into "1002". Kept, they are digit-like characters next to the figure, which
//     refuse it.
//   - Invisible characters (format characters and default-ignorable code points: zero-width spaces, soft hyphens,
//     bidi controls, joiners, variation selectors) and combining marks are taken out, so "To<ZWSP>tal" is still
//     seen as a label. The character next to each one is flagged as hidden, and a total whose span holds a hidden
//     character is unreadable: the text does not show what the code reads.
//   - A line that holds a bidi control can show its characters in another order than they are stored: a total on
//     it is unreadable.
//   - Every line break becomes "\n".
// Next to the reading text, a skeleton of the same length folds each letter to the plain lower-case letter it looks
// like (Cyrillic, Greek, Armenian, Cherokee, Lisu and other look-alikes, accented letters, 0 for o, 1 and I for l),
// so a label written with look-alikes is still seen, and flagged as folded: such a label is unreadable.
// ---------------------------------------------------------------------------------------------------------------

/** Past this many UTF-16 units of normalised text (NFKC can expand a character up to 18 times) nothing is read. */
const MAX_READ_UNITS = 200_000;

const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const MARK = /\p{M}/u;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/u;
const NUMERAL_RUNS = /[\p{Nl}\p{No}]+|[^\p{Nl}\p{No}]+/gu;
const NUMERAL = /^[\p{Nl}\p{No}]/u;
const LETTER = /\p{L}/u;
const DIGIT_LIKE = /\p{N}/u;
const CURRENCY_SYMBOL = /\p{Sc}/u;
/** A sign or an opening bracket before a figure (W-T13-R2 a): dashes, minus, plus, brackets. */
const SIGN = /[\p{Pd}\p{Ps}+\u2212\u2796\ufe63]/u;

/** Look-alike letters, by the plain letter they fold to ("l" also stands for i, I and 1, which look like it). */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  a: "\u0430\u0251\u03b1\u237a\uab64\u0410\u0391\u13aa\u15c5\ua4ee\u1d00",
  b: "\u042c\u044c\u13cf\u15af\u0184\u0412\u0432\u0392\u13f4\u15f7\ua4d0\u0299",
  c: "\u0441\u1d04\u2ca5\uabaf\u0421\u13df\ua4da\u2ca4\u217d\u216d",
  d: "\u0501\u146f\ua4d2\u13a0\u15ea\ua4d3\u217e\u216e",
  e: "\u0435\u04bd\u0454\u212e\u0415\u0395\u13ac\ua4f0\u2d39",
  g: "\u0261\u0581\u13c0\u050c\ua4d6\u13f3",
  l: "\u04cf\u01c0\u217c\ua4f2\ua4e1\u13de\u14aa\u2cd0\u216c\u0456\u0131\u0269\u03b9\ua647\u0406\u0399\u04c0\u2170\u2160",
  m: "\u043c\u041c\u039c\u13b7\ua4df\u03fa\u217f\u216f",
  n: "\u0578\u057c\u043f\u039d\ua4e0\u0274\u03b7",
  o: "\u043e\u03bf\u03c3\u0585\u0ed0\u12d0\u2c9f\u041e\u039f\u0555\u2c9e\ua4f3\u1d0f\u13eb",
  p: "\u0440\u03c1\u2ca3\u0420\u03a1\u13e2\ua4d1\u1d18",
  r: "\u0433\u1d26\u2c85\uab47\uab48\u0280\u13d2\ua4e3\u13a1",
  s: "\u0455\ua731\u01bd\u0405\u13da\ua4e2",
  t: "\u0442\u03c4\u0422\u03a4\u13a2\ua4d4\u2ca6",
  u: "\u03c5\u057d\u1d1c\uab4e\ua79f\u054d\u144c\ua4f4",
  y: "\u0443\u04af\u03b3\u0263\u0423\u04ae\u03a5\u13a9\ua4ec",
};
const FOLD = new Map<string, string>();
for (const [to, from] of Object.entries(LOOK_ALIKES)) for (const c of from) FOLD.set(c, to);

/** The skeleton letter of one character (a single UTF-16 unit for a BMP character, else the character). */
function skeletonOf(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x80) {
    const lower = ch.toLowerCase();
    if (lower === "i" || ch === "1" || ch === "|") return "l";
    if (ch === "0") return "o";
    return lower;
  }
  const look = FOLD.get(ch);
  if (look !== undefined) return look;
  if (cp <= 0xffff && LETTER.test(ch)) {
    const base = ch.normalize("NFD")[0] ?? ch;
    if (base !== ch && /^[A-Za-z]$/.test(base)) return skeletonOf(base);
  }
  return ch;
}

/** The normalised text the amount is read from, with what was hidden, folded or reordered in it. */
interface Reading {
  /** The reading text: NFKC (numerals other than plain digits kept), no invisible characters or marks. */
  r: string;
  /** The skeleton: `r` with every letter folded to its plain lower-case look-alike (same length as `r`). */
  s: string;
  /** Prefix counts over `r`: an invisible character or a mark was next to this unit. */
  hidden: Int32Array;
  /** Prefix counts over `r`: the skeleton letter is not the plain lower case of this unit. */
  folded: Int32Array;
  /** Prefix counts over `r`: this unit is on a line that holds a bidi control. */
  bidi: Int32Array;
  /** The index of the next "\n" at or after each unit (r.length if none). */
  nextBreak: Int32Array;
  /** The index of the next digit-like character (\p{N}) at or after each unit (r.length if none). */
  nextDigit: Int32Array;
}

function prefix(flags: Uint8Array, n: number): Int32Array {
  const out = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) out[i + 1] = (out[i] ?? 0) + (flags[i] ?? 0);
  return out;
}

function readingOf(text: string): Reading | null {
  let t = "";
  for (const run of text.match(NUMERAL_RUNS) ?? [])
    t += NUMERAL.test(run) ? run : run.normalize("NFKC");
  if (t.length > MAX_READ_UNITS) return null;
  const r: string[] = [];
  const s: string[] = [];
  const hidden = new Uint8Array(t.length + 1);
  const folded = new Uint8Array(t.length + 1);
  const bidi = new Uint8Array(t.length + 1);
  let n = 0;
  let pendingHidden = false;
  let lineStart = 0;
  let lineBidi = false;
  const endLine = () => {
    if (lineBidi) bidi.fill(1, lineStart, n);
    lineStart = n;
    lineBidi = false;
  };
  for (const ch of t) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x80) {
      if (INVISIBLE.test(ch)) {
        if (BIDI.test(ch)) lineBidi = true;
        pendingHidden = true;
        continue;
      }
      if (MARK.test(ch)) {
        if (n > 0) hidden[n - 1] = 1;
        else pendingHidden = true;
        continue;
      }
    }
    if (LINE_BREAK.test(ch)) {
      hidden[n] = pendingHidden ? 1 : 0;
      pendingHidden = false;
      r.push("\n");
      s.push("\n");
      n += 1;
      endLine();
      continue;
    }
    const sk = skeletonOf(ch);
    hidden[n] = pendingHidden ? 1 : 0;
    pendingHidden = false;
    folded[n] = sk !== ch.toLowerCase() ? 1 : 0;
    r.push(ch);
    s.push(sk.length === ch.length ? sk : ch);
    n += ch.length;
  }
  endLine();
  const rs = r.join("");
  const nextBreak = new Int32Array(n + 1).fill(n);
  const nextDigit = new Int32Array(n + 1).fill(n);
  for (let i = n - 1; i >= 0; i--) {
    nextBreak[i] = rs.charCodeAt(i) === 10 ? i : (nextBreak[i + 1] ?? n);
    const c = rs.charCodeAt(i);
    const digit =
      (c >= 48 && c <= 57) ||
      (c >= 0x80 && DIGIT_LIKE.test(String.fromCodePoint(rs.codePointAt(i) ?? 0)));
    nextDigit[i] = digit ? i : (nextDigit[i + 1] ?? n);
  }
  return {
    r: rs,
    s: s.join(""),
    hidden: prefix(hidden, n),
    folded: prefix(folded, n),
    bidi: prefix(bidi, n),
    nextBreak,
    nextDigit,
  };
}

const any = (p: Int32Array, from: number, to: number) => (p[to] ?? 0) - (p[from] ?? 0) > 0;

// ---------------------------------------------------------------------------------------------------------------
// Labels. A final total is labelled "Total", "Total due", "Total amount (due)", "Total balance due", "Grand total
// (due)", "Amount due" or "Balance due", in any case. The label pattern runs on the skeleton, and also accepts a
// fully letter-spaced word ("T o t a l") and "rn" for "m": both are seen, and both are unreadable. Every quantifier
// is bounded (W-T13-R2 f): the pattern runs in linear time.
// ---------------------------------------------------------------------------------------------------------------

const LABEL_WORDS: readonly (readonly string[])[] = [
  ["grand", "total", "due"],
  ["grand", "total"],
  ["total", "amount", "due"],
  ["total", "balance", "due"],
  ["total", "due"],
  ["total", "amount"],
  ["amount", "due"],
  ["balance", "due"],
  ["total"],
];
const labelWord = (w: string) =>
  `(?:${[...w].map((c) => (c === "m" ? "(?:m|rn)" : c)).join("")}|${[...w].join("[ \\t]")})`;
const LABEL = new RegExp(
  LABEL_WORDS.map((ws) => ws.map(labelWord).join("\\s{1,40}")).join("|"),
  "g",
);
const CANONICAL_LABEL = new RegExp(`^(?:${LABEL_WORDS.map((ws) => ws.join("\\s+")).join("|")})$`);
/**
 * A word that makes the total on its line a partial total or another document's ("Sub-total", "Page total",
 * "Contract total", "Year-to-date total", "YTD total", "Installment total"), in skeleton spelling ("l" for i).
 * It must be on the label's own line: a word at the end of the line above never hides a total.
 */
const EXCLUDED =
  /(?:^|[^a-z0-9])(?:sub|page|contract|ytd|year[ \t-]{0,3}to[ \t-]{0,3}date|lnstall?ment)$/;
const EXCLUDED_GLUED = /(?:^|[^a-z0-9])(?:sub|page|contract|ytd|yeartodate|lnstall?ment)$/;
/** The one separator group between a label and its figure (W-T13-R2 f): bounded, so it cannot backtrack. */
const SEPARATOR = /[\s:-]{0,40}/y;
/** After a currency code: spaces, an optional colon, spaces (the figure may sit on the next line). */
const AFTER_CODE = /[^\S\n]{0,40}:?\s{0,40}/y;
const SPACES = /\s{0,40}/y;

// ---------------------------------------------------------------------------------------------------------------
// Figures and currencies.
// ---------------------------------------------------------------------------------------------------------------

/** The currency codes that mean US dollars, which the vault pays in USDC. */
const USD_CODES: ReadonlySet<string> = new Set(["USDC", "USD"]);
/** Codes of other currencies, in any case (any other word of 3 to 5 capitals counts as one too). */
const OTHER_CODES: ReadonlySet<string> = new Set(
  "EUR GBP JPY CHF CAD AUD NZD INR CNY RMB SGD HKD KRW VND MXN BRL ZAR RUB TRY SEK NOK DKK PLN USDT EURC DAI BTC ETH NEAR".split(
    " ",
  ),
);
const OTHER_CODE_NEARBY = new RegExp(
  `(?<![A-Za-z])(?:${[...OTHER_CODES].join("|")})(?![A-Za-z])|[^\\P{Sc}$]`,
  "u",
);
/** Thousands written as 1,000 or 1,000,000 (never 12,5 or 1,25,000), with an optional decimal part. */
const GROUPED = /^[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?$/;
const PLAIN = /^[0-9]+(?:\.[0-9]+)?$/;
/** W-T13-R2 d: "10.000" or "1.000" may be ten thousand or one thousand written with a dot. */
const DOT_THOUSANDS = /^[0-9]+\.[0-9]{3}$/;
/** Punctuation that may end a figure (or its currency): sentence punctuation and closing brackets or quotes. */
const CLOSING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", '"', "\u201d", "\u00bb"]);
/** A number written in words after a label ("Total: nine thousand USDC"): the label is a total, never dropped. */
const NUMBER_WORD =
  /(?<![A-Za-z])(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)(?![A-Za-z])/i;
/** An accounting credit or debit mark after a total's currency: the total is not a plain amount due. */
const CREDIT = /^(?:cr|dr|credit|debit)$/i;
/** After a space, an opening bracket or quote may follow a figure too ("100 (incl. VAT)"). */
const AFTER_SPACE = new Set([...CLOSING, "(", "[", "{", "\u201c", "\u00ab"]);

type Marker = "usd" | "other";
/** A currency word: USDC/USD, another known code, or any other word of 3 to 5 capitals; else null. */
function codeOf(word: string): Marker | null {
  const up = word.toUpperCase();
  if (USD_CODES.has(up)) return "usd";
  if (OTHER_CODES.has(up) || /^[A-Z]{3,5}$/.test(word)) return "other";
  return null;
}

type Occurrence = { at: number; units: string } | { at: number; issue: AmountIssue } | null;

/** Reads every final total of the text, in order: a value, an issue, or null for a label that is not a total. */
class AmountReader {
  private readonly n: number;
  constructor(private readonly x: Reading) {
    this.n = x.r.length;
  }

  private cp(i: number): number {
    return this.x.r.codePointAt(i) ?? -1;
  }
  private ch(i: number): string {
    return i < this.n ? String.fromCodePoint(this.cp(i)) : "";
  }
  private isDigit(i: number): boolean {
    const c = this.x.r.charCodeAt(i);
    return c >= 48 && c <= 57;
  }
  private isLetter(i: number): boolean {
    return i < this.n && LETTER.test(this.ch(i));
  }
  private isDigitLike(i: number): boolean {
    return i < this.n && DIGIT_LIKE.test(this.ch(i));
  }
  private isSpace(i: number): boolean {
    return i < this.n && /\s/.test(this.x.r[i] ?? "");
  }
  private sticky(re: RegExp, at: number): number {
    re.lastIndex = at;
    re.exec(this.x.r);
    return Math.max(re.lastIndex, at);
  }
  /** The letters from `at` (at most 12; a longer run is no currency code). */
  private word(at: number): { word: string; end: number } {
    let end = at;
    while (end < this.n && end - at <= 12 && this.isLetter(end)) end += this.ch(end).length;
    return { word: this.x.r.slice(at, end), end };
  }
  /** A final label's line holds a digit-like character after the label. */
  private lineHasDigit(at: number): boolean {
    return (this.x.nextDigit[at] ?? this.n) < (this.x.nextBreak[at] ?? this.n);
  }

  /** One label match at [start, end) of the skeleton. */
  occurrence(start: number, end: number): Occurrence {
    const { r, s } = this.x;
    // The left side: a partial total (skipped), or a label glued to another word (never a total).
    let compound = false;
    if (start > 0 && (this.isLetter(start - 1) || this.isDigitLike(start - 1))) {
      if (EXCLUDED_GLUED.test(s.slice(Math.max(0, start - 24), start))) return null;
      compound = true;
    } else {
      let k = start;
      while (k > 0 && /[^\S\n]|\p{Pd}/u.test(r[k - 1] ?? "")) k--; // linear: each run is walked by one label
      if (EXCLUDED.test(s.slice(Math.max(0, k - 24), k))) return null;
    }
    if (this.isLetter(end)) compound = true; // "Totals", "Totally"
    const odd =
      compound ||
      !CANONICAL_LABEL.test(s.slice(start, end)) ||
      any(this.x.folded, start, end) ||
      any(this.x.hidden, start, end);

    const sepEnd = this.sticky(SEPARATOR, end);
    // W-T13-R2 b: a label followed by a digit-like, sign or bracket token, or with a digit or a number word later
    // on its line, is a total: it is read, or the amount is refused. Any other label (a heading, "Total due upon
    // receipt") is not.
    const counted =
      this.isDigitLike(sepEnd) ||
      SIGN.test(this.ch(sepEnd)) ||
      this.lineHasDigit(end) ||
      NUMBER_WORD.test(r.slice(end, Math.min(end + 80, this.x.nextBreak[end] ?? this.n)));
    const unreadable: Occurrence = counted ? { at: start, issue: "unreadable" } : null;
    if (odd) return unreadable;

    // W-T13-R2 a: a dash with only spaces between it and the currency or figure is a minus sign.
    let back = sepEnd;
    while (back > end && this.isSpace(back - 1)) back--;
    const signed = back > end && r[back - 1] === "-";

    const markers: Marker[] = [];
    let p = sepEnd;
    if (this.isLetter(p)) {
      const w = this.word(p);
      if (r[w.end] === "$" && /^[A-Z]{1,3}$/.test(w.word)) {
        markers.push(w.word === "US" || w.word === "USD" ? "usd" : "other"); // US$, C$, HK$
        p = this.sticky(SPACES, w.end + 1);
      } else {
        const code = codeOf(w.word);
        if (code === null) return unreadable; // "Total payable: 100", "Total due upon receipt"
        markers.push(code);
        p = this.sticky(AFTER_CODE, w.end);
      }
    }
    if (CURRENCY_SYMBOL.test(this.ch(p))) {
      markers.push(r[p] === "$" ? "usd" : "other");
      p = this.sticky(SPACES, p + this.ch(p).length);
    }
    if (!this.isDigit(p)) {
      if (this.isDigitLike(p) || SIGN.test(this.ch(p))) return { at: start, issue: "unreadable" };
      return unreadable; // or a heading such as "Total USD" over a table
    }
    if (signed) return { at: start, issue: "unreadable" };

    // The figure: digits, with "." or "," only between digits. Its end must be clean (W-T13-R2 c).
    let q = p;
    while (
      q < this.n &&
      (this.isDigit(q) || ((r[q] === "." || r[q] === ",") && this.isDigit(q + 1)))
    ) {
      q++;
    }
    const figure = r.slice(p, q);
    const tail = this.after(q, markers);
    if (tail === null) return { at: start, issue: "unreadable" };
    // A figure on a later line than its label must be all of that line ("Total\n$40.10").
    if (r.slice(end, p).includes("\n") && (this.x.nextBreak[tail] ?? this.n) > tail) {
      if (r.slice(tail, this.x.nextBreak[tail] ?? this.n).trim() !== "") {
        return { at: start, issue: "unreadable" };
      }
    }
    if (any(this.x.hidden, start, tail) || any(this.x.bidi, start, tail)) {
      return { at: start, issue: "unreadable" };
    }
    if (markers.some((m) => m === "other")) return { at: start, issue: "currency" };
    if (markers.length === 0) {
      const near = r.slice(q, Math.min(q + 80, this.x.nextBreak[q] ?? this.n));
      if (OTHER_CODE_NEARBY.test(near)) return { at: start, issue: "currency" }; // "Total 100 (EUR)"
    }
    if (!PLAIN.test(figure) && !GROUPED.test(figure)) return { at: start, issue: "unreadable" };
    if (DOT_THOUSANDS.test(figure)) return { at: start, issue: "unreadable" };
    try {
      return { at: start, units: parseUsdc(figure.replace(/,/g, "")) };
    } catch {
      return { at: start, issue: "unreadable" };
    }
  }

  /**
   * What follows a figure ending at `q` (W-T13-R2 c): the end of the text, a space and then no digit, closing
   * punctuation and then no digit, or a currency (code or symbol, pushed to `markers`) that itself ends cleanly.
   * Returns where the total ends, or null when the figure does not end cleanly (another grouping separator, a
   * date, a range, a percent, a count, a second number).
   */
  private after(q: number, markers: Marker[]): number | null {
    const { r } = this.x;
    if (q >= this.n) return q;
    let at = q;
    if (this.isSpace(at)) {
      let crossed = false;
      while (this.isSpace(at)) {
        if (r[at] === "\n") crossed = true;
        at++;
      }
      if (at >= this.n) return q;
      if (this.isDigitLike(at)) return null; // "1 000", "100  200"
      if (crossed) return q;
      if (!this.isLetter(at) && !CURRENCY_SYMBOL.test(this.ch(at))) {
        return AFTER_SPACE.has(r[at] ?? "") ? q : null; // "100 %", "100 - 200", "100 / month"
      }
    }
    if (this.isLetter(at)) {
      const w = this.word(at);
      const code = codeOf(w.word);
      if (code === null) return null; // "100 items", "100k", "1e6"
      markers.push(code);
      return this.afterCurrency(w.end);
    }
    if (CURRENCY_SYMBOL.test(this.ch(at))) {
      markers.push(r[at] === "$" ? "usd" : "other");
      return this.afterCurrency(at + this.ch(at).length);
    }
    // "100." or "100, payable", but not "10:30" or "1, 000"
    if (CLOSING.has(r[at] ?? "")) return this.digitNext(at + 1) ? null : at;
    return null; // "-", "/", "%", "'", "_", a middle dot, another digit
  }

  /**
   * A currency after a figure ends cleanly too: "100 USDC.", "100 USDC for PO-1", but not "100 USDC 200",
   * "100 USDC/month" or a credit ("100 USDC CR").
   */
  private afterCurrency(e: number): number | null {
    const { r } = this.x;
    if (e >= this.n) return e;
    if (this.isSpace(e)) {
      let at = e;
      while (this.isSpace(at) && r[at] !== "\n") at++;
      if (this.isDigitLike(at)) return null;
      return CREDIT.test(this.word(at).word) ? null : e;
    }
    if (CLOSING.has(r[e] ?? "")) return this.digitNext(e + 1) ? null : e;
    return null; // "USDC/month", "USD-", "$%"
  }

  /** The next character on the same line, past spaces, is digit-like. */
  private digitNext(at: number): boolean {
    let k = at;
    while (this.isSpace(k) && this.x.r[k] !== "\n") k++;
    return this.isDigitLike(k);
  }

  /** A word of Latin and other-script letters with a digit later on its line (a look-alike outside the table). */
  mixedScript(): Occurrence {
    for (const m of this.x.r.matchAll(/\p{L}+/gu)) {
      const w = m[0];
      if (/^[A-Za-z]+$/.test(w) || !/\p{Script=Latin}/u.test(w)) continue;
      if (!/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(w)) continue;
      if (this.lineHasDigit(m.index + w.length)) return { at: m.index, issue: "unreadable" };
    }
    return null;
  }
}

/**
 * The invoice amount in USDC smallest units, failing closed (W-T13-R1, W-T13-R2). Every final total in the text
 * must be readable, positive, in US dollars, and all must agree ("Total: 100 ... Total due: 9,999" is refused,
 * never one of the two picked). A final label followed by a figure, sign or bracket, or with a digit later on its
 * line, is a total: if it cannot be read exactly, the amount is "0", never another total. In rules-only mode this
 * amount goes straight to `spend`, so anything doubtful is "0" with its reason.
 */
function readAmount(text: string): { amount: string; issue: AmountIssue | null } {
  const reading = readingOf(text);
  if (reading === null) return { amount: "0", issue: "unreadable" };
  const reader = new AmountReader(reading);
  const found: Exclude<Occurrence, null>[] = [];
  for (const m of reading.s.matchAll(LABEL)) {
    const o = reader.occurrence(m.index, m.index + m[0].length);
    if (o !== null) found.push(o);
  }
  const mixed = reader.mixedScript();
  if (mixed !== null) found.push(mixed);
  let issue: { at: number; issue: AmountIssue } | null = null;
  const values = new Set<string>();
  for (const o of found) {
    if ("issue" in o) {
      if (issue === null || o.at < issue.at) issue = o;
    } else values.add(o.units);
  }
  if (issue !== null) return { amount: "0", issue: issue.issue };
  const [only, ...more] = [...values];
  if (only === undefined) return { amount: "0", issue: "not_found" };
  if (more.length > 0) return { amount: "0", issue: "ambiguous" };
  if (only === "0") return { amount: "0", issue: "zero" };
  return { amount: only, issue: null };
}

// R26: "PO" must be a word of its own (not "Power", "Policy", "Postal") and a reference has a digit in it. Every
// quantifier below is bounded, and no two of them can share the same run of spaces (W-T13-R2 f).
/** A reference that starts with PO itself: "PO-4471", "PO4471". */
const PO_TOKEN = /\b(PO[-#]?[0-9][A-Z0-9-]{1,30})(?![A-Z0-9-])/i;
/** A labelled reference: "PO: 4471", "P.O. number 7781", "Purchase order #4471-A". */
const PO_LABELLED =
  /\b(?:P\.?O\b\.?|purchase[ \t]{1,40}order\b)[ \t]{0,40}(?:(?:#|no\.?|number)[ \t]{0,40})?(?:[:-][ \t]{0,40})?((?=[A-Z0-9-]{0,31}[0-9])[A-Z0-9][A-Z0-9-]{2,31})(?![A-Z0-9-])/i;
const INVOICE_NO =
  /\binvoice[ \t]{0,40}(?:(?:#|no\.?|number|num\.?|id)[ \t]{0,40})?(?:[:-][ \t]{0,40})?((?=[A-Z0-9/-]{0,31}[0-9])[A-Z0-9][A-Z0-9/-]{0,31})(?![A-Z0-9/-])/i;
/** A NEAR account: at most 32 parts of at most 64 characters (NEAR caps an account id at 64). */
const NEAR_ACCOUNT = /\b((?:[a-z0-9_-]{1,64}\.){1,32}(?:near|testnet))\b/;
const EVM_ADDRESS = /\b(0x[0-9a-fA-F]{40})\b/;
const NAME =
  /^[ \t]{0,40}(?:from|vendor|bill[ \t]{1,40}from|payee|supplier)[ \t]{0,40}:[ \t]{0,40}(.{2,80})$/im;

/** The PO reference, copied verbatim from the text (the SDK requires a verbatim substring), or null. */
function poRef(text: string): string | null {
  return PO_TOKEN.exec(text)?.[1] ?? PO_LABELLED.exec(text)?.[1] ?? null;
}

/**
 * Deterministic, code-level facts. `invoiceNumber` and `amountIssue` are for display only: the caller passes just
 * the five `InvoiceFacts` keys to `Probarion.process` (R26). The payee hint is evidence for
 * mandate.payee_mismatch, never a destination. `truncated`: the text is not the whole invoice (pages or length
 * past the limits), so its total cannot be trusted and the amount is "0".
 */
export function extractFacts(
  text: string,
  invoiceHash: string,
  purposeHash: string | null,
  opts: { truncated?: boolean } = {},
): InvoiceFacts & { invoiceNumber: string | null; amountIssue: AmountIssue | null } {
  const hint: PayeeHint = {};
  const name = NAME.exec(text)?.[1]?.trim();
  if (name) hint.name = name;
  const evm = EVM_ADDRESS.exec(text)?.[1];
  if (evm) {
    hint.chain = "base";
    hint.address = evm;
  }
  const near = NEAR_ACCOUNT.exec(text)?.[1];
  if (near) hint.near_account = near;
  const read = opts.truncated ? { amount: "0", issue: "truncated" as const } : readAmount(text);
  return {
    invoice_hash: invoiceHash,
    amount: read.amount,
    po_ref: poRef(text),
    purpose_hash: purposeHash,
    payee_hint: Object.keys(hint).length > 0 ? hint : null,
    invoiceNumber: INVOICE_NO.exec(text)?.[1] ?? null,
    amountIssue: read.issue,
  };
}

/** Idempotency key for spend(): at most 64 bytes and unique per invoice text (IF §4.1). */
export function refFor(invoiceHash: string): string {
  return `inv-${invoiceHash.slice(0, 24)}`;
}
