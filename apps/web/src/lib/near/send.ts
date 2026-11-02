import type { Network } from "@/lib/config";
import {
  notSent,
  reportFromError,
  reportFromOutcome,
  type TxResult,
  unconfirmed,
  type WalletReport,
} from "./outcome";
import { actionLabel, isReadableMethod, type ReadableMethod, type WalletTx } from "./tx";

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
  /** Reads the transaction from the chain (the `confirmTxAction` server action). */
  confirm(
    hash: string,
    signerId: string,
    method: ReadableMethod,
    receiverId: string,
  ): Promise<TxResult>;
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

/**
 * Asks the wallet to sign and send ONE transaction, then asks the chain what happened.
 *
 * - The wallet is asked exactly once. Nothing here, on any path, signs the same action again.
 * - Before it is asked, the connected accounts are checked against `signerId`, so a wallet connected
 *   as someone else (also right after `connect()`) is refused before a signature is requested.
 * - What the wallet answers is used only to find the transaction hash and signer. The result comes
 *   from `deps.confirm`, which reads the chain; `ok` can only come from there.
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
  const signer = report.signerId ?? signerId ?? accounts[0] ?? null;
  if (signer === null) return unconfirmed(report);
  try {
    return asResult(
      await deps.confirm(report.txHash, signer, method, tx.receiverId),
      report.txHash,
    );
  } catch {
    return unconfirmed({
      ...report,
      message: "The transaction could not be confirmed from here; confirm on the explorer.",
    });
  }
}
