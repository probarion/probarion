/** What stands where a character was removed (U+FFFD), so a reader can see that something was there. */
export const REMOVED = String.fromCodePoint(0xfffd);

/**
 * Control characters (`\p{Cc}`, newlines and tabs included: no table cell holds one), format characters
 * (`\p{Cf}`: the bidi overrides and isolates, zero-width characters, the soft hyphen) and the Unicode line and
 * paragraph separators (`\p{Zl}`, `\p{Zp}`).
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Text that came from the ledger or the chain, made safe to show. React escapes HTML, but a crafted ledger or
 * snapshot can still carry a right-to-left override that makes "fail" read as "pass", or a line break that makes
 * one value look like two. Every such character becomes U+FFFD. Any value is turned into text; nothing throws.
 */
export function safeText(value: unknown): string {
  return String(value).replace(UNSAFE, REMOVED);
}
