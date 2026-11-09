import { explorerAccountUrl, explorerTxUrl, type Network } from "@/lib/config";
import { formatNear, formatUsdc } from "@/lib/near/units";
import { safeText } from "@/lib/proof/sanitize";

/** One `vault_events` row as `alerts_pending` hands it over. */
export interface AlertEvent {
  kind: string;
  event_key: string;
  spend_id: number | null;
  mandate_id: number | null;
  amount: string | null;
  code: string | null;
  tx_hash: string | null;
  payload: Record<string, unknown>;
  observed_at: string;
}

export type AlertChannel = "telegram" | "email";

// A message is plain text in front of an owner who may act on it, and a spend's `ref`, `memo` and destination are
// words a payee or an agent chose. They never go in. What does go in is a value this file checked first: a number,
// a refusal code of plain letters, a base58 hash or key, a vault id. Each one still passes through `clean`, so a
// control or bidi character cannot get into a line even if a check above it is ever loosened.
const CODE = /^[A-Za-z]{1,40}$/;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DIGITS = /^\d{1,30}$/;
const UNKNOWN_CODE = "a code the contract returned";

const clean = (value: unknown, max = 120): string => safeText(value, max);
const digits = (v: unknown): string | null => (typeof v === "string" && DIGITS.test(v) ? v : null);
const wholeNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** "Spend #7 (mandate #2)", leaving out an id that is not a plain number. */
function spendWords(e: AlertEvent): string {
  const spend = wholeNumber(e.spend_id);
  const mandate = wholeNumber(e.mandate_id);
  const head = spend === null ? "A spend" : `Spend #${spend}`;
  return mandate === null ? head : `${head} (mandate #${mandate})`;
}

/** "2026-11-14 09:30 UTC" from a hold's end in nanoseconds, or null when it is not a time. */
function holdEnds(payload: Record<string, unknown>): string | null {
  const ns = digits(payload.held_until_ns);
  if (ns === null) return null;
  const at = new Date(Number(BigInt(ns) / 1_000_000n));
  return Number.isNaN(at.getTime())
    ? null
    : `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatAlert(
  e: AlertEvent,
  vault: string,
  network: Network,
  origin: string,
  channel: AlertChannel = "telegram",
  stopUrl?: string,
): { subject: string; text: string } {
  const v = clean(vault, 80);
  const usdc = digits(e.amount);
  const amount = usdc === null ? "" : `${formatUsdc(usdc)} USDC`;
  const consoleUrl = `${origin}/console/${v}`;
  const evidence =
    typeof e.tx_hash === "string" && TX_HASH.test(e.tx_hash)
      ? explorerTxUrl(network, e.tx_hash)
      : explorerAccountUrl(network, v);
  // An event row's payload is any JSON (a hand-made row can hold null or a list): read only an object.
  const payload: Record<string, unknown> =
    typeof e.payload === "object" && e.payload !== null && !Array.isArray(e.payload)
      ? e.payload
      : {};
  const lines: string[] = [];
  let subject: string;
  switch (e.kind) {
    case "spend_held": {
      subject = `[Probarion] Approval needed${amount ? `: ${amount}` : ""} on ${v}`;
      lines.push(`${spendWords(e)} is held until an approver signs.`);
      const ends = holdEnds(payload);
      if (ends !== null) lines.push(`The hold ends ${ends}.`);
      // The overview's held card (id="held"), which comes first while a spend waits.
      lines.push(`Approve or reject: ${consoleUrl}#held`);
      break;
    }
    case "spend_paid":
      subject = `[Probarion] Paid${amount ? ` ${amount}` : ""} from ${v}`;
      lines.push(`${spendWords(e)} was paid on NEAR.`);
      break;
    case "spend_burned":
      subject = `[Probarion] Paid${amount ? ` ${amount}` : ""} to Base from ${v}`;
      lines.push(
        `${spendWords(e)} was withdrawn through NEAR Intents to the mandate's Base address.`,
      );
      break;
    case "spend_failed":
      subject = `[Probarion] Payout failed on ${v}`;
      lines.push(`${spendWords(e)} failed; its reservation was released. Nothing left the vault.`);
      break;
    case "refused_by_contract": {
      const code = typeof e.code === "string" && CODE.test(e.code) ? e.code : UNKNOWN_CODE;
      subject = `[Probarion] Contract refused a spend on ${v}: ${code}`;
      lines.push(`The vault rejected a spend with PROBARION:${code}. No funds moved.`);
      break;
    }
    case "allowance_low": {
      const key = payload.public_key;
      const publicKey = typeof key === "string" && PUBLIC_KEY.test(key) ? key : null;
      const noun = payload.purpose === "ledger" ? "ledger key" : "agent key";
      subject = `[Probarion] ${noun === "agent key" ? "Agent" : "Ledger"} key gas allowance low on ${v}`;
      const who =
        publicKey === null
          ? `${noun === "agent key" ? "An" : "A"} ${noun}`
          : `The ${noun} ${publicKey}`;
      lines.push(
        `${who} has less than 0.2 NEAR of gas allowance left. Add a new key: ${consoleUrl}/keys`,
      );
      break;
    }
    case "near_low": {
      const free = digits(payload.free_yocto);
      subject = `[Probarion] Vault is low on NEAR: ${v}`;
      // The Overview's "Send NEAR to this vault" panel (SendNearPanel, id="send-near"): /topup funds USDC only.
      lines.push(
        `${free === null ? "The vault's free NEAR is" : `The vault has ${formatNear(free)} NEAR free, and it is`} under 0.05 NEAR. Without NEAR it cannot record a payment. Send NEAR to the vault: ${consoleUrl}#send-near`,
      );
      break;
    }
    default:
      subject = `[Probarion] ${clean(e.kind, 40)} on ${v}`;
      lines.push(`Event ${clean(e.event_key, 80)}.`);
  }
  lines.push(`Evidence: ${evidence}`, "");
  if (channel === "email") {
    lines.push(
      stopUrl
        ? `Stop or change alerts: stop these emails ${stopUrl} or open ${consoleUrl}/alerts`
        : `Stop or change alerts: open ${consoleUrl}/alerts`,
    );
  } else {
    // /stop ends the chat's alerts for every vault, and the line says so: the bot then says how many it stopped.
    lines.push(
      `Stop or change alerts: send /stop to stop alerts for every vault in this chat, or open ${consoleUrl}/alerts`,
    );
  }
  return { subject, text: lines.join("\n") };
}
