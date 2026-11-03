"use client";

import { TxButton } from "@/components/wallet/TxButton";
import type { Network } from "@/lib/config";
import { consoleOutOfNear } from "@/lib/console/display";
import { lockKeyFor } from "@/lib/near/lock";
import type { TxResult } from "@/lib/near/outcome";
import type { WalletTx } from "@/lib/near/tx";

/**
 * Revoke one mandate, signed by the owner. The transaction is known before the click (`revoke_mandate`
 * with the mandate id, 1 yoctoNEAR), so it comes in as `tx`; the lock that keeps an unconfirmed send
 * from being signed twice is named for this vault and mandate, so a reload finds it again. The
 * out-of-NEAR wording names the signer first: the owner's own account pays this call's gas.
 */
export function RevokeMandateButton(props: {
  vault: string;
  mandateId: number;
  /** Already made safe to show (safeChainText). */
  mandateLabel: string;
  payeeText: string;
  network: Network;
  signer: string;
  tx: WalletTx;
  outOfNearCodes: string[];
}) {
  return (
    <TxButton
      label="Revoke"
      network={props.network}
      expectedSigner={props.signer}
      tx={props.tx}
      lockKey={lockKeyFor(`revoke-mandate:${props.vault}:${props.mandateId}`)}
      confirm={`Revoke mandate #${props.mandateId} "${props.mandateLabel}" (pays ${props.payeeText})?\n\nThis cannot be undone. The agent can no longer spend on it and a held payment can no longer be approved; a payout already pending still settles.`}
      describe={(r: TxResult) => {
        const v = consoleOutOfNear(r.code, props.outOfNearCodes, false);
        return v === null ? undefined : { detail: v.text };
      }}
    />
  );
}
