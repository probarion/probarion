"use client";

import { useEffect, useReducer, useState } from "react";
import { Badge, buttonClass, Field, inputClass, Notice, type Tone } from "@/components/ui";
import { TxButton } from "@/components/wallet/TxButton";
import type { Network } from "@/lib/config";
import { lockKeyFor } from "@/lib/near/lock";
import type { WalletTx } from "@/lib/near/tx";
import { parseTopupAmount, TOPUP_RANGE_TEXT } from "@/lib/topup/amount";
import { BLOCK_TEXT } from "@/lib/topup/block";
import { describeDeposit, registerDepositText } from "@/lib/topup/copy";
import { quoteErrorText } from "@/lib/topup/messages";
import type { VerifiedQuote } from "@/lib/topup/oneclick";
import {
  blockOf,
  FINAL_STATUS,
  initialPanel,
  onDepositResult,
  panelReducer,
} from "@/lib/topup/panel";
import { QuoteReference, QuoteSummary } from "./QuoteSummary";

const POLL_MS = 5000;
const POLL_LIMIT = 36; // 3 minutes

function statusTone(status: string): Tone {
  if (status === "SUCCESS") return "good";
  return status === "REFUNDED" || status === "FAILED" ? "bad" : "info";
}

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);

/**
 * The owner asks 1Click, through the server, for Base USDC in the vault's Intents account. The server answers only
 * with a quote it verified (signature and what the quote is for), so everything below the button is that quote.
 * The owner signs the deposit in their own wallet. Then the page reads 1Click's status for that deposit address.
 *
 * What may be signed is decided by `panelReducer` and `blockOf` (lib/topup/panel.ts, tested): this component
 * dispatches events and draws the state.
 */
export function TopUpPanel({
  vault,
  owner,
  network,
}: {
  vault: string;
  owner: string;
  network: Network;
}) {
  const [amount, setAmount] = useState("20");
  const [state, dispatch] = useReducer(panelReducer, initialPanel);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { quoted, watching } = state;

  const parsed = parseTopupAmount(amount);
  const block = blockOf(state, amount, now);

  useEffect(() => {
    if (!quoted) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [quoted]);

  // Read 1Click's status for the deposit address, until it is final, or for 3 minutes.
  const address = watching?.address ?? null;
  const run = watching?.run ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` restarts the reading for the same address
  useEffect(() => {
    if (!address) return;
    let stopped = false;
    let n = 0;
    const t = setInterval(async () => {
      n++;
      try {
        const r = await fetch(
          `/api/topup/status?vault=${encodeURIComponent(vault)}&depositAddress=${encodeURIComponent(address)}`,
        );
        const body: unknown = r.ok ? await r.json().catch(() => null) : null;
        const s = (body as { status?: unknown } | null)?.status;
        if (!stopped && typeof s === "string") {
          dispatch({ type: "status", address, status: s });
          if (FINAL_STATUS.has(s)) {
            stopped = true;
            clearInterval(t);
            return;
          }
        }
      } catch {
        // a missed read: the next one tries again
      }
      if (n >= POLL_LIMIT && !stopped) {
        stopped = true;
        clearInterval(t);
        dispatch({ type: "gave_up", address });
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [address, run, vault]);

  async function getQuote() {
    if ("problem" in parsed || state.signing) return;
    setError(null);
    // The quote on screen goes now, so an error below never sits beside a button that signs the old one.
    dispatch({ type: "quote_requested" });
    setRequesting(true);
    try {
      const r = await fetch("/api/topup/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vault, amountUsdc: amount }),
      });
      const body: unknown = await r.json().catch(() => null);
      const b = body as { quote?: VerifiedQuote; tx?: WalletTx } | null;
      if (r.ok && b?.quote && b.tx) {
        dispatch({
          type: "quote_received",
          quoted: { quote: b.quote, tx: b.tx, asked: amount.trim() },
        });
      } else {
        setError(quoteErrorText(r.status, body));
      }
    } catch {
      setError("The server could not be reached. Try again.");
    } finally {
      setRequesting(false);
    }
  }

  return (
    <div>
      <Field
        label="Base USDC the vault should receive inside NEAR Intents"
        hint={`${TOPUP_RANGE_TEXT} per top-up.`}
        error={"problem" in parsed ? parsed.problem : undefined}
      >
        <input
          className={`${inputClass} max-w-xs`}
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <button
        type="button"
        className={buttonClass}
        disabled={requesting || state.signing || "problem" in parsed}
        onClick={getQuote}
      >
        {requesting ? "Asking 1Click…" : "Get a 1Click quote"}
      </button>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {quoted ? (
        <div className="mt-4 rounded-2xl border border-line p-3">
          <QuoteSummary quote={quoted.quote} />
          {quoted.quote.correlationId ? <QuoteReference id={quoted.quote.correlationId} /> : null}
          {block ? <Notice tone="warn">{BLOCK_TEXT[block]}</Notice> : null}
          <p className="mt-2 text-xs text-mute">{registerDepositText}</p>
          {/* A disabled fieldset switches off the button inside without unmounting it, so a signature in progress keeps its result. */}
          <fieldset disabled={block !== null} className="m-0 min-w-0 border-0 p-0">
            <TxButton
              // One button per deposit address: a result is never shown under another quote.
              key={quoted.quote.depositAddress}
              label="Sign the deposit in my wallet"
              network={network}
              expectedSigner={owner}
              tx={quoted.tx}
              // The lock of an unconfirmed deposit is the vault's, so asking for a new quote does not end it.
              lockKey={lockKeyFor(`topup-intents:${vault}`)}
              describe={describeDeposit}
              onBusyChange={(busy) => dispatch({ type: "signing", busy })}
              onResult={async (r) => {
                const depositAddress = quoted.quote.depositAddress;
                const result = { status: r.status, txHash: r.txHash };
                dispatch({ type: "result", address: depositAddress, result });
                if (!onDepositResult(result).submit || r.txHash === null) return;
                // A speed-up only: 1Click also finds the deposit by itself.
                await fetch("/api/topup/submit", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ vault, txHash: r.txHash, depositAddress }),
                }).catch(() => {});
              }}
            />
          </fieldset>
        </div>
      ) : null}
      {watching ? (
        <p className="mt-3 text-sm">
          1Click status for deposit address <span className="mono">{short(watching.address)}</span>:{" "}
          <Badge tone={watching.status ? statusTone(watching.status) : "neutral"}>
            {watching.status ?? "not read yet"}
          </Badge>
          {watching.gaveUp
            ? " Stopped checking after 3 minutes. The vault's Base USDC in Intents shows on the Overview tab."
            : ""}
        </p>
      ) : null}
    </div>
  );
}
