// Chain formats of the values a mandate payee holds (Task 14 B1): the NEAR AccountId grammar and the address
// and asset checks of contracts/vault/src/validate.rs. A8's strict shape uses them, so that a directive cannot
// ride in a payee field the model is shown.
import bs58 from "bs58";
import type { Chain } from "./types.js";

/**
 * The NEAR AccountId grammar (near-account-id): 2 to 64 characters, lowercase `[a-z0-9]` parts separated by
 * `.`, `_` or `-`, with no leading, trailing or doubled separator. A 64-hex implicit account (and a `0x` EVM
 * implicit account) is a single part, so it fits as well.
 */
const NEAR_ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** validate.rs `is_evm_address`: `0x` and 40 hex digits in any case (EIP-55 checksummed or not). */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** validate.rs `is_solana_address`: base58 (Bitcoin alphabet), 32 to 44 characters. */
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** validate.rs `asset_matches_chain`: a POA asset id carries its chain as a prefix (interfaces §3). */
const ASSET_PREFIX: Readonly<Record<Chain, string>> = { base: "base-", solana: "sol-" };

export function isNearAccountId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.length <= 64 &&
    NEAR_ACCOUNT_ID_RE.test(value)
  );
}

export function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && EVM_ADDRESS_RE.test(value);
}

export function isSolanaAddress(value: unknown): value is string {
  return typeof value === "string" && SOLANA_ADDRESS_RE.test(value);
}

/** The address format of `chain`, as the vault's `create_mandate` checks it. */
export function isChainAddress(chain: Chain, value: unknown): value is string {
  return chain === "base" ? isEvmAddress(value) : isSolanaAddress(value);
}

/** The asset is a NEAR account id (the contract's `AccountId`) whose prefix names `chain`. */
export function assetMatchesChain(chain: Chain, asset: unknown): asset is string {
  return isNearAccountId(asset) && asset.startsWith(ASSET_PREFIX[chain]);
}

/** `base-` or `sol-`: the prefix a POA asset id of `chain` starts with. */
export function assetPrefixOf(chain: Chain): string {
  return ASSET_PREFIX[chain];
}

/**
 * A NEAR transaction hash: base58 (Bitcoin alphabet) that decodes to exactly 32 bytes (T14 follow-up 2). Anything
 * else can never name a transaction, whatever a node answers when asked about it.
 */
export function isNearTxHash(value: unknown): value is string {
  // Every 32-byte value is 32 to 44 base58 characters, so this only bounds the cost of decoding; the decoded
  // length is what decides.
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}
