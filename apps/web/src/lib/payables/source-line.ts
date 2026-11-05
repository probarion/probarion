import { safeText } from "@/lib/proof/sanitize";
import { normaliseLineEnds, readAmount } from "./amount";

// The exact line an amount was read from (ruling W-T14-R2): the amount reader is deterministic, so re-running it on the
// retained text gives the line it read the agreed final total from. Nothing here searches for the figure.

/** The invoice's lines, split where the reader, the hash and the model split them. */
export const invoiceLines = (text: string): string[] => normaliseLineEnds(text).split("\n");

/**
 * The line the reader reads `units` from, numbered from 1 as the page shows it, made safe to show. Null when the reader
 * does not read that amount from this text (for example a reader newer than the upload), so the page claims no line.
 */
export function sourceLine(text: string, units: string): { number: number; text: string } | null {
  const read = readAmount(text);
  if (read.line === null || read.amount !== units) return null;
  return { number: read.line + 1, text: safeText(invoiceLines(text)[read.line] ?? "", 300) };
}
