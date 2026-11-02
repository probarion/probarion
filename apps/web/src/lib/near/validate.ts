import { getAddress, isAddress } from "viem";

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

/**
 * A Base (EVM) payee address, for a mandate's NEAR Intents payee. The vault's own check
 * (contracts/vault/src/validate.rs `is_evm_address`) is `0x` and 40 hex digits in any case, and it stores
 * the address as written; core's A8 strict shape (`isEvmAddress`) is the same. This function accepts
 * only addresses the vault accepts, and is stricter in two ways the vault cannot be, because a wrong
 * payee is permanent:
 *  - a mixed-case address must carry a valid EIP-55 checksum (all lower or all upper case is an address
 *    written without one, and passes), so a mistyped character is caught here and not paid;
 *  - the zero address, where funds are lost, is refused.
 * Returns the EIP-55 form (what the console shows and sends), or null. Leading and trailing white space
 * is dropped; a `0X` prefix is refused, as the vault refuses it.
 */
export function parseBaseAddress(input: string): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return null;
  if (/^0x0{40}$/.test(s)) return null;
  const hex = s.slice(2);
  const mixedCase = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (mixedCase && !isAddress(s, { strict: true })) return null;
  return getAddress(s.toLowerCase());
}
