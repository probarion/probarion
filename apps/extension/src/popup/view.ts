import type { Inbox, InboxMandate, InboxVault, Sent } from "../api";
import type { Captured } from "../capture";
import { hostOf } from "../origins";
import type { Network } from "../storage";

// The popup's words, kept apart from its DOM so that the tests read them (spec §5.6; the console's copy rules:
// sentence case, no "please", no exclamation marks).

export const NOTE =
  "Nothing is paid from the browser. It waits until you confirm it in the console with your wallet.";

/** The same note for an approver of the vault: only its owner confirms. */
export const NOTE_APPROVER =
  "Nothing is paid from the browser. It waits until the vault's owner confirms it in the console with their wallet.";

export const noteFor = (role: "owner" | "approver"): string =>
  role === "owner" ? NOTE : NOTE_APPROVER;

export const usdc = (amount: string): string =>
  /^[0-9]+(\.[0-9]+)?$/.test(amount) ? `${amount} USDC` : "an unreadable amount";

export const networkText = (n: Network): string => (n === "mainnet" ? "Mainnet" : "Testnet");

export function mandateLabel(m: InboxMandate): string {
  return `${m.label || `Mandate #${m.id}`} · ${m.payee} · ${usdc(m.per_payment)} per payment`;
}

export function utc(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "an unknown time";
}

export interface Row {
  title: string;
  detail: string;
  url: string;
}

/** What waits for the person across the vaults: invoices for the owner's Confirm first, then held payments. */
export function waitingRows(inbox: Inbox): Row[] {
  const rows: Row[] = [];
  for (const v of inbox.vaults) {
    for (const a of v.awaiting) {
      rows.push({
        title: `${usdc(a.amount)} to ${a.payee ?? "a payee NEAR couldn't show"}`,
        detail: [
          a.ref || "Invoice",
          v.name,
          a.source === "extension" ? "sent from the extension" : null,
        ]
          .filter((x) => x !== null)
          .join(" · "),
        url: a.url,
      });
    }
  }
  for (const v of inbox.vaults) {
    for (const held of v.held) {
      rows.push({
        title: `${usdc(held.amount)} to ${held.payee}`,
        detail: [
          `Held payment #${held.spend_id}`,
          v.name,
          held.held_until ? `until ${utc(held.held_until)}` : null,
        ]
          .filter((x) => x !== null)
          .join(" · "),
        url: held.url,
      });
    }
  }
  return rows;
}

export const waitingCount = (inbox: Inbox): number => inbox.counts.awaiting + inbox.counts.held;

export const vaultsWithMandates = (inbox: Inbox): InboxVault[] =>
  inbox.vaults.filter((v) => v.mandates.length > 0);

/** What a send came to. For an approver the owner is the one who confirms. */
export function sentText(s: Sent, role: "owner" | "approver" = "owner"): string {
  const who = role === "owner" ? "your confirmation" : "the owner's confirmation";
  if (!s.duplicate) return `Queued. It waits for ${who}.`;
  return s.status === "awaiting_owner"
    ? `Already queued. It waits for ${who}.`
    : "Probarion already has this invoice. Open it to see what happened.";
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const itemText = (item: Captured): string =>
  item.preview !== null ? `"${item.preview}"` : `${item.name} · ${sizeText(item.size)}`;

/** The label a pairing-code token gets on Probarion's list of connected browsers. */
export function browserLabel(uaData: { platform?: unknown } | undefined): string {
  const platform = typeof uaData?.platform === "string" ? uaData.platform.trim().slice(0, 30) : "";
  return platform ? `Chrome on ${platform}` : "Chrome";
}

/**
 * What Connect lists, by host, and what it preselects: `preferred` while it is among the offered addresses, else the
 * first of them.
 */
export function connectChoices(
  offered: readonly string[],
  preferred: string,
): { options: Array<[string, string]>; selected: string } {
  return {
    options: offered.map((o): [string, string] => [o, hostOf(o)]),
    selected: offered.includes(preferred) ? preferred : (offered[0] ?? preferred),
  };
}

/**
 * Which control of a new screen gets focus once an action that started from `started` (a control's data-focus name)
 * is done: that control if it is still there and enabled, else the screen's first enabled control; null when it has
 * none. `controls` are the screen's controls in page order, and the answer is an index into them.
 */
export function focusTarget(
  started: string | undefined,
  controls: ReadonlyArray<{ key: string | undefined; enabled: boolean }>,
): number | null {
  if (started !== undefined) {
    const same = controls.findIndex((c) => c.enabled && c.key === started);
    if (same >= 0) return same;
  }
  const first = controls.findIndex((c) => c.enabled);
  return first >= 0 ? first : null;
}
