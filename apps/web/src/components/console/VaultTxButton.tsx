"use client";

import { type ComponentProps, useState } from "react";
import { Notice } from "@/components/ui";
import { TxButton } from "@/components/wallet/TxButton";
import type { TxResult } from "@/lib/near/outcome";

/** Built on the server from the SDK (lib/console/out-of-near.ts) and passed down as plain data. */
export interface OutOfNearProp {
  codes: string[];
  detail: string;
}

/**
 * A TxButton for a vault call. When the outcome's code says the vault ran out of NEAR (R3:
 * `isOutOfNearCode`), it shows the SDK's own text and points at the top-up, because the remedy is
 * a plain transfer, not another try of the same call.
 */
export function VaultTxButton({
  outOfNear,
  ...props
}: Omit<ComponentProps<typeof TxButton>, "onResult"> & { outOfNear: OutOfNearProp }) {
  const [hint, setHint] = useState<string | null>(null);
  return (
    <div>
      <TxButton
        {...props}
        onResult={(r: TxResult) => {
          setHint(r.code !== null && outOfNear.codes.includes(r.code) ? outOfNear.detail : null);
        }}
      />
      {hint ? (
        <Notice tone="warn">
          {hint}. <a href="#send-near">Send NEAR to this vault</a>.
        </Notice>
      ) : null}
    </div>
  );
}
