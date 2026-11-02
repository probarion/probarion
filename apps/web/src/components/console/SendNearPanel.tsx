"use client";

import { useState } from "react";
import { Field, inputClass } from "@/components/ui";
import type { Network } from "@/lib/config";
import { DEFAULT_TOPUP_YOCTO, MAX_TOPUP_YOCTO } from "@/lib/near/runway";
import { asWalletTx, sendNearTx } from "@/lib/near/transfer";
import { AmountError, formatNear, parseNear } from "@/lib/near/units";
import { VaultTxButton } from "./VaultTxButton";

/** The top-up amount the owner typed, or why it cannot be sent. */
export function parseTopup(amount: string): { yocto: string } | { problem: string } {
  try {
    const yocto = parseNear(amount);
    if (BigInt(yocto) <= 0n) return { problem: "Must be above 0" };
    if (BigInt(yocto) > MAX_TOPUP_YOCTO) {
      return {
        problem: `At most ${formatNear(MAX_TOPUP_YOCTO.toString())} NEAR at a time: NEAR sent to a vault can never be withdrawn`,
      };
    }
    return { yocto };
  } catch (e) {
    return { problem: e instanceof AmountError ? e.message : "Invalid amount" };
  }
}

/** R3: "Send NEAR to this vault", one plain transfer that tops up its runway. */
export function SendNearPanel({
  vault,
  network,
  signer,
  outOfNearCodes,
}: {
  vault: string;
  network: Network;
  signer: string;
  outOfNearCodes: string[];
}) {
  const [amount, setAmount] = useState(formatNear(DEFAULT_TOPUP_YOCTO.toString()));
  const parsed = parseTopup(amount);
  return (
    <div id="send-near" className="mt-4 border-t border-[#0B0B0C]/10 pt-3">
      <Field
        label="Send NEAR to this vault"
        hint="A plain transfer. It pays the vault's storage and gas (about 0.0053 NEAR per paid spend) and can never be withdrawn."
        error={"problem" in parsed ? parsed.problem : undefined}
      >
        <input
          className={`${inputClass} max-w-40`}
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      {"yocto" in parsed ? (
        <>
          <VaultTxButton
            label={`Send ${formatNear(parsed.yocto, 6)} NEAR`}
            network={network}
            expectedSigner={signer}
            confirm={`Send ${formatNear(parsed.yocto, 6)} NEAR to ${vault}? NEAR in a vault cannot be withdrawn.`}
            tx={asWalletTx(sendNearTx(vault, parsed.yocto))}
            outOfNearCodes={outOfNearCodes}
            vaultNearLow={false}
          />
          <p className="mt-1 text-xs text-[#0B0B0C]/60">
            Or from a terminal (near-cli-rs, you sign):
          </p>
          <pre className="mt-1 overflow-x-auto rounded-2xl bg-[#0B0B0C] p-3 text-xs text-[#F7F6F3]">
            {`near tokens ${signer} send-near ${vault} '${formatNear(parsed.yocto, 6)} NEAR' network-config ${network} sign-with-keychain send`}
          </pre>
        </>
      ) : (
        <button
          type="button"
          className="my-2 rounded-full bg-[#0B0B0C] px-4 py-1.5 text-sm text-[#F7F6F3] opacity-50"
          disabled
        >
          Send NEAR
        </button>
      )}
    </div>
  );
}
