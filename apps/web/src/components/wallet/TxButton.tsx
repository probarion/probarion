"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { buttonClass } from "@/components/ui";
import type { Network } from "@/lib/config";
import { actionKey, browserStore, clearLock, readLock, writeLock } from "@/lib/near/lock";
import { sendLocked, type TxResult } from "@/lib/near/outcome";
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
 * `lockKey` names the action for the lock when the transaction is only known after `prepare()`
 * (with `tx` the key is derived from the transaction itself).
 */
export function TxButton(props: {
  label: string;
  network: Network;
  tx?: WalletTx;
  prepare?: () => Promise<Prepared>;
  expectedSigner?: string;
  confirm?: string;
  lockKey?: string;
  onResult?: (r: TxResult) => void | Promise<void>;
}) {
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
      {result ? <TxResultNote result={result} network={props.network} account={accountId} /> : null}
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
