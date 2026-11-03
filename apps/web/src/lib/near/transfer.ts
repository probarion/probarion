/**
 * A plain NEAR transfer to a vault (R3 top-up). It lives here, not in tx.ts, which holds the
 * contract calls. Nothing here signs or sends.
 */
import type { TransferAction, WalletTx } from "./tx";
import { formatNear } from "./units";
import { isNearAccountId } from "./validate";

export type { TransferAction };

export interface TransferTx extends WalletTx {
  actions: [TransferAction];
}

const U128_MAX = 2n ** 128n - 1n;
const DIGITS = /^(0|[1-9][0-9]*)$/;

/** One Transfer of `yocto` to `receiverId`. A vault never gives NEAR back, so the summary says so. */
export function sendNearTx(receiverId: string, yocto: string): TransferTx {
  if (!isNearAccountId(receiverId)) throw new RangeError("receiverId must be a NEAR account id");
  if (!DIGITS.test(yocto) || BigInt(yocto) > U128_MAX || yocto === "0") {
    throw new RangeError("amount must be a positive whole number of yoctoNEAR (at most 2^128-1)");
  }
  return {
    receiverId,
    actions: [{ type: "Transfer", params: { deposit: yocto } }],
    summary: `Send ${formatNear(yocto, 6)} NEAR to ${receiverId} (it pays the vault's storage and gas, and cannot be withdrawn)`,
  };
}

/**
 * `WalletTx` (tx.ts) covers both contract calls and plain transfers now, so a `TransferTx` is one
 * as it is. Kept so callers written against the old cast keep compiling.
 */
export function asWalletTx(tx: TransferTx): WalletTx {
  return tx;
}
