"use server";

import { getSession } from "@/lib/auth/guard";
import { serviceDb } from "@/lib/db/clients";
import { rateLimitOr429 } from "@/lib/http";
import { confirmTx } from "./confirm";
import { isTxHash, type TxResult } from "./outcome";

/** Per signed-in account: reading a transaction costs us an RPC call. */
const CONFIRM_LIMIT = [30, 60] as const;

function unknown(hash: string, error: string): TxResult {
  return {
    status: "unknown",
    txHash: isTxHash(hash) ? hash : null,
    code: null,
    error,
  };
}

/**
 * The console's way to ask "what really happened?" after a wallet call. Server Actions check the
 * request origin themselves; this adds a session (only a signed-in console user can spend our RPC
 * quota) and a per-account rate limit. It never throws: whatever goes wrong comes back as `unknown`,
 * which keeps the button locked and sends the owner to the explorer.
 */
export async function confirmTxAction(
  hash: string,
  signerId: string,
  method: string,
  receiverId: string,
): Promise<TxResult> {
  try {
    const session = await getSession();
    if (session === null) {
      return unknown(
        hash,
        "Sign in again to confirm this transaction here; confirm on the explorer.",
      );
    }
    const limited = await rateLimitOr429(
      serviceDb(),
      `confirm:${session.accountId}`,
      CONFIRM_LIMIT,
    );
    if (limited !== null) {
      return unknown(hash, "Too many confirmations just now; confirm on the explorer.");
    }
    return await confirmTx(hash, signerId, method, receiverId);
  } catch {
    return unknown(hash, "The transaction could not be confirmed here; confirm on the explorer.");
  }
}
