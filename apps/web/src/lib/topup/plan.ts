import type { VaultConfig } from "@probarion/core";
import type { Network } from "@/lib/config";
import { baseCardNotAllowed, baseCardNotConfigured, FUNDING_NOTICE, testnetBaseText } from "./copy";

/**
 * A card either offers its action, for this owner account (the one the chain names, which signs), or says why
 * it does not. Carrying the owner means a page that offers has it, with no null to re-check.
 */
export type Offer = { offer: true; owner: string } | { offer: false; why: string };

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
  // Testnet has no Intents or 1Click whatever the vault says: that card's text is about the network.
  const testnetBase = i.network !== "mainnet" ? none(testnetBaseText(consts)) : null;

  if (config === null) {
    const unread = none(
      "The vault could not be read from NEAR, so nothing is offered here. Try again in a minute.",
    );
    return { notice, fund: unread, base: testnetBase ?? unread };
  }
  if (config.owner !== i.account) {
    const other = none(
      `The chain names ${config.owner} as this vault's owner, not ${i.account}, so nothing is offered here.`,
    );
    return { notice, fund: other, base: testnetBase ?? other };
  }

  const owner = config.owner;
  const fund: Offer =
    config.usdc !== consts.usdc
      ? none(
          `This vault's token is ${config.usdc}, not this network's USDC (${consts.usdc}), so nothing is offered here.`,
        )
      : { offer: true, owner };
  let base: Offer;
  if (testnetBase) base = testnetBase;
  else if (!config.allowed_assets.includes(consts.allowedAssets.base)) {
    base = none(baseCardNotAllowed);
  } else if (!i.quotesConfigured) base = none(baseCardNotConfigured);
  else base = { offer: true, owner };
  return { notice, fund, base };
}
