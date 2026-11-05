"use client";

import { useEffect, useState } from "react";
import { Badge, buttonClass, Field, inputClass, Notice, type Tone } from "@/components/ui";
import { TxButton } from "@/components/wallet/TxButton";
import type { Network } from "@/lib/config";
import type { WalletTx } from "@/lib/near/tx";
import { parseTopupAmount, TOPUP_RANGE_TEXT } from "@/lib/topup/amount";
import { BLOCK_TEXT, quoteBlock } from "@/lib/topup/block";
import { registerDepositText } from "@/lib/topup/copy";
import { quoteErrorText } from "@/lib/topup/messages";
import type { VerifiedQuote } from "@/lib/topup/oneclick";
import { QuoteSummary } from "./QuoteSummary";

/** A quote the server verified, the transaction it built from it, and the amount typed when it was asked for. */
interface Quoted {
  quote: VerifiedQuote;
  tx: WalletTx;
  asked: string;
}

/** 1Click's final states: after one of them there is nothing more to read. */
const FINAL_STATUS = new Set(["SUCCESS", "REFUNDED", "FAILED"]);
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
  const [quoted, setQuoted] = useState<Quoted | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The owner has signed, or tried to: the quote is then never switched off under their wallet. */
  const [attempted, setAttempted] = useState(false);
  /** The deposit went through (the chain confirmed it): signing the same quote again would deposit twice. */
  const [sent, setSent] = useState(false);
  const [depositAddress, setDepositAddress] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const parsed = parseTopupAmount(amount);

  useEffect(() => {
    if (!quoted) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [quoted]);

  useEffect(() => {
    if (!depositAddress) return;
    setStatus(null);
    setGaveUp(false);
    let stopped = false;
    let n = 0;
    const t = setInterval(async () => {
      n++;
      try {
        const r = await fetch(
          `/api/topup/status?vault=${encodeURIComponent(vault)}&depositAddress=${encodeURIComponent(depositAddress)}`,
        );
        const body: unknown = r.ok ? await r.json().catch(() => null) : null;
        const s = (body as { status?: unknown } | null)?.status;
        if (!stopped && typeof s === "string") {
          setStatus(s);
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
        setGaveUp(true);
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [depositAddress, vault]);

  async function getQuote() {
    if ("problem" in parsed) return;
    setError(null);
    setBusy(true);
    try {
      const r = await fetch("/api/topup/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vault, amountUsdc: amount }),
      });
      const body: unknown = await r.json().catch(() => null);
      const b = body as { quote?: VerifiedQuote; tx?: WalletTx } | null;
      if (r.ok && b?.quote && b.tx) {
        setQuoted({ quote: b.quote, tx: b.tx, asked: amount.trim() });
        setAttempted(false);
        setSent(false);
      } else {
        setError(quoteErrorText(r.status, body));
      }
    } catch {
      setError("The server could not be reached. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Not offered for signing: sent already, the amount no longer matches the quote, or its address is about to close.
  const block = quoted
    ? quoteBlock({
        deadline: quoted.quote.deadline,
        asked: quoted.asked,
        amount,
        now,
        attempted,
        sent,
      })
    : null;
  const blocked = block !== null;

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
        disabled={busy || "problem" in parsed}
        onClick={getQuote}
      >
        {busy ? "Asking 1Click…" : "Get a 1Click quote"}
      </button>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {quoted ? (
        <div className="mt-4 rounded border border-stone-200 p-3">
          <QuoteSummary quote={quoted.quote} />
          {block ? <Notice tone="warn">{BLOCK_TEXT[block]}</Notice> : null}
          <p className="mt-2 text-xs text-stone-600">{registerDepositText}</p>
          {/* A disabled fieldset switches off the button inside without unmounting it, so a signature in progress keeps its result. */}
          <fieldset disabled={blocked} className="m-0 min-w-0 border-0 p-0">
            <TxButton
              label="Sign the deposit in my wallet"
              network={network}
              expectedSigner={owner}
              tx={quoted.tx}
              onResult={async (r) => {
                setAttempted(true);
                if (r.status === "ok") setSent(true);
                if (!r.txHash || r.status === "failed") return;
                setDepositAddress(quoted.quote.depositAddress);
                if (r.status !== "ok") return;
                // A speed-up only: 1Click also finds the deposit by itself.
                await fetch("/api/topup/submit", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    vault,
                    txHash: r.txHash,
                    depositAddress: quoted.quote.depositAddress,
                  }),
                }).catch(() => {});
              }}
            />
          </fieldset>
        </div>
      ) : null}
      {depositAddress ? (
        <p className="mt-3 text-sm">
          1Click status for deposit address <span className="mono">{short(depositAddress)}</span>:{" "}
          <Badge tone={status ? statusTone(status) : "neutral"}>{status ?? "not read yet"}</Badge>
          {gaveUp
            ? " Stopped checking after 3 minutes. The vault's Base USDC in Intents shows on the Overview tab."
            : ""}
        </p>
      ) : null}
    </div>
  );
}
