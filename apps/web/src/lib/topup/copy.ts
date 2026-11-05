import type { Network } from "@/lib/config";
import { FT_STORAGE_DEPOSIT } from "@/lib/near/tx";
import { formatNear } from "@/lib/near/units";

// The sentences of the Top-up tab that are not about one quote. copy.test.ts holds each to the file it comes from.

export const FUNDING_NOTICE = {
  mainnet:
    "A top-up moves real money out of your wallet. You sign each one in your own wallet, and Probarion never signs for you. Put in only what your open mandates need.",
  testnet:
    "This is testnet, so the tokens here are test tokens. You sign each top-up in your own wallet, and Probarion never signs for you.",
} as const satisfies Record<Network, string>;

/**
 * Testnet has no NEAR Intents and no 1Click, so there is nothing to top up there. What stands in for them is
 * named from the network table, so the text follows the addresses.
 */
export function testnetBaseText(c: { intents: string; allowedAssets: { base: string } }): string {
  return `NEAR Intents and 1Click exist on mainnet only, so this page cannot top up a Base balance on testnet. Testnet uses a stand-in contract for Intents (${c.intents}) and a test token for Base USDC (${c.allowedAssets.base}), and nothing leaves NEAR.`;
}

export const baseCardNotConfigured =
  "1Click quotes are not set up on this server, so this card cannot offer a Base top-up yet.";

export const baseCardNotAllowed =
  "This vault does not allow Base USDC, so it could not pay a Base payee from it.";

/** What the deposit transaction attaches besides the USDC (`storage_deposit`, from the builder's own figure). */
export const registerDepositText = `The transaction also attaches ${formatNear(FT_STORAGE_DEPOSIT, 6)} NEAR to register the deposit address on the USDC contract.`;

/** "2026-11-08 10:30 UTC". Text that is not a date comes back as it is. */
export function deadlineText(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}
