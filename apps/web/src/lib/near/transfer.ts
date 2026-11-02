/**
 * A plain NEAR transfer to a vault (R3 top-up). It lives here, not in tx.ts, which holds the
 * contract calls. Nothing here signs or sends.
 */
import type { WalletTx } from "./tx";
import { formatNear } from "./units";
import { isNearAccountId } from "./validate";

/** near-connect 0.11.4's `TransferAction` (build/actions/types.d.ts): the deposit only, no gas. */
export interface TransferAction {
  type: "Transfer";
  params: { deposit: string };
}

export interface TransferTx {
  receiverId: string;
  actions: [TransferAction];
  summary: string;
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
 * TxButton and the wallet provider take a `WalletTx`, whose actions tx.ts types as FunctionCall
 * only. near-connect's action union includes Transfer, and the provider hands `actions` to the
 * wallet unchanged, so the object is passed through as it is.
 * TODO(plan 04 Task 6): widen `WalletTx.actions` to `FunctionCallAction | TransferAction`, then
 * drop this cast.
 */
export function asWalletTx(tx: TransferTx): WalletTx {
  return tx as unknown as WalletTx;
}
