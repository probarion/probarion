/** One piece of a line of copy: plain text, or the inside of a pair of backticks. */
export interface RichPart {
  code: boolean;
  text: string;
}

/**
 * A line of copy split the way components/site/Rich.tsx shows it: the parts in backticks are code,
 * everything else is plain text, never Markdown. The .md twins use the same split, so a page and
 * its twin show the same words. Client-safe.
 */
export function richParts(text: string): RichPart[] {
  // The split captures each backtick pair, so the odd places are code.
  return text
    .split(/(`[^`]+`)/)
    .map((part, at) =>
      at % 2 === 1 ? { code: true, text: part.slice(1, -1) } : { code: false, text: part },
    )
    .filter((part) => part.text !== "");
}
