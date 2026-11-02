"use server";

import { getSession } from "@/lib/auth/guard";
import { serviceDb } from "@/lib/db/clients";
import { rateLimitOr429 } from "@/lib/http";
import { confirmTx, currentFinalHeight } from "./confirm";
import { type ConfirmRequest, isTxHash, type TxResult } from "./outcome";

/** Per signed-in account: reading the chain costs us an RPC call. */
const PER_ACCOUNT = [30, 60] as const;
/** All accounts together, on top of the per-account cap. */
const GLOBAL = [300, 60] as const;

function unknown(hash: unknown, error: string): TxResult {
  return { status: "unknown", txHash: isTxHash(hash) ? hash : null, code: null, error };
}

/** Signed in, and under both rate caps. `null` means go ahead; a string is the reason not to. */
async function admit(): Promise<{ accountId: string } | string> {
  const session = await getSession();
  if (session === null) return "Sign in again to confirm this transaction here";
  const db = serviceDb();
  if ((await rateLimitOr429(db, `confirm:${session.accountId}`, PER_ACCOUNT)) !== null) {
    return "Too many confirmations just now";
  }
  if ((await rateLimitOr429(db, "confirm:all", GLOBAL)) !== null) {
    return "The console is busy confirming transactions";
  }
  return { accountId: session.accountId };
}

/**
 * Called when a send begins: the final block height now. The transaction that comes back must be in a
 * block at least this new, so a hash from an earlier transaction cannot be shown as this one. `null`
 * when it cannot be read (the send then ends as "not confirmed", never as done). Never throws.
 */
export async function sendBaselineAction(): Promise<number | null> {
  try {
    if (typeof (await admit()) === "string") return null;
    return await currentFinalHeight();
  } catch {
    return null;
  }
}

/**
 * The console's way to ask "what really happened?" after a wallet call. Server Actions check the
 * request origin themselves; this adds a session (only a signed-in console user can spend our RPC
 * quota), the rule that the signer is that session's own account, a per-account and a global rate
 * cap, and then `confirmTx` re-checks every field of the request. It never throws: whatever goes
 * wrong comes back as `unknown`, which keeps the button locked and sends the owner to the explorer.
 */
export async function confirmTxAction(request: ConfirmRequest): Promise<TxResult> {
  const hash = typeof request === "object" && request !== null ? request.hash : undefined;
  try {
    const who = await admit();
    if (typeof who === "string") return unknown(hash, `${who}; confirm on the explorer.`);
    const signer = request.signerId;
    if (signer !== who.accountId) {
      return unknown(
        hash,
        `You are signed in as ${who.accountId}, so a transaction signed by another account cannot be confirmed here; confirm on the explorer.`,
      );
    }
    return await confirmTx(request);
  } catch {
    return unknown(hash, "The transaction could not be confirmed here; confirm on the explorer.");
  }
}
