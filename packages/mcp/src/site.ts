// Links to the Probarion console. The site that serves testnet vaults is https://probarion.xyz. Which address
// serves mainnet is a setting of the web deployment (APP_ORIGIN_MAINNET, apps/web/src/lib/env.ts) that has no
// public value yet, so on mainnet these helpers name the console's tab in words and give no URL.
import type { Network } from "./keys-file.js";

export const TESTNET_SITE = "https://probarion.xyz";

/** A tab of a vault's console: its label, and its path after `/console/<vault>`. */
export interface ConsoleTab {
  label: string;
  path: string;
}

export const AGENT_TAB: ConsoleTab = { label: "Agent (MCP)", path: "/agent" };
export const OVERVIEW_TAB: ConsoleTab = { label: "Overview", path: "" };
export const MANDATES_TAB: ConsoleTab = { label: "Mandates", path: "/mandates" };
export const TOPUP_TAB: ConsoleTab = { label: "Top-up", path: "/topup" };

/** The tab's URL on testnet; null on mainnet. The vault must be a checked NEAR account id (URL-safe as it is). */
export function consoleUrl(network: Network, vault: string, tab: ConsoleTab): string | null {
  return network === "testnet" ? `${TESTNET_SITE}/console/${vault}${tab.path}` : null;
}

/** Where the tab is, for a sentence: its name, then the URL on testnet or the site's description on mainnet. */
export function consoleWhere(network: Network, vault: string, tab: ConsoleTab): string {
  const url = consoleUrl(network, vault, tab);
  return url === null
    ? `the ${tab.label} tab of the vault's console, on the Probarion site that serves mainnet`
    : `the ${tab.label} tab of the vault's console: ${url}`;
}
