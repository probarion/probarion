"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { inkPillClass, linePillClass, Notice } from "@/components/ui";
import { useWallet } from "@/components/wallet/WalletProvider";
import type { ActionDenied } from "@/lib/console/action-auth";
import { decodeNonce, normalizeSignature } from "@/lib/near/signin";
import type { ConfirmResult, PrepareResult } from "@/lib/payables/confirm";
import type { RowSnapshot } from "@/lib/payables/store";

// The owner's Confirm and Reject for one waiting invoice. Confirm asks the server for a nonce and the exact message,
// shows the message, has the wallet sign it (NEP-413: a signature, not a transaction), and sends the signature back;
// the server checks it over its own copy and pays. Reject sends back the snapshot the owner sees. Both buttons are
// disabled while either runs, and the server makes a second click pay nothing anyway.

type Shown = { tone: "good" | "warn" | "bad"; text: string } | null;

const denied = (v: unknown): v is ActionDenied =>
  typeof v === "object" && v !== null && "status" in v && "error" in v;

export function ConfirmInvoicePanel({
  owner,
  amountText,
  payee,
  mandateId,
  seen,
  prepare,
  confirm,
  reject,
}: {
  owner: string;
  amountText: string;
  payee: string;
  mandateId: number;
  seen: RowSnapshot;
  prepare: () => Promise<PrepareResult | ActionDenied>;
  confirm: (nonce: string, signed: unknown) => Promise<ConfirmResult | ActionDenied>;
  reject: (seen: RowSnapshot) => Promise<{ ok: boolean; text: string } | ActionDenied>;
}) {
  const { ready, signMessage } = useWallet();
  const router = useRouter();
  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
  const [signing, setSigning] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown>(null);

  const onConfirm = async () => {
    setBusy("confirm");
    setShown(null);
    try {
      const p = await prepare();
      if (denied(p)) return setShown({ tone: "bad", text: p.error });
      if (!p.ok) return setShown({ tone: "bad", text: p.text });
      setSigning(p.message);
      const signed = await signMessage({
        message: p.message,
        recipient: p.recipient,
        nonce: decodeNonce(p.nonce),
      });
      if (signed.accountId !== owner) {
        return setShown({
          tone: "bad",
          text: `Your wallet signed as ${signed.accountId}. Sign as the vault's owner, ${owner}. Nothing was sent.`,
        });
      }
      const r = await confirm(p.nonce, {
        accountId: signed.accountId,
        publicKey: signed.publicKey,
        signature: normalizeSignature(signed.signature),
      });
      if (denied(r)) return setShown({ tone: "bad", text: r.error });
      setShown(
        r.ok
          ? { tone: r.invoiceStatus === "awaiting_owner" ? "warn" : "good", text: r.text }
          : { tone: "bad", text: r.text },
      );
      router.refresh();
    } catch (e) {
      setShown({
        tone: "bad",
        text: `The wallet did not sign (${e instanceof Error ? e.message : String(e)}). Nothing was sent.`,
      });
    } finally {
      setSigning(null);
      setBusy(null);
    }
  };

  const onReject = async () => {
    if (
      !window.confirm(
        "Reject this invoice? Nothing is paid. The same text uploaded again stays a duplicate; a corrected invoice is a new one.",
      )
    ) {
      return;
    }
    setBusy("reject");
    setShown(null);
    try {
      const r = await reject(seen);
      setShown(
        denied(r) ? { tone: "bad", text: r.error } : { tone: r.ok ? "good" : "bad", text: r.text },
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="text-sm">
      <p className="mb-3">
        Confirm pays <strong>{amountText}</strong> to <span className="mono">{payee}</span> under
        mandate #{mandateId}. Your wallet asks you to sign a message (it sends no transaction); the
        vault contract still applies the mandate&apos;s caps and holds a payment above its approval
        threshold for the approvers.
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={inkPillClass}
          disabled={!ready || busy !== null}
          onClick={onConfirm}
        >
          {busy === "confirm"
            ? "Check your wallet…"
            : ready
              ? "Confirm and pay"
              : "Loading wallets…"}
        </button>
        <button type="button" className={linePillClass} disabled={busy !== null} onClick={onReject}>
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
      {signing ? (
        <div className="mt-3">
          <p className="mb-1 text-xs text-ink/60">Your wallet asks you to sign exactly this:</p>
          <code className="block rounded-2xl bg-ink px-3 py-2 text-xs text-paper wrap-anywhere">
            {signing}
          </code>
        </div>
      ) : null}
      {shown ? (
        <div className="mt-3">
          <Notice tone={shown.tone}>{shown.text}</Notice>
        </div>
      ) : null}
    </div>
  );
}
