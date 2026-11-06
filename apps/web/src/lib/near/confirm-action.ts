"use server";

import { getSession } from "@/lib/auth/guard";
import { serviceDb } from "@/lib/db/clients";
import { rateLimitOr429 } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";
import { confirmTx, currentFinalHeight } from "./confirm";
import { type ConfirmRequest, isTxHash, type TxResult } from "./outcome";

/**
 * Two separate pairs of caps, so a send costs ONE token of the confirmation caps (its confirmation) and
 * one of the baseline caps (the height read when it starts), never two of the same.
 */
const CONFIRM_CAPS = { account: "confirm", all: "confirm:all" } as const;
const BASELINE_CAPS = { account: "baseline", all: "baseline:all" } as const;

function unknown(hash: unknown, error: string): TxResult {
  return { status: "unknown", txHash: isTxHash(hash) ? hash : null, code: null, error };
}

/** Signed in, and under both rate caps of `caps`. The account, or the reason not to go ahead. */
async function admit(caps: {
  account: string;
  all: string;
}): Promise<{ accountId: string } | string> {
  const session = await getSession();
  if (session === null) return "Sign in again to confirm this transaction here";
  const db = serviceDb();
  if (
    (await rateLimitOr429(db, `${caps.account}:${session.accountId}`, LIMITS.confirmPerAccount)) !==
    null
  ) {
    return "Too many confirmations just now";
  }
  if ((await rateLimitOr429(db, caps.all, LIMITS.confirmGlobal)) !== null) {
    return "The console is busy confirming transactions";
  }
  return { accountId: session.accountId };
}

/**
 * Called when a send begins: the final block height now. It has its own rate caps (`baseline:`), apart
 * from the confirmation's (`confirm:`). The transaction that comes back must be in a
 * block at least this new, so a hash from an earlier transaction cannot be shown as this one. `null`
 * when it cannot be read (the send then ends as "not confirmed", never as done). Never throws.
 */
export async function sendBaselineAction(): Promise<number | null> {
  try {
    if (typeof (await admit(BASELINE_CAPS)) === "string") return null;
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
    const who = await admit(CONFIRM_CAPS);
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
