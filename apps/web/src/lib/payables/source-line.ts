import { safeText } from "@/lib/proof/sanitize";
import { normaliseLineEnds, readAmount } from "./amount";

// The exact line an amount was read from (ruling W-T14-R2): the amount reader is deterministic, so re-running it on the
// retained text gives the line it read the agreed final total from. Nothing here searches for the figure.

/** The invoice's lines, split where the reader, the hash and the model split them. */
export const invoiceLines = (text: string): string[] => normaliseLineEnds(text).split("\n");

/** How many characters of one line the page shows. */
const MAX_SHOWN = 300;
/** Of those, how many stand before the figure when a long line is cut. */
const BEFORE_FIGURE = 120;
const CUT = "…";

/**
 * One line of the invoice's text as the page shows it: as written, blanks included, made safe and capped. A tab is
 * kept: in the page's <pre> it is layout and cannot forge a row, and safeText would show it as U+FFFD.
 */
export function verbatimLine(line: string): string {
  const points = Array.from(line);
  const cut = points.length > MAX_SHOWN;
  const kept = cut ? points.slice(0, MAX_SHOWN).join("") : line;
  const safe = kept
    .split("\t")
    .map((part) => safeText(part, MAX_SHOWN))
    .join("\t");
  return cut ? `${safe}${CUT}` : safe;
}

/** The spellings of a total of `units` (USDC base units), longest first: "1,277.350000" ... "1277.35", "20". */
function figureForms(units: string): string[] {
  const v = BigInt(units);
  const int = (v / 1_000_000n).toString();
  const frac = (v % 1_000_000n).toString().padStart(6, "0");
  const trimmed = frac.replace(/0+$/, "");
  const ints = [int, int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")];
  const fracs = [`.${frac}`, `.${trimmed.padEnd(2, "0")}`, ...(trimmed === "" ? [""] : [])];
  return [...new Set(ints.flatMap((i) => fracs.map((f) => `${i}${f}`)))].sort(
    (a, b) => b.length - a.length,
  );
}

/**
 * The line the reader named, made safe, with the figure in view: blanks collapse, and a line too long to show is cut
 * around the last place it writes the amount, not from its start. The reader chose this line; the figure is looked up
 * only to place the cut. When it is not found (digits written another way), the end of the line is kept, where a total
 * is written.
 */
export function aroundFigure(line: string, units: string): string {
  const flat = line.trim().replace(/\s+/g, " ");
  const points = Array.from(flat);
  if (points.length <= MAX_SHOWN) return safeText(flat, MAX_SHOWN);
  const form = figureForms(units).find((f) => flat.includes(f));
  const at = form === undefined ? -1 : Array.from(flat.slice(0, flat.lastIndexOf(form))).length;
  const wanted = at < 0 ? points.length - MAX_SHOWN : Math.max(0, at - BEFORE_FIGURE);
  const start = Math.min(wanted, points.length - MAX_SHOWN);
  const end = start + MAX_SHOWN;
  const shown = safeText(points.slice(start, end).join(""), MAX_SHOWN);
  return `${start > 0 ? CUT : ""}${shown}${end < points.length ? CUT : ""}`;
}

/**
 * The line the reader reads `units` from, numbered from 1 as the page shows it, made safe to show. Null when the reader
 * does not read that amount from this text (for example a reader newer than the upload), so the page claims no line.
 */
export function sourceLine(text: string, units: string): { number: number; text: string } | null {
  const read = readAmount(text);
  if (read.line === null || read.amount !== units) return null;
  return { number: read.line + 1, text: aroundFigure(invoiceLines(text)[read.line] ?? "", units) };
}
