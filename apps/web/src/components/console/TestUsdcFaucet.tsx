"use client";

import { useState } from "react";
import { buttonClass, TxLink } from "@/components/ui";
import { isNearTxHash } from "@/lib/near/validate";
import type { FaucetCopy } from "@/lib/topup/copy";

type State =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "minted"; txHash: string }
  | { kind: "unknown"; txHash: string }
  | { kind: "error"; text: string };

const muted = "text-mute";

/**
 * Testnet only (audit P0-2). One click asks the server to mint the faucet's fixed amount of test USDC straight into
 * this vault. The server signs with the team's mint-only key, so no wallet opens, and it decides everything (owner,
 * network, once a day); this shows its answer. After a mint, or one whose outcome is not known, the button stays off:
 * another click today would only meet the daily limit. Without a faucet key on the server (`configured` false), the
 * block says whom to ask instead.
 */
export function TestUsdcFaucet({
  vault,
  copy,
  configured,
}: {
  vault: string;
  copy: FaucetCopy;
  configured: boolean;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  if (!configured) return <p className={`mb-4 text-sm ${muted}`}>{copy.fallback}</p>;

  async function add() {
    setState({ kind: "pending" });
    try {
      const r = await fetch("/api/topup/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vault }),
      });
      const b = (await r.json().catch(() => null)) as {
        txHash?: unknown;
        detail?: unknown;
      } | null;
      if (r.status === 200 && isNearTxHash(b?.txHash))
        setState({ kind: "minted", txHash: b.txHash });
      else if (r.status === 202 && isNearTxHash(b?.txHash)) {
        setState({ kind: "unknown", txHash: b.txHash });
      } else {
        setState({
          kind: "error",
          text: typeof b?.detail === "string" ? b.detail : copy.unavailable,
        });
      }
    } catch {
      setState({ kind: "error", text: copy.unreachable });
    }
  }

  const sent = state.kind === "minted" || state.kind === "unknown";
  return (
    <div className="mb-4 border-b border-line pb-4">
      <p className="text-sm font-medium">{copy.title}</p>
      <p className={`mb-2 text-sm ${muted}`}>
        {copy.note} {copy.signer}
      </p>
      <button
        type="button"
        className={buttonClass}
        disabled={state.kind === "pending" || sent}
        onClick={add}
      >
        {state.kind === "pending" ? copy.pending : copy.button}
      </button>
      {state.kind === "minted" ? (
        <p className="mt-2 text-sm text-ok" role="status">
          {copy.done} <TxLink network="testnet" hash={state.txHash} />
        </p>
      ) : null}
      {state.kind === "unknown" ? (
        <p className="mt-2 text-sm text-wait" role="status">
          {copy.unknown} <TxLink network="testnet" hash={state.txHash} />
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p className="mt-2 text-sm text-bad" role="alert">
          {state.text}
        </p>
      ) : null}
    </div>
  );
}
