import type { Network } from "@/lib/config";
import { describeTxResult, type ResultWords, type TxResult } from "@/lib/near/outcome";
import { FT_STORAGE_DEPOSIT } from "@/lib/near/tx";
import { formatNear } from "@/lib/near/units";

// The sentences of the Top-up tab that are not about one quote. copy.test.ts holds each to the file it comes from.

export const FUNDING_NOTICE = {
  mainnet:
    "A top-up moves real money out of your wallet. You sign each one in your own wallet, and Probarion never signs for you. Put in only what your open mandates need.",
  testnet:
    "This is testnet, so the tokens here are test tokens. You sign each top-up in your own wallet, and Probarion never signs for you.",
} as const satisfies Record<Network, string>;

/** The one place this sentence is written: the routes, the panel's error text and the testnet card all use it. */
export const ONLY_ON_MAINNET = "NEAR Intents and 1Click exist on mainnet only";

/**
 * Testnet has no NEAR Intents and no 1Click, so there is nothing to top up there. What stands in for them is
 * named from the network table, so the text follows the addresses.
 */
export function testnetBaseText(c: { intents: string; allowedAssets: { base: string } }): string {
  return `${ONLY_ON_MAINNET}, so this page cannot top up a Base balance on testnet. Testnet uses a stand-in contract for Intents (${c.intents}) and a test token for Base USDC (${c.allowedAssets.base}), and nothing leaves NEAR.`;
}

export const baseCardNotConfigured =
  "1Click quotes are not set up on this server, so this card cannot offer a Base top-up yet.";

export const baseCardNotAllowed =
  "This vault does not allow Base USDC, so it could not pay a Base payee from it.";

/** What the deposit transaction attaches besides the USDC (`storage_deposit`, from the builder's own figure). */
export const registerDepositText = `The transaction also attaches ${formatNear(FT_STORAGE_DEPOSIT, 6)} NEAR to register the deposit address on the USDC contract.`;

/**
 * What the owner reads under the wallet's result once the NEAR transfer has landed. The headline ("Done") is the
 * transfer's and stays the wallet button's own; this line says what is and is not done: the swap into Base USDC is
 * 1Click's step, and its status is read below.
 */
export const DEPOSIT_SENT_DETAIL =
  "The NEAR transfer to the deposit address went through. The swap into Base USDC is 1Click's step and may not be done yet: its status is shown below.";

/**
 * A top-up deposit left unconfirmed locks the button for the vault, across quotes (the lock is keyed by the vault),
 * so the note says what the result belongs to even under a later quote.
 */
export const UNCONFIRMED_DEPOSIT_NOTE =
  "An earlier top-up deposit from this vault is not confirmed. Check it on the explorer before you sign another.";

/** `TxButton`'s `describe` for the Base top-up deposit: words for a landed transfer and for an unconfirmed one. */
export function describeDeposit(r: TxResult): ResultWords | undefined {
  if (r.status === "ok") return { detail: DEPOSIT_SENT_DETAIL };
  if (r.status === "unknown") {
    const own = describeTxResult(r).detail;
    return { detail: own ? `${own} ${UNCONFIRMED_DEPOSIT_NOTE}` : UNCONFIRMED_DEPOSIT_NOTE };
  }
  return undefined;
}

/** "2026-11-08 10:30 UTC". Text that is not a date comes back as it is. */
export function deadlineText(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}
