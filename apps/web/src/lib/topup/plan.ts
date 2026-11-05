import type { VaultConfig } from "@probarion/core";
import type { Network } from "@/lib/config";
import { baseCardNotAllowed, baseCardNotConfigured, FUNDING_NOTICE, testnetBaseText } from "./copy";

export type Offer = { offer: true } | { offer: false; why: string };

export interface TopupPlan {
  notice: string;
  /** Sending the network's USDC to the vault from the owner's wallet (for NEAR payees). */
  fund: Offer;
  /** Topping up the vault's Base USDC inside NEAR Intents through 1Click (for Base payees). */
  base: Offer;
}

/**
 * What the Top-up tab shows for this vault, decided from what the chain says and what this server is set up
 * for, and never offering what would fail or strand funds. Each `why` is the sentence the card shows instead.
 */
export function topupPlan(i: {
  network: Network;
  /** The vault's `get_config`, or null when it could not be read. */
  config: VaultConfig | null;
  /** The signed-in account. */
  account: string;
  consts: { usdc: string; intents: string; allowedAssets: { base: string } };
  /** Whether this server holds the 1Click partner JWT (the value itself never leaves the server). */
  quotesConfigured: boolean;
}): TopupPlan {
  const { config, consts } = i;
  const none = (why: string): Offer => ({ offer: false, why });
  const notice = FUNDING_NOTICE[i.network];

  let blocked: Offer | null = null;
  if (config === null) {
    blocked = none(
      "The vault could not be read from NEAR, so nothing is offered here. Try again in a minute.",
    );
  } else if (config.owner !== i.account) {
    blocked = none(
      `The chain names ${config.owner} as this vault's owner, not ${i.account}, so nothing is offered here.`,
    );
  }

  const fund: Offer =
    blocked ??
    (config !== null && config.usdc !== consts.usdc
      ? none(
          `This vault's token is ${config.usdc}, not this network's USDC (${consts.usdc}), so nothing is offered here.`,
        )
      : { offer: true });

  let base: Offer;
  if (i.network !== "mainnet") base = none(testnetBaseText(consts));
  else if (blocked) base = blocked;
  else if (config !== null && !config.allowed_assets.includes(consts.allowedAssets.base)) {
    base = none(baseCardNotAllowed);
  } else if (!i.quotesConfigured) base = none(baseCardNotConfigured);
  else base = { offer: true };

  return { notice, fund, base };
}
