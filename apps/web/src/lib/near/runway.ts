/**
 * A vault's NEAR runway (R3), with every constant in this one file. Pure bigint arithmetic, no I/O,
 * so client components can show the same numbers the server computed.
 *
 * A vault pays for its storage and its spends' gas from its own NEAR, and none of it ever comes
 * back: the vault has no NEAR-withdraw method. When the free NEAR runs out, spends fail with the
 * runtime error `LackBalanceForState` (not a `PROBARION:` code), and one plain transfer tops it up.
 * Sources: docs/runbooks/factory.md (runway note) and docs/runbooks/mainnet-v0.md (budget, top-up).
 */

const NEAR = 10n ** 24n;

/** Storage staking: 0.00001 NEAR (1e19 yocto) per byte the account stores. */
export const STORAGE_BYTE_COST_YOCTO = 10n ** 19n;

/**
 * About 0.0053 NEAR per paid spend: a paid or burned spend leaves about 480 bytes in the vault for
 * good (0.0048 NEAR of stake) and burns about 0.0005 NEAR of gas. A failed spend costs less (about
 * 0.0036 NEAR), so a runway counted in paid spends is the cautious figure.
 */
export const NEAR_PER_SPEND_YOCTO = (53n * NEAR) / 10_000n;

/** Below 0.1 NEAR free the overview shows the runway in amber. */
export const LOW_NEAR_YOCTO = NEAR / 10n;

/**
 * Below 0.05 NEAR free the vault is about to stop paying.
 * TODO(plan 04 Task 20): the watcher emits a `near_low` vault event (kind added in migration 0001)
 * at most once per UTC day below this. TODO(plan 04 Task 21): `near_low` is in the default alert
 * kinds of a new subscription.
 */
export const NEAR_LOW_ALERT_YOCTO = NEAR / 20n;

/** The vault wasm is 248,501 bytes (docs/runbooks/factory.md). An embedded vault stores its own copy. */
export const EMBEDDED_VAULT_WASM_BYTES = 248_501n;

/**
 * What the console assumes an embedded version's code costs: the measured wasm plus 10%, rounded up
 * (273,352 bytes, 2.73352 NEAR). The factory charges `code_len` bytes of the version it serves, and
 * its views do not say how many, so a rebuild a little larger than 248,501 bytes must still clear
 * the factory's check. Over-estimating is safe: what the code does not take stays in the vault as
 * free NEAR (runway).
 * TODO(ICR, interfaces v2 §5): expose `code_len` in the factory's `VersionView`, then read it here
 * instead of this estimate.
 */
export const EMBEDDED_CODE_ESTIMATE_BYTES = (EMBEDDED_VAULT_WASM_BYTES * 11n + 9n) / 10n;

/**
 * What a fresh vault stores besides its code: mainnet-v0 measured 250,733 bytes in all, 248,501 of
 * them code. Used only to estimate a new vault's runway before it exists.
 */
export const FRESH_VAULT_STATE_BYTES = 250_733n - 248_501n;

/**
 * The most the console attaches to `create_vault`: a failed creation (a taken name) is refunded
 * from the factory's own balance, and docs/runbooks/factory.md keeps 5 NEAR free for that
 * (MIN_FLOAT_NEAR, the liquidity rule). A larger deposit might not come back.
 */
export const MAX_CREATE_DEPOSIT_YOCTO = 5n * NEAR;

/** The most one "Send NEAR to this vault" sends: about 940 spends of runway, and it can never come back out. */
export const MAX_TOPUP_YOCTO = 5n * NEAR;

/** The suggested top-up: about 94 spends. */
export const DEFAULT_TOPUP_YOCTO = NEAR / 2n;

/** The two modes a factory version can have (contracts/factory/src/lib.rs `Mode::as_str`). */
export type FactoryMode = "global" | "embedded";

export interface NearRunway {
  /** Balance minus the storage stake, in yoctoNEAR (never below 0). */
  freeYocto: string;
  /** About how many more paid spends the free NEAR covers. */
  spends: number;
  /** Below LOW_NEAR_YOCTO: show it in amber and suggest a top-up. */
  low: boolean;
  /** Below NEAR_LOW_ALERT_YOCTO: the `near_low` alert threshold. */
  alert: boolean;
}

/** `amount - storage_usage * 1e19`, from the SDK's `viewAccount`. */
export function freeNearYocto(account: { amount: string; storage_usage: number }): bigint {
  const free = BigInt(account.amount) - BigInt(account.storage_usage) * STORAGE_BYTE_COST_YOCTO;
  return free > 0n ? free : 0n;
}

export function nearRunway(account: { amount: string; storage_usage: number }): NearRunway {
  const free = freeNearYocto(account);
  return {
    freeYocto: free.toString(),
    spends: Number(free / NEAR_PER_SPEND_YOCTO),
    low: free < LOW_NEAR_YOCTO,
    alert: free < NEAR_LOW_ALERT_YOCTO,
  };
}

/**
 * The storage of the vault's own copy of the code: embedded only (a global vault references it by
 * hash). The estimate with its margin, see EMBEDDED_CODE_ESTIMATE_BYTES.
 */
export function codeStorageYocto(mode: FactoryMode): bigint {
  return mode === "embedded" ? EMBEDDED_CODE_ESTIMATE_BYTES * STORAGE_BYTE_COST_YOCTO : 0n;
}

export interface CreateDepositPlan {
  /** What the factory requires (`required_deposit`): min_deposit, plus the code storage when embedded. */
  requiredYocto: bigint;
  /** The new vault's expected free NEAR: the deposit minus its code and state storage (never below 0). */
  freeYocto: bigint;
  /** About how many paid spends that covers. */
  spends: number;
  low: boolean;
  /** The deposit meets the factory's requirement and leaves the vault some free NEAR. */
  covers: boolean;
}

/** R14: what a `create_vault` deposit buys in this factory mode. */
export function createDepositPlan(
  minDeposit: string,
  mode: FactoryMode,
  depositYocto: bigint,
): CreateDepositPlan {
  const requiredYocto = BigInt(minDeposit) + codeStorageYocto(mode);
  const left =
    depositYocto - codeStorageYocto(mode) - FRESH_VAULT_STATE_BYTES * STORAGE_BYTE_COST_YOCTO;
  const freeYocto = left > 0n ? left : 0n;
  return {
    requiredYocto,
    freeYocto,
    spends: Number(freeYocto / NEAR_PER_SPEND_YOCTO),
    low: freeYocto < LOW_NEAR_YOCTO,
    covers: depositYocto >= requiredYocto && left > 0n,
  };
}
