"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import { busyLabel } from "@/components/pending/busy-label";
import { useElapsed } from "@/components/pending/hooks";
import { elapsedClock, hintText } from "@/components/pending/status-line";
import { actionButtonClass } from "@/components/ui";
import type { Network } from "@/lib/config";
import { type DangerTone, walletConfirm } from "@/lib/console/confirm-dialog";
import { actionKey, browserStore, clearLock, readLock, writeLock } from "@/lib/near/lock";
import { type DescribeResult, sendLocked, type TxResult } from "@/lib/near/outcome";
import { actionLabel, type WalletTx } from "@/lib/near/tx";
import {
  slowHint,
  TX_PHASE_LABEL,
  TX_PHASE_LABELS,
  TX_PHASE_LINE,
  type TxPhase,
} from "@/lib/ui/pending";
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
 *
 * While a click runs, the button says who it waits on (lib/ui/pending.ts): the console ("Preparing…"), the wallet
 * ("Check your wallet…"), NEAR ("Confirming on NEAR…"), the page's own finish, then "Updating the page…". Its one
 * status region, mounted from the first render, carries the line under it, the one slow hint and the result. While
 * busy it stays focusable (aria-disabled) and a click does nothing; `disabled` is only for a button that cannot act:
 * the wallet still loading, the wrong account, the lock. The wallet step never times out and is never reset here.
 */
export interface TxButtonBaseProps {
  label: string;
  network: Network;
  tx?: WalletTx;
  prepare?: () => Promise<Prepared>;
  expectedSigner?: string;
  /** Asks the owner first, in the console's own dialog: this text is its body, and the button's label its title. */
  confirm?: string;
  /** "danger" for what cannot be taken back: the dialog gets a red action button and a "Cannot be undone" line. */
  confirmTone?: DangerTone;
  lockKey?: string;
  /** Wording for the result, live or read back after a reload (so a reloaded lock reads the same). */
  describe?: DescribeResult;
  onResult?: (r: TxResult) => void | Promise<void>;
  /** The button's words while `onResult` runs, such as "Registering the vault…". Without it: "Finishing…". */
  finishing?: string;
  /**
   * Called with `true` when a click starts waiting for the wallet and the chain, and with `false` when that is over
   * (and once with `false` when the button mounts). Lets the page keep other actions, such as asking for a new
   * quote, switched off while a signature is open.
   */
  onBusyChange?: (busy: boolean) => void;
  /** Fills its row: the one decision on a phone-sized page. */
  wide?: boolean;
  /** Leaves out the "You sign" line, for a page that says itself what the wallet signs. */
  hidePreview?: boolean;
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
  // Who a running click waits on now. Only the words follow it: what is sent, and how often, does not.
  const [phase, setPhase] = useState<TxPhase>("wallet");
  // After a result the page reads its data again. Until it has, the button says so and a click does nothing.
  const [refreshing, startRefresh] = useTransition();
  const refreshingNow = useRef(refreshing); // set again before the refresh starts, ahead of the render that shows it
  refreshingNow.current = refreshing;
  const [prepared, setPrepared] = useState<WalletTx | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TxResult | null>(null);
  const { ask, dialog } = useConfirm();
  const preview = props.tx ?? prepared;
  const locked = sendLocked(result);
  const lockedNow = useRef(locked); // what the lock is now, for a check that comes after the dialog has answered
  lockedNow.current = locked;
  const wrongSigner = !!props.expectedSigner && !!accountId && accountId !== props.expectedSigner;
  const key = props.lockKey ?? (props.tx ? actionKey(props.tx) : null);

  // A reload must not undo the lock: pick it up again (after hydration, so server and client agree).
  useEffect(() => {
    // (also when the action changes, e.g. another vault name: its result is not this one's)
    setResult(readLock(browserStore(), key));
  }, [key]);

  const onBusyChange = useRef(props.onBusyChange);
  onBusyChange.current = props.onBusyChange;
  useEffect(() => {
    onBusyChange.current?.(busy);
  }, [busy]);

  // The unlock control goes away with the lock: hand the focus to the button it unlocked, not to the page.
  const button = useRef<HTMLButtonElement>(null);
  const unlocking = useRef(false);
  useEffect(() => {
    if (locked || !unlocking.current) return;
    unlocking.current = false;
    button.current?.focus();
  }, [locked]);

