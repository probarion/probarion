// Links to the Probarion console. The console serves testnet vaults at https://probarion.xyz. It does not serve
// mainnet yet: its mainnet address is a setting of the web deployment (APP_ORIGIN_MAINNET, apps/web/src/lib/env.ts)
// with no public value. A tab that is not live yet has no URL either. Where there is no URL, the commands give the
// probarion CLI's owner transaction instead, and say why the console is left out.
import type { Network } from "./keys-file.js";

export const TESTNET_SITE = "https://probarion.xyz";

/** A tab of a vault's console: its label, its path after `/console/<vault>`, and whether the console has it yet. */
export interface ConsoleTab {
  label: string;
  path: string;
  /** False while the console has no such page: no URL is printed for it. */
  live: boolean;
}

/** The Agent (MCP) tab, where the owner pastes the two public keys and signs one transaction for each. */
export const AGENT_TAB: ConsoleTab = { label: "Agent (MCP)", path: "/agent", live: true };
export const OVERVIEW_TAB: ConsoleTab = { label: "Overview", path: "", live: true };
export const MANDATES_TAB: ConsoleTab = { label: "Mandates", path: "/mandates", live: true };
export const TOPUP_TAB: ConsoleTab = { label: "Top-up", path: "/topup", live: true };

/**
 * The tab's URL on testnet, when the tab is live; null otherwise. The vault must be a checked NEAR account id
 * (URL-safe as it is).
 */
export function consoleUrl(network: Network, vault: string, tab: ConsoleTab): string | null {
  return network === "testnet" && tab.live ? `${TESTNET_SITE}/console/${vault}${tab.path}` : null;
}

/** Why a tab has no URL: the console does not serve mainnet yet, or the tab is not live yet. */
export function consoleGap(network: Network, tab: ConsoleTab): string {
  return network === "mainnet"
    ? "the console does not serve mainnet yet"
    : `the console's ${tab.label} tab is not live yet`;
}

/**
 * A step the vault's owner takes, for a sentence: `onTab` on the console's tab when it has a URL, or `instead`
 * (the probarion CLI's transaction for the owner's wallet), with why the console is left out when it is.
 */
export function ownerStep(
  network: Network,
  vault: string,
  tab: ConsoleTab,
  onTab: string,
  instead: string,
): string {
  const url = consoleUrl(network, vault, tab);
  return url === null
    ? `the vault's owner ${instead} (${consoleGap(network, tab)})`
    : `the vault's owner ${onTab} on the ${tab.label} tab of the vault's console (${url}), or ${instead}`;
}
