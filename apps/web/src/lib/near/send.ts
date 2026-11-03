import type { Network } from "@/lib/config";
import {
  type ConfirmRequest,
  notSent,
  reportFromError,
  reportFromOutcome,
  type TxResult,
  unconfirmed,
  type WalletReport,
} from "./outcome";
import { actionLabel, isReadableMethod, toPrepared, type WalletTx } from "./tx";

/** The two near-connect wallet methods a send needs (build/types/index.d.ts `NearWalletBase`). */
export interface SendWallet {
  getAccounts(): Promise<{ accountId: string }[]>;
  signAndSendTransaction(p: {
    network: Network;
    receiverId: string;
    actions: WalletTx["actions"];
    signerId?: string;
  }): Promise<unknown>;
}

export interface SendDeps {
  network: Network;
  /** The connected wallet, or the selector popup. Throws when there is none. */
  getWallet(): Promise<SendWallet>;
  /** The final block height now (the `sendBaselineAction` server action), or `null` when it cannot be read. */
  baseline(): Promise<number | null>;
  /** Reads the transaction from the chain and checks it is the one shown (the `confirmTxAction` server action). */
  confirm(request: ConfirmRequest): Promise<TxResult>;
}

/** A server action's answer crossed the network: take only a well-formed result, for this hash. */
function asResult(value: unknown, hash: string): TxResult {
  const v = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const status = v.status;
  if (status !== "ok" && status !== "failed" && status !== "unknown") {
    return unconfirmed({ txHash: hash, signerId: null, message: null, code: null });
  }
  return {
    status,
    txHash: hash,
    code: typeof v.code === "string" ? v.code : null,
    error: typeof v.error === "string" ? v.error.slice(0, 500) : null,
  };
}

/** Calls `deps.baseline()` now (not on a later tick) and never rejects: anything but a block height is `null`. */
function startBaseline(deps: SendDeps): Promise<number | null> {
  let call: Promise<number | null>;
  try {
    call = deps.baseline();
  } catch {
    return Promise.resolve(null);
  }
  return Promise.resolve(call)
    .then((h) => (typeof h === "number" && Number.isSafeInteger(h) && h > 0 ? h : null))
    .catch(() => null);
}

/**
 * Asks the wallet to sign and send ONE transaction, then asks the chain what happened.
 *
 * - The wallet is asked exactly once. Nothing here, on any path, signs the same action again.
 * - Before it is asked, the connected accounts are checked against `signerId`, so a wallet connected
 *   as someone else (also right after `connect()`) is refused before a signature is requested.
 * - What the wallet answers is used only to find the transaction hash. The result comes from
 *   `deps.confirm`, which reads the chain, checks that it is the transaction that was shown (every
 *   action) and that it is newer than the moment the send began; `ok` can only come from there.
 * - The signer it checks against is `signerId`, the account the caller expected, whenever there is
 *   one, never the one the wallet says it used.
 * - No hash (a cancel, a closed window, a wallet that says nothing) is "not confirmed": we cannot
 *   tell it from a transaction that went out, so the caller locks the button like for `unknown`.
 * - It never throws.
 */
export async function sendWalletTx(
  deps: SendDeps,
  tx: WalletTx,
  signerId?: string,
): Promise<TxResult> {
  // The last call decides the transaction's result, and the per-method reader needs to know it.
  const last = tx.actions.at(-1);
  const method = last === undefined ? undefined : actionLabel(last);
  if (!isReadableMethod(method)) {
    return notSent(
      new Error("This console cannot read the result of that transaction, so it will not send it."),
    );
  }

  let wallet: SendWallet;
  try {
    wallet = await deps.getWallet();
  } catch (e) {
    return notSent(e);
  }

  let accounts: string[];
  try {
    accounts = (await wallet.getAccounts()).map((a) => a.accountId);
  } catch (e) {
    return notSent(
      new Error(
        `Could not read your wallet's accounts: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
  if (signerId !== undefined && !accounts.includes(signerId)) {
    return notSent(
      new Error(
        `Your wallet is connected as ${accounts[0] ?? "no account"}; switch to ${signerId}.`,
      ),
    );
  }

  // The chain height when the send begins. Started before the wallet is asked, so it is read long
  // before the owner can approve: the transaction must come out in a block at least this new.
  const baseline = startBaseline(deps);

  let report: WalletReport;
  try {
    const outcome = await wallet.signAndSendTransaction({
      network: deps.network,
      receiverId: tx.receiverId,
      actions: tx.actions,
      ...(signerId === undefined ? {} : { signerId }),
    });
    report = reportFromOutcome(outcome);
  } catch (e) {
    report = reportFromError(e);
  }

  if (report.txHash === null) return unconfirmed(report); // a report's hash is already base58 (outcome.ts)
  // The expected signer when there is one; only without one, the wallet's word or its first account
  // (the server then still requires it to be the signed-in account).
  const signer = signerId ?? report.signerId ?? accounts[0] ?? null;
  if (signer === null) return unconfirmed(report);
  try {
    return asResult(
      await deps.confirm({
        hash: report.txHash,
        signerId: signer,
        tx: toPrepared(tx),
        baselineHeight: await baseline,
      }),
      report.txHash,
    );
  } catch {
    return unconfirmed({
      ...report,
      message: "The transaction could not be confirmed from here; confirm on the explorer.",
    });
  }
}
