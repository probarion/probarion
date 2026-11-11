"use client";

import { useActionState, useState } from "react";
import { buttonClass, Field, inputClass, Notice } from "@/components/ui";
import { TxButton } from "@/components/wallet/TxButton";
import type { Network } from "@/lib/config";
import type { DangerTone } from "@/lib/console/confirm-dialog";
import { consoleOutOfNear } from "@/lib/console/display";
import type { KeepState, KeyPurpose, KeySyncState, VaultCode } from "@/lib/keys/rules";
import { lockKeyFor } from "@/lib/near/lock";
import type { DescribeResult, TxResult } from "@/lib/near/outcome";
import type { WalletTx } from "@/lib/near/tx";

// The keys page's client parts. They hold no secret and never could: the server actions they call
// return a public key inside a transaction, or a status message.

type Generate = (
  purpose: KeyPurpose,
  label: string,
) => Promise<WalletTx | { error: string; status?: 401 | 403 | 409 }>;
type Sync = (prev: KeySyncState, formData?: FormData) => Promise<KeySyncState>;
type Keep = (prev: KeepState, formData?: FormData) => Promise<KeepState>;

/**
 * The owner signs every key call, so an out-of-NEAR refusal names the signer first (W-T8-R1). The
 * keys page does not read the vault's free NEAR, so it never adds the top-up suggestion. Set at
 * display time, so a result read back after a reload says the same.
 */
export function signerFirst(outOfNearCodes: string[]): DescribeResult {
  return (r) => {
    const v = consoleOutOfNear(r.code, outOfNearCodes, false);
    return v === null ? undefined : { detail: v.text };
  };
}

/** After any key transaction: re-read the chain, so the table shows the new status. */
function afterTx(sync: Sync) {
  return async (_r: TxResult) => {
    await sync(null);
  };
}

/** A wallet button for one existing key (add it on chain, or remove it), signed by the session account. */
export function KeyTxButton(props: {
  label: string;
  network: Network;
  signer: string;
  tx: WalletTx;
  lockKey: string;
  confirm?: string;
  confirmTone?: DangerTone;
  outOfNearCodes: string[];
  sync: Sync;
}) {
  return (
    <TxButton
      label={props.label}
      network={props.network}
      expectedSigner={props.signer}
      tx={props.tx}
      lockKey={props.lockKey}
      confirm={props.confirm}
      confirmTone={props.confirmTone}
      describe={signerFirst(props.outOfNearCodes)}
      onResult={afterTx(props.sync)}
    />
  );
}

