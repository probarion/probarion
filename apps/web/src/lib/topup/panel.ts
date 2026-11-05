import type { WalletTx } from "@/lib/near/tx";
import { type QuoteBlock, quoteBlock } from "./block";
import type { VerifiedQuote } from "./oneclick";

/**
 * The Base top-up panel's state as pure functions, so the part that decides whether a quote may be signed is
 * tested without a browser. The component only dispatches events and draws the state.
 */

/** A quote the server verified, the transaction it built from it, and the amount typed when it was asked for. */
export interface Quoted {
  quote: VerifiedQuote;
  tx: WalletTx;
  asked: string;
}

/** The deposit address whose 1Click status is being read, and what it said last. */
export interface Watching {
  address: string;
  status: string | null;
  gaveUp: boolean;
  /** Counts the times reading started for this panel, so a second start for the same address restarts the reading. */
  run: number;
}

export interface PanelState {
  quoted: Quoted | null;
  /** A deposit for the quote on screen was sent, or may have been. It is never offered for signing again. */
  used: boolean;
  /** The wallet is open for the quote on screen. */
  signing: boolean;
  watching: Watching | null;
}

export const initialPanel: PanelState = {
  quoted: null,
  used: false,
  signing: false,
  watching: null,
};

/** 1Click's final states: after one of them there is nothing more to read. */
export const FINAL_STATUS: ReadonlySet<string> = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

/** What a wallet call came back with (a `TxResult`, without the fields the panel does not use). */
export interface DepositResult {
  status: "ok" | "failed" | "unknown";
  txHash: string | null;
}

export interface ResultEffects {
  /** The quote is used up: a deposit for it was sent, or may have been. */
  used: boolean;
  /** Start reading 1Click's status for the deposit address. */
  poll: boolean;
  /** Tell 1Click the transaction hash (a speed-up; it is only ever a hash the chain confirmed). */
  submit: boolean;
}

/**
 * What each kind of wallet result means for the panel:
 * - ok: the deposit is on chain. Used up, 1Click is told its hash, its status is read.
 * - unknown: it may have gone out (or not: a closed wallet gives no hash). Its status is read, which tells whether
 *   1Click saw a deposit; with a hash the quote is used up; 1Click is told nothing, because nothing is confirmed.
 * - failed: the chain refused it, or it never left. Nothing is read or told, and the quote is not used up: the guards
 *   (expiry, amount, 1Click's status) alone decide whether it may be signed again.
 */
export function onDepositResult(r: DepositResult): ResultEffects {
  if (r.status === "failed") return { used: false, poll: false, submit: false };
  if (r.status === "ok") return { used: true, poll: true, submit: r.txHash !== null };
  return { used: r.txHash !== null, poll: true, submit: false };
}

export type PanelEvent =
  | { type: "quote_requested" }
  | { type: "quote_received"; quoted: Quoted }
  | { type: "signing"; busy: boolean }
  | { type: "result"; address: string; result: DepositResult }
  | { type: "status"; address: string; status: string }
  | { type: "gave_up"; address: string };

export function panelReducer(s: PanelState, e: PanelEvent): PanelState {
  switch (e.type) {
    case "quote_requested":
      // The quote on screen goes as soon as another is asked for, so an error about the new one never sits beside a
      // button that signs the old one. Not while the wallet is open for it.
      return s.signing ? s : { ...s, quoted: null, used: false };
    case "quote_received":
      return s.signing ? s : { ...s, quoted: e.quoted, used: false };
    case "signing":
      return { ...s, signing: e.busy };
    case "result": {
      // A result belongs to the deposit address it was signed for, and to no other quote.
      if (s.quoted?.quote.depositAddress !== e.address) return s;
      const fx = onDepositResult(e.result);
      return {
        ...s,
        used: s.used || fx.used,
        watching: fx.poll
          ? { address: e.address, status: null, gaveUp: false, run: (s.watching?.run ?? 0) + 1 }
          : s.watching,
      };
    }
    case "status":
      if (s.watching?.address !== e.address) return s;
      return { ...s, watching: { ...s.watching, status: e.status } };
    case "gave_up":
      if (s.watching?.address !== e.address) return s;
      return { ...s, watching: { ...s.watching, gaveUp: true } };
  }
}

/** Why the quote on screen is not offered for signing, or null. */
export function blockOf(s: PanelState, amount: string, now: number): QuoteBlock | null {
  if (!s.quoted) return null;
  const { quote, asked } = s.quoted;
  return quoteBlock({
    deadline: quote.deadline,
    asked,
    amount,
    now,
    used: s.used,
    // Only what 1Click said about this quote's own address counts.
    depositStatus: s.watching?.address === quote.depositAddress ? s.watching.status : null,
  });
}
