/** What stands where a character was removed (U+FFFD), so a reader can see that something was there. */
export const REMOVED = String.fromCodePoint(0xfffd);

/** The default cap, in code points, for one string from the ledger or the chain. */
export const MAX_TEXT = 300;

const ELLIPSIS = String.fromCodePoint(0x2026);

/**
 * Control characters (`\p{Cc}`, newlines and tabs included: no table cell holds one), format characters
 * (`\p{Cf}`: the bidi overrides and isolates, zero-width characters, the soft hyphen) and the Unicode line and
 * paragraph separators (`\p{Zl}`, `\p{Zp}`).
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Combining marks past the second in a row. Real text stacks one or two; a long run paints over other rows. */
const MARK_RUN = /(\p{M}{2})\p{M}+/gu;

/**
 * Text that came from the ledger or the chain, made safe to show. React escapes HTML, but a crafted ledger or
 * snapshot can still carry a right-to-left override that makes "fail" read as "pass", a line break that makes one
 * value look like two, a run of combining marks that draws over the rows around it, or a value long enough to push
 * the page apart. Unsafe characters become U+FFFD, a run of marks keeps its first two, and the result is cut at `max`
 * code points (never inside one) with an ellipsis. Any value is turned into text; nothing throws.
 */
export function safeText(value: unknown, max: number = MAX_TEXT): string {
  const text = String(value).replace(UNSAFE, REMOVED).replace(MARK_RUN, "$1");
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max).join("")}${ELLIPSIS}` : text;
}
