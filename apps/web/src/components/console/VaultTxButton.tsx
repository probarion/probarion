"use client";

import { useState } from "react";
import { Notice } from "@/components/ui";
import { TxButton } from "@/components/wallet/TxButton";
import type { Network } from "@/lib/config";
import type { DangerTone } from "@/lib/console/confirm-dialog";
import { consoleOutOfNear } from "@/lib/console/display";
import type { TxResult } from "@/lib/near/outcome";
import type { WalletTx } from "@/lib/near/tx";

/**
 * A TxButton for a call the console asks the owner or an approver to sign (freeze, withdraw,
 * approve, reject, a top-up). When the chain refuses it as out of NEAR (R3, `isOutOfNearCode`; the
 * codes come from the server as plain data), the signer's own account is the first suspect, so the
 * SDK's vault-only wording is replaced by `SIGNER_OUT_OF_NEAR`. The "Send NEAR to this vault"
 * suggestion is added only when the vault's free NEAR reads low (W-T8-R1).
 *
 * Every call here is known before the click, so it always takes a `tx` (TxButton keys its lock on
 * the transaction) and never a `prepare`.
 */
export function VaultTxButton({
  label,
  network,
  expectedSigner,
  confirm,
  confirmTone,
  tx,
  outOfNearCodes,
  vaultNearLow,
}: {
  label: string;
  network: Network;
  expectedSigner?: string;
  confirm?: string;
  confirmTone?: DangerTone;
  tx: WalletTx;
  outOfNearCodes: string[];
  /** True only when the vault's free NEAR was read and is below 0.1 NEAR (never on "unavailable"). */
  vaultNearLow: boolean;
}) {
  const [topUp, setTopUp] = useState(false);
  return (
    <div>
      <TxButton
        label={label}
        network={network}
        expectedSigner={expectedSigner}
        confirm={confirm}
        confirmTone={confirmTone}
        tx={tx}
        // The words are set at display time, so a result read back after a reload (a locked,
        // unconfirmed send) says the same as the live one; the result object is not touched.
        describe={(r: TxResult) => {
          const v = consoleOutOfNear(r.code, outOfNearCodes, vaultNearLow);
          return v === null ? undefined : { detail: v.text };
        }}
        onResult={(r: TxResult) => {
          setTopUp(consoleOutOfNear(r.code, outOfNearCodes, vaultNearLow)?.suggestTopUp ?? false);
        }}
      />
      {topUp ? (
        <Notice tone="warn">
          <a href="#send-near">Send NEAR to this vault</a>
        </Notice>
      ) : null}
    </div>
  );
}
