"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import { inkPillClass, linePillClass, Notice } from "@/components/ui";
import { useWallet } from "@/components/wallet/WalletProvider";
import type { ActionDenied } from "@/lib/console/action-auth";
import type { ConfirmResult, PrepareResult } from "@/lib/payables/confirm";
import {
  type ConfirmPhase,
  type FlowResult,
  REJECT_INVOICE_CONFIRM,
  runConfirm,
  runReject,
  type Shown,
} from "@/lib/payables/confirm-flow";
import type { RowSnapshot } from "@/lib/payables/store";

// The owner's Confirm and Reject for one waiting invoice. Confirm asks the server for a nonce and the exact message,
// shows the message, has the wallet sign it (NEP-413: a signature, not a transaction), and sends the signature back;
// the server checks it over its own copy and pays. Reject sends back the snapshot the owner sees, and is offered even
// when Confirm is not. The steps and their wording are in lib/payables/confirm-flow.ts. Both buttons are disabled while
// either runs, and the server makes a second click pay nothing anyway.

const CONFIRM_LABEL: Readonly<Record<ConfirmPhase, string>> = {
  prepare: "Preparing…",
  sign: "Check your wallet…",
  pay: "Paying…",
};

export function ConfirmInvoicePanel({
  owner,
  canConfirm,
  whyNot,
  amountText,
  payee,
  mandateId,
  seen,
  prepare,
  confirm,
  reject,
}: {
  owner: string;
  canConfirm: boolean;
  /** Why Confirm is not offered, when it is not. */
  whyNot: string | null;
  amountText: string;
  payee: string | null;
  mandateId: number | null;
  seen: RowSnapshot;
  prepare: () => Promise<PrepareResult | ActionDenied>;
  confirm: (nonce: string, signed: unknown) => Promise<ConfirmResult | ActionDenied>;
  reject: (seen: RowSnapshot) => Promise<{ ok: boolean; text: string } | ActionDenied>;
}) {
  const { ready, signMessage } = useWallet();
  const router = useRouter();
  const [phase, setPhase] = useState<ConfirmPhase | "reject" | null>(null);
  const [signing, setSigning] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  // After a pay-phase failure the outcome is unknown: no second Confirm until the page has been loaded again.
  const [blocked, setBlocked] = useState(false);
  const busy = phase !== null;
  const { ask, dialog } = useConfirm();

  const finish = (r: FlowResult) => {
    setShown(r.shown);
    if (r.blocked) setBlocked(true);
    if (r.refresh) router.refresh();
  };

  const onConfirm = async () => {
    setShown(null);
    try {
      finish(
        await runConfirm({
          owner,
          prepare,
          signMessage,
          confirm,
          onPhase: (p, message) => {
            setPhase(p);
            // The message stays up only while the wallet is asked to sign it.
            setSigning(p === "sign" ? (message ?? null) : null);
          },
        }),
      );
    } catch {
      // runConfirm answers every failure itself; this is the last net, and it claims nothing.
      setBlocked(true);
      setShown({
        tone: "warn",
        text: "This page hit an error. Reload to see what happened to the invoice.",
      });
    } finally {
      setSigning(null);
      setPhase(null);
    }
  };

  const onReject = async () => {
    if (!(await ask(REJECT_INVOICE_CONFIRM))) return;
    setPhase("reject");
    setShown(null);
    try {
      finish(await runReject({ seen, reject }));
    } finally {
      setPhase(null);
    }
  };

  return (
    <div className="text-sm">
      {canConfirm ? (
        <p className="mb-3">
          Confirm pays <strong>{amountText}</strong> to{" "}
          <span className="mono break-all">{payee}</span> under mandate #{mandateId}. Your wallet
          asks you to sign a message (it sends no transaction); the vault contract still applies the
          mandate&apos;s caps and holds a payment above its approval threshold for the approvers.
        </p>
      ) : whyNot ? (
        <p className="mb-3 text-ink/60">{whyNot}</p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {canConfirm ? (
          <button
            type="button"
            className={inkPillClass}
            disabled={!ready || busy || blocked}
            onClick={onConfirm}
          >
            {blocked
              ? "Reload the page first"
              : phase !== null && phase !== "reject"
                ? CONFIRM_LABEL[phase]
                : ready
                  ? "Confirm and pay"
                  : "Loading wallets…"}
          </button>
        ) : null}
        <button type="button" className={linePillClass} disabled={busy} onClick={onReject}>
          {phase === "reject" ? "Rejecting…" : "Reject"}
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
      <div className="mt-3" role="status">
        {shown ? <Notice tone={shown.tone}>{shown.text}</Notice> : null}
      </div>
      {dialog}
    </div>
  );
}