/** "Check on-chain status": any member. Shows what changed and why a key stayed pending. */
export function KeySyncButton({ sync }: { sync: Sync }) {
  const [state, action, pending] = useActionState(sync, null);
  return (
    <form action={action}>
      <button className={buttonClass} type="submit" disabled={pending}>
        {pending ? "Checking…" : "Check on-chain status"}
      </button>
      {state?.ok === false ? <p className="mt-1 text-xs text-bad">{state.error}</p> : null}
      {state?.ok ? (
        <div className="mt-1 text-xs text-mute">
          <p>{state.message}</p>
          {state.notes.length > 0 ? (
            <ul className="list-disc pl-4">
              {state.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

/**
 * Owner only: Keep a discarded key that is on the vault after all. It always shows what happened, also
 * when nothing changed (W-T10-R3).
 */
export function KeyKeepButton({ keep }: { keep: Keep }) {
  const [state, action, pending] = useActionState(keep, null);
  return (
    <form action={action}>
      <button type="submit" className="text-xs text-mute underline" disabled={pending}>
        {pending ? "Checking…" : "Keep"}
      </button>
      {state ? (
        <Notice tone={state.ok ? "good" : "warn"}>
          <span role="status">{state.message}</span>
        </Notice>
      ) : null}
    </form>
  );
}

export const LEDGER_HELD_ELSEWHERE =
  "The vault's ledger key is held outside Probarion, by your own agent. A ledger key made here replaces it, and that agent then refuses every payment. Hosted Payables needs a vault of its own.";
const LEDGER_MAYBE_ELSEWHERE =
  "The vault's keys could not be read, so it is not known whether your own agent holds its ledger key. If it does, a ledger key made here replaces it, and that agent then refuses every payment.";
export const REPLACE_OUTSIDE_LEDGER_CONFIRM =
  "Replace a ledger key held outside Probarion? The agent that holds it can no longer anchor, and refuses every payment from this vault. Hosted Payables needs a vault of its own.";

/** Owner only (the page renders it for the owner; the actions check again). */
export function KeyActions(props: {
  vault: string;
  signer: string;
  network: Network;
  ledgerActive: boolean;
  /** The vault's ledger key is registered without its access key (W-T10-R1). */
  ledgerStuck: boolean;
  /** What the vault's code can do about a stuck ledger key (W-T10-R3); used only while it is stuck. */
  vaultCode: VaultCode;
  /**
   * The vault's ledger key is on chain but has no key row: the user's own agent holds it (the Agent (MCP) tab). Null
   * when the chain could not be read, which is treated as a maybe.
   */
  ledgerHeldElsewhere: boolean | null;
  outOfNearCodes: string[];
  generate: Generate;
  sync: Sync;
}) {
  const [label, setLabel] = useState("payables");
  const onResult = afterTx(props.sync);
  const describe = signerFirst(props.outOfNearCodes);
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        <Field
          label="Agent key label"
          hint="At most 64 bytes. It is stored on the vault with the key."
        >
          <input
            className={inputClass}
            value={label}
            maxLength={64}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <TxButton
          label="Generate agent key and add it in my wallet"
          network={props.network}
          expectedSigner={props.signer}
          lockKey={lockKeyFor(`keys:new-agent:${props.vault}`)}
          prepare={() => props.generate("agent", label)}
          describe={describe}
          onResult={onResult}
        />
      </div>
      <div>
        <p className="mb-2 text-sm text-mute">
          The ledger key signs ledger entries and anchors their root on chain. Setting a new one
          removes the old one from the vault.
        </p>
        {props.ledgerStuck && props.vaultCode === "old" ? (
          // W-T10-R3: on the first vault code release set_ledger_key deletes and adds in one batch, so
          // the failed delete of the missing key undoes the add: a new key could only move the pointer.
          <Notice tone="bad">
            The vault&apos;s ledger key is stuck: it is registered, but its access key was never
            added. This vault&apos;s code cannot replace a stuck ledger key, so a new ledger key is
            not offered here: anchoring needs a new vault.
          </Notice>
        ) : props.ledgerStuck && props.vaultCode === "unknown" ? (
          <Notice tone="warn">
            The vault&apos;s ledger key is stuck, and the vault&apos;s code could not be read, so a
            new ledger key is not offered: reload the page.
          </Notice>
        ) : (
          <>
            {props.ledgerStuck ? (
              <Notice tone="warn">
                The vault&apos;s ledger key is stuck: it is registered, but its access key was never
                added. Setting a new ledger key recovers it. If the vault has no free NEAR, top it
                up first.
              </Notice>
            ) : null}
            {props.ledgerHeldElsewhere === true ? (
              <Notice tone="bad">{LEDGER_HELD_ELSEWHERE}</Notice>
            ) : props.ledgerHeldElsewhere === null ? (
              <Notice tone="warn">{LEDGER_MAYBE_ELSEWHERE}</Notice>
            ) : null}
            {props.ledgerActive ? (
              <Notice tone="warn">
                This vault already has an active ledger key. A new one replaces it: the old key can
                no longer anchor.
              </Notice>
            ) : null}
            <TxButton
              label="Generate ledger key and set it in my wallet"
              network={props.network}
              expectedSigner={props.signer}
              lockKey={lockKeyFor(`keys:new-ledger:${props.vault}`)}
              prepare={() => props.generate("ledger", "ledger")}
              confirm={
                props.ledgerHeldElsewhere !== false
                  ? REPLACE_OUTSIDE_LEDGER_CONFIRM
                  : props.ledgerActive
                    ? "Replace the vault's ledger key? The current one is removed from the vault."
                    : undefined
              }
              confirmTone={props.ledgerHeldElsewhere !== false ? "danger" : undefined}
              describe={describe}
              onResult={onResult}
            />
          </>
        )}
      </div>
    </div>
  );
}
