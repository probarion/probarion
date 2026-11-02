import "server-only";
import {
  firstReceiptSucceeded,
  isOutOfNearCode,
  LACK_BALANCE_CODE,
  OUT_OF_GAS_NEAR_DETAIL,
  OUT_OF_NEAR_DETAIL,
  parseTxOutcome as parseChainOutcome,
} from "@probarion/sdk";
import { type ChainOutcome, interpretChain, isTxHash, type TxResult } from "./outcome";
import { getRpc } from "./server";
import { isReadableMethod } from "./tx";
import { isNearAccountId } from "./validate";

/** The one RpcClient method used here, so a test can stand in for the network. */
export interface RpcLike {
  call<T>(method: string, params: unknown): Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknown(txHash: string | null, error: string): TxResult {
  return { status: "unknown", txHash, code: null, error };
}

/** Did any receipt of the transaction end in a Failure? (Only `outcome.status` counts, never the logs.) */
function anyReceiptFailed(raw: Record<string, unknown>): boolean {
  if (!Array.isArray(raw.receipts_outcome)) return false;
  return raw.receipts_outcome.some((r: unknown) => {
    const status = isRecord(r) && isRecord(r.outcome) ? r.outcome.status : undefined;
    return isRecord(status) && status.Failure !== undefined;
  });
}

/**
 * Is `raw` the transaction we asked about, and the one the owner was shown? The wallet gave us a
 * hash; nothing it said is trusted, so the chain's own record has to match the signer, the receiver
 * and the method of the transaction we prepared. Returns the reason it does not, else `null`.
 */
function mismatch(
  raw: Record<string, unknown>,
  hash: string,
  signerId: string,
  method: string,
  receiverId: string | undefined,
): string | null {
  const tx = raw.transaction;
  if (!isRecord(tx)) return "The network's answer has no transaction";
  if (tx.hash !== hash) return "The network answered about a different transaction";
  if (tx.signer_id !== signerId) return `That transaction was not signed by ${signerId}`;
  if (receiverId !== undefined && tx.receiver_id !== receiverId) {
    return "That transaction went to a different account than the one prepared";
  }
  const actions = tx.actions;
  const last: unknown = Array.isArray(actions) ? actions[actions.length - 1] : undefined;
  if (method === "Transfer") {
    // a plain transfer is `{ Transfer: { deposit } }` on chain
    return isRecord(last) && isRecord(last.Transfer)
      ? null
      : "That transaction does not end in a Transfer";
  }
  const call = isRecord(last) ? last.FunctionCall : undefined;
  if (!isRecord(call) || call.method_name !== method) {
    return `That transaction does not end in a ${method} call`;
  }
  return null;
}

/**
 * Reads the final outcome of a transaction from the chain and says what it means. The owner's wallet
 * is not asked and not believed: this takes only the hash and the signer it reported, waits for the
 * transaction to be final, checks it is the transaction that was prepared, and reads its result.
 * Anything that cannot be established (no node, no such transaction, a different transaction, a status
 * not final, an unreadable answer) is `unknown`, never `ok`.
 *
 * `receiverId` is the account the prepared transaction goes to; callers should always pass it.
 */
export async function confirmTx(
  hash: string,
  signerId: string,
  method: string,
  receiverId?: string,
  rpc: RpcLike = getRpc(),
): Promise<TxResult> {
  if (!isTxHash(hash)) return unknown(null, "That is not a transaction hash.");
  if (
    !isNearAccountId(signerId) ||
    !isReadableMethod(method) ||
    (receiverId !== undefined && !isNearAccountId(receiverId))
  ) {
    return unknown(hash, "The transaction details were malformed; confirm on the explorer.");
  }

  let raw: unknown;
  try {
    raw = await rpc.call<unknown>("tx", {
      tx_hash: hash,
      sender_account_id: signerId,
      wait_until: "FINAL",
    });
  } catch (e) {
    const why = e instanceof Error ? e.message.slice(0, 200) : "no answer";
    return unknown(
      hash,
      `The network could not be asked about this transaction (${why}); confirm on the explorer.`,
    );
  }
  if (!isRecord(raw))
    return unknown(hash, "The network's answer could not be read; confirm on the explorer.");

  const wrong = mismatch(raw, hash, signerId, method, receiverId);
  if (wrong !== null) return unknown(hash, `${wrong}; confirm on the explorer.`);

  let chain: ChainOutcome;
  try {
    const o = parseChainOutcome(raw);
    const status = isRecord(raw.status) ? raw.status : {};
    chain = {
      txHash: hash,
      ok: o.ok,
      failed: status.Failure !== undefined,
      value: o.value,
      empty: status.SuccessValue === "",
      code: o.code,
      failure: isOutOfNearCode(o.code)
        ? o.code === LACK_BALANCE_CODE
          ? OUT_OF_NEAR_DETAIL
          : OUT_OF_GAS_NEAR_DETAIL
        : o.failure,
      firstReceiptOk: firstReceiptSucceeded(raw),
      receiptFailed: anyReceiptFailed(raw),
    };
  } catch {
    return unknown(hash, "The network's answer could not be read; confirm on the explorer.");
  }
  return interpretChain(method, chain);
}
