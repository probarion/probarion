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

/**
 * A mandate as the Mandate select names it. The per-payment amount comes before the payee: a closed select in the 360 px
 * popup cuts its text at the end, and the amount is what the person checks before Send. The select's title holds it all.
 */
export function mandateLabel(m: InboxMandate): string {
  return `${m.label || `Mandate #${m.id}`} · ${usdc(m.per_payment)} per payment · ${m.payee}`;
}

/** A vault as the Vault select names it: its name, then its id when the name differs. */
export const vaultLabel = (v: InboxVault): string =>
  v.name === v.vault ? v.vault : `${v.name} (${v.vault})`;

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

/**
 * The role the note and the "no mandate" sentence speak to: the role in the vault the Send section shows (the chosen
 * one when it takes invoices, else the first that does). When no vault takes invoices, the person is an approver only
 * if they own none of their vaults, since only an owner confirms and creates mandates.
 */
export function roleFor(inbox: Inbox, chosen: string | null): "owner" | "approver" {
  const usable = vaultsWithMandates(inbox);
  const shown = usable.find((v) => v.vault === chosen) ?? usable[0];
  if (shown !== undefined) return shown.role;
  return inbox.vaults.length > 0 && inbox.vaults.every((v) => v.role === "approver")
    ? "approver"
    : "owner";
}

/**
 * What the Send section says when no vault takes invoices now. When NEAR couldn't be read for a vault, its mandates are
 * missing from the answer, so saying "no mandate" would be wrong: it says what happened and offers Retry.
 */
export function noMandates(inbox: Inbox): { text: string; retry: boolean } {
  if (inbox.vaults.some((v) => v.chain === "unavailable")) {
    return {
      text: "NEAR couldn't be read, so Probarion can't list the mandates now. Try again.",
      retry: true,
    };
  }
  return {
    text:
      roleFor(inbox, null) === "approver"
        ? "No active mandate can take invoices. The vault's owner creates one in the console."
        : "No active mandate can take invoices. Create one in the console.",
    retry: false,
  };
}

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
 * is done: that control if it is still there and enabled, else `landing` (the control the action leads to, such as Send
 * after a file was taken) if it is there and enabled, else the screen's first enabled control; null when it has none.
 * `controls` are the screen's controls in page order, and the answer is an index into them.
 */
export function focusTarget(
  started: string | undefined,
  controls: ReadonlyArray<{ key: string | undefined; enabled: boolean }>,
  landing?: string,
): number | null {
  for (const key of [started, landing]) {
    if (key === undefined) continue;
    const same = controls.findIndex((c) => c.enabled && c.key === key);
    if (same >= 0) return same;
  }
  const first = controls.findIndex((c) => c.enabled);
  return first >= 0 ? first : null;
}
