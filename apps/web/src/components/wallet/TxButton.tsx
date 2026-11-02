"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { buttonClass } from "@/components/ui";
import type { Network } from "@/lib/config";
import { actionKey, browserStore, clearLock, readLock, writeLock } from "@/lib/near/lock";
import { type DescribeResult, sendLocked, type TxResult } from "@/lib/near/outcome";
import { actionLabel, type WalletTx } from "@/lib/near/tx";
import { TxResultNote } from "./TxResultNote";
import { useWallet } from "./WalletProvider";

type Prepared = WalletTx | { error: string };

/**
 * One button, one signature request per click. It never signs again by itself: a result the chain
 * could not confirm ("Sent: confirm on the explorer", or "Not confirmed" when the wallet gave no
 * transaction) locks the button until the owner says they checked, because the transaction may have
 * run. The lock survives a reload (sessionStorage, keyed by the action).
 *
 * With `tx` the lock is keyed by the transaction itself. With `prepare()` the transaction is only
 * known after the click, so a `lockKey` naming the action is REQUIRED, and the types enforce it:
 * without one a reload would forget an unconfirmed send and let the owner sign it again.
 */
export interface TxButtonBaseProps {
  label: string;
  network: Network;
  tx?: WalletTx;
  prepare?: () => Promise<Prepared>;
  expectedSigner?: string;
  confirm?: string;
  lockKey?: string;
  /** Wording for the result, live or read back after a reload (so a reloaded lock reads the same). */
  describe?: DescribeResult;
  onResult?: (r: TxResult) => void | Promise<void>;
}

/**
 * What a use of the button must add: a `lockKey` whenever it passes `prepare`. (A generic rather than
 * a union, so `ComponentProps<typeof TxButton>` and `Omit` keep working for wrappers; a wrapper that
 * forwards a loose `prepare?` should itself require a `lockKey` with it.)
 */
export type RequiredWithPrepare<P> = P extends { prepare: (...args: never[]) => unknown }
  ? { lockKey: string }
  : unknown;

export function TxButton<P extends TxButtonBaseProps>(props: P & RequiredWithPrepare<P>) {
  const { sendTx, accountId, ready } = useWallet();
  const router = useRouter();
  const inflight = useRef(false); // state updates are async; two fast clicks must not both sign
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<WalletTx | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TxResult | null>(null);
  const preview = props.tx ?? prepared;
  const locked = sendLocked(result);
  const wrongSigner = !!props.expectedSigner && !!accountId && accountId !== props.expectedSigner;
  const key = props.lockKey ?? (props.tx ? actionKey(props.tx) : null);

  // A reload must not undo the lock: pick it up again (after hydration, so server and client agree).
  useEffect(() => {
    // (also when the action changes, e.g. another vault name: its result is not this one's)
    setResult(readLock(browserStore(), key));
  }, [key]);

  async function run() {
    if (inflight.current || locked) return;
    if (props.confirm && !window.confirm(props.confirm)) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const next: Prepared | undefined = props.tx ?? (await props.prepare?.());
      if (!next) throw new Error("Nothing to sign");
      if ("error" in next) {
        setError(next.error);
        return;
      }
      setPrepared(next);
      const r = await sendTx(next, props.expectedSigner);
      writeLock(browserStore(), key ?? actionKey(next), r);
      setResult(r);
      try {
        await props.onResult?.(r);
      } catch (e) {
        console.error("TxButton onResult failed", e);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="my-2">
      <button
        type="button"
        className={buttonClass}
        disabled={!ready || busy || wrongSigner || locked}
        onClick={run}
      >
        {busy ? "Waiting for your wallet and the network…" : props.label}
      </button>
      {wrongSigner ? (
        <p className="mt-1 text-xs text-rose-700">
          Your wallet is connected as {accountId}; switch to {props.expectedSigner}.
        </p>
      ) : null}
      {preview ? (
        <p className="mt-1 text-xs text-stone-500">
          You sign: {preview.summary} — {preview.receiverId}.
          {preview.actions.map(actionLabel).join(" + ")}
        </p>
      ) : null}
      {error ? <p className="mt-1 text-xs text-rose-700">{error}</p> : null}
      {result ? (
        <TxResultNote
          result={result}
          network={props.network}
          account={accountId}
          describe={props.describe}
        />
      ) : null}
      {locked ? (
        <button
          type="button"
          className="mt-1 text-xs text-stone-600 underline"
          onClick={() => {
            clearLock(browserStore(), key ?? (preview ? actionKey(preview) : null));
            setResult(null);
          }}
        >
          I checked the explorer: unlock this button
        </button>
      ) : null}
    </div>
  );
}
