"use client";

import { useState } from "react";
import { prepareFundAction } from "@/app/console/[vault]/topup/actions";
import { Field, inputClass } from "@/components/ui";
import { TxButton } from "@/components/wallet/TxButton";
import type { Network } from "@/lib/config";
import { lockKeyFor } from "@/lib/near/lock";
import { parseFundAmount } from "@/lib/topup/amount";

/**
 * The owner sends USDC from their own wallet to the vault (for NEAR payees). The server action builds the
 * transaction after checking the chain; the amount is also checked here so a typo shows before the click.
 * The transaction is only known after the click, so the lock that stops a second signature after an
 * unconfirmed send is keyed by the action and the vault.
 */
export function FundUsdcButton({
  vault,
  owner,
  network,
  token,
}: {
  vault: string;
  owner: string;
  network: Network;
  /** The USDC contract this network uses: the token the vault is sent, shown so the owner can check it. */
  token: string;
}) {
  const [amount, setAmount] = useState("25");
  const parsed = parseFundAmount(amount);
  return (
    <div>
      <Field
        label={network === "mainnet" ? "Amount (USDC)" : "Amount (test USDC)"}
        hint={`Token: ${token}`}
        error={"problem" in parsed ? parsed.problem : undefined}
      >
        <input
          className={`${inputClass} max-w-xs`}
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      {/* A disabled fieldset switches off the button inside without unmounting it, so a signature in progress keeps its result. */}
      <fieldset disabled={"problem" in parsed} className="m-0 min-w-0 border-0 p-0">
        <TxButton
          label="Send USDC to the vault from my wallet"
          network={network}
          expectedSigner={owner}
          prepare={() => prepareFundAction(vault, amount)}
          lockKey={lockKeyFor(`fund-usdc:${vault}`)}
        />
      </fieldset>
    </div>
  );
}
