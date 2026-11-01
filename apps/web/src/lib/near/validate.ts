/**
 * NEAR account ids (nearcore's grammar): 2 to 64 characters, lowercase letters and digits in parts joined by a
 * single `-` or `_`, parts separated by dots. No separator at either end and never two in a row, so `a--b`, `a-.b`
 * and `.a` are out. A 64-character hex id (a named-by-key implicit account) and the `0x` + 40 hex form both fit.
 * Plan 03 Task 14 adds the same grammar to core; this file can delegate to it then.
 *
 * `$` (without the `m` flag) matches only at the very end, so a trailing newline does not slip through, and
 * `[a-z0-9]` is ASCII-only. The length is checked first, which also bounds the match on a hostile input.
 */
const NEAR_ACCOUNT = /^(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)*$/;

export function isNearAccountId(s: string): boolean {
  return typeof s === "string" && s.length >= 2 && s.length <= 64 && NEAR_ACCOUNT.test(s);
}