  // The phase's clock (aria-hidden, from 5 s) and its one hint: the wallet's at 20 s, NEAR's at 15 s. Neither ends
  // the wait: the wallet step has no timeout, and the chain read ends in a result or the lock.
  const elapsed = useElapsed(busy, phase);
  const waitingOn = phase === "wallet" || phase === "confirm" ? phase : null;
  const hint = busy && waitingOn ? slowHint(waitingOn, elapsed) : null;
  const line = busy ? TX_PHASE_LINE[phase] : null;
  const shown: TxPhase | null = busy ? phase : refreshing ? "refresh" : null;
  const now =
    shown === "finish" && props.finishing ? props.finishing : TX_PHASE_LABEL[shown ?? "wallet"];
  // Every label the button can show, its own included, so neither a phase nor the wallet becoming ready moves it.
  const sizes = [...TX_PHASE_LABELS, props.label, ...(props.finishing ? [props.finishing] : [])];
  const notReady = useId();

  async function run(opener?: HTMLElement) {
    if (inflight.current || locked) return;
    if (refreshingNow.current) return;
    if (props.confirm) {
      // A second click while the question is open is answered "no" by the dialog itself. A "no" returns here, before
      // the busy state, the in-flight guard, the error and the lock are touched: the button is as it was.
      const question = walletConfirm({
        label: props.label,
        confirm: props.confirm,
        confirmTone: props.confirmTone,
      });
      if (!(await ask(question, opener))) return;
      // The page was inert while the dialog was open, but what is true now decides, not what was true at the click.
      if (inflight.current || lockedNow.current) return;
      if (refreshingNow.current) return;
    }
    inflight.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    setPhase(props.tx ? "wallet" : "prepare");
    try {
      const next: Prepared | undefined = props.tx ?? (await props.prepare?.());
      if (!next) throw new Error("Nothing to sign");
      if ("error" in next) {
        setError(next.error);
        return;
      }
      setPrepared(next);
      setPhase("wallet");
      // NEAR's turn ("confirm") is told by the send itself, once the wallet has answered with a transaction.
      const r = await sendTx(next, props.expectedSigner, { onPhase: setPhase });
      writeLock(browserStore(), key ?? actionKey(next), r);
      setResult(r);
      if (props.onResult) setPhase("finish");
      try {
        await props.onResult?.(r);
      } catch (e) {
        console.error("TxButton onResult failed", e);
      }
      refreshingNow.current = true;
      startRefresh(() => router.refresh());
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
        ref={button}
        type="button"
        className={actionButtonClass(props.confirmTone, props.wide)}
        disabled={!ready || wrongSigner || locked}
        aria-disabled={busy || refreshing ? true : undefined}
        aria-describedby={ready ? undefined : notReady}
        onClick={(e) => run(e.currentTarget)}
      >
        {ready
          ? busyLabel(props.label, now, shown !== null, sizes)
          : busyLabel(props.label, props.label, true, sizes)}
      </button>
      {wrongSigner ? (
        <p className="mt-1 text-xs text-bad wrap-anywhere">
          Your wallet is connected as {accountId}; switch to {props.expectedSigner}.
        </p>
      ) : null}
      {preview && !props.hidePreview ? (
        <p className="mt-1 text-xs text-mute wrap-anywhere">
          You sign: {preview.summary} — {preview.receiverId}.
          {preview.actions.map(actionLabel).join(" + ")}
        </p>
      ) : null}
      {/* The button's one status region: phase changes, the hint and the outcome are read out; clocks are not. */}
      <div role="status">
        {line ? (
          <p className="mt-1 animate-pending-in text-xs text-mute wrap-anywhere">
            {line}
            {elapsedClock(elapsed)}
          </p>
        ) : null}
        {hint ? (
          <p key={`hint-${phase}`} className="mt-1 text-xs wrap-anywhere">
            {hintText(hint, elapsed)}
          </p>
        ) : null}
        {error ? <p className="mt-1 text-xs text-bad">{error}</p> : null}
        {result ? (
          <TxResultNote
            result={result}
            network={props.network}
            account={accountId}
            describe={props.describe}
            inRegion
          />
        ) : null}
      </div>
      {locked ? (
        <button
          type="button"
          className="mt-1 text-xs text-mute underline"
          onClick={() => {
            clearLock(browserStore(), key ?? (preview ? actionKey(preview) : null));
            unlocking.current = true;
            setResult(null);
          }}
        >
          I checked the explorer: unlock this button
        </button>
      ) : null}
      {ready ? null : (
        <span id={notReady} hidden>
          Loading your wallet…
        </span>
      )}
      {dialog}
    </div>
  );
}
