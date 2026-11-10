/**
 * How the console words chain state. Pure, so client and server components share it.
 *
 * The rule for every figure: a value that could not be read is shown as "unavailable", never as a
 * zero or an empty list. An owner who sees "0 USDC" may act on it.
 */
import type { Payee } from "@probarion/core";
import type { Tone } from "@/components/ui";
import { formatUsdc, nsToDate } from "@/lib/near/units";

export const UNAVAILABLE = "unavailable";

/** A part of the overview that was read (`ok`) or not. Mirrors `Read` in vaults.ts without its import. */
export type Shown<T> = { ok: true; value: T } | { ok: false; kind: string };

/** The formatted value, or "unavailable". `fmt` is only ever called on a value that was read. */
export function shown<T>(r: Shown<T>, fmt: (value: T) => string): string {
  return r.ok ? fmt(r.value) : UNAVAILABLE;
}

/** Why a part is missing, in words for a tooltip or a note. */
export function whyUnavailable(kind: string): string {
  switch (kind) {
    case "transport":
      return "NEAR could not be reached";
    case "rpc":
      return "the NEAR node gave an answer the console could not read";
    case "contract":
      return "the contract refused the read (a wrong token or Intents id, not a zero)";
    case "skipped":
      return "the vault's config could not be read";
    case "not_allowed":
      return "this vault does not allow the network's Base USDC asset";
    default:
      return "the read failed";
  }
}

export interface StatusView {
  tone: Tone;
  label: string;
}

/**
 * A spend's status. The chain's statuses are snake_case (IF §4.1); `unconfirmed` is the SDK's
 * outcome for a spend that was sent and not yet confirmed: never shown as failed. Anything else is
 * shown as it came, neutral.
 */
export function spendStatusView(status: string): StatusView {
  switch (status) {
    case "held":
      return { tone: "warn", label: "held for approval" };
    case "pending":
      return { tone: "warn", label: "pending" };
    case "paid":
      return { tone: "good", label: "paid" };
    case "burned":
      return { tone: "good", label: "paid out via Intents" };
    case "failed":
      return { tone: "bad", label: "failed, released" };
    case "rejected":
      return { tone: "neutral", label: "rejected" };
    case "expired":
      return { tone: "neutral", label: "hold expired" };
    case "unconfirmed":
      return { tone: "warn", label: "sent: confirmation pending" };
    default:
      return { tone: "neutral", label: status.slice(0, 40) || "unknown" };
  }
}

export function mandateStatusView(status: string): StatusView {
  switch (status) {
    case "active":
      return { tone: "good", label: "active" };
    case "exhausted":
      return { tone: "neutral", label: "exhausted" };
    case "revoked":
      return { tone: "neutral", label: "revoked" };
    default:
      return { tone: "neutral", label: status.slice(0, 40) || "unknown" };
  }
}

// ---- amounts, payees and hold ends, as the overview and the approval page show them -------------

const DIGITS = /^(0|[1-9][0-9]*)$/;

/** A U128 of the network's USDC (6 decimals), or a plain word when it is not a decimal (never "0"). */
export function usdcText(units: string): string {
  return DIGITS.test(units) ? formatUsdc(units) : "unreadable";
}

/**
 * Amounts in the vault's own token. The console knows the decimals of the network's USDC only; any
 * other token is shown in raw base units and says so, never scaled by a guess.
 */
export function tokenAmount(token: string, networkUsdc: string): (units: string) => string {
  if (token === networkUsdc) return (units) => `${usdcText(units)} USDC`;
  return (units) =>
    `${DIGITS.test(units) ? units : "unreadable"} base units of ${token} (decimals unknown)`;
}

export function payeeText(p: Payee): string {
  return p.type === "near" ? p.account_id : `${p.chain}:${p.address}`;
}

/** "2026-11-14 09:30 UTC" from a hold's end in nanoseconds, or "n/a" when it is not a time. */
export function holdEndText(heldUntilNs: string | null): string {
  if (heldUntilNs === null || !DIGITS.test(heldUntilNs)) return "n/a";
  return `${nsToDate(heldUntilNs).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/**
 * Whether an approver can still act on a held spend. The vault refuses `approve` when it is frozen
 * (Frozen) or the hold has run out (HoldExpired); `reject` works either way.
 */
export function heldActions(
  heldUntilNs: string | null,
  frozen: boolean,
  nowMs: number,
): { canApprove: boolean; note: string | null } {
  // The view's U64 is a decimal string; anything else is not a time to compare (and BigInt throws on it).
  if (heldUntilNs !== null && !/^(0|[1-9][0-9]*)$/.test(heldUntilNs)) {
    return {
      canApprove: false,
      note: "The hold's end time could not be read: approve is not offered.",
    };
  }
  const expired = heldUntilNs === null || BigInt(heldUntilNs) < BigInt(nowMs) * 1_000_000n;
  if (expired)
    return {
      canApprove: false,
      note: "The hold has run out: the vault refuses approve (HoldExpired).",
    };
  if (frozen)
    return {
      canApprove: false,
      note: "The vault is frozen: the vault refuses approve until it is unfrozen.",
    };
  return { canApprove: true, note: null };
}

// ---- out of NEAR on a call the console asks you to sign (W-T8-R1) --------------------------------

/**
 * A console call (freeze, withdraw, approve, reject, create, a top-up) is signed by the owner or an
 * approver. When the chain refuses it as out of NEAR (`LackBalanceForState`, `NotEnoughBalance`),
 * the signer's account is the first suspect: it pays the gas and any deposit. The SDK's
 * OUT_OF_NEAR_DETAIL, which blames the vault, is right only for spends the vault's agent key signs.
 */
export const SIGNER_OUT_OF_NEAR =
  "Your account (the signer) or the vault is short of NEAR: check your wallet first.";

/** Added only when the vault's own free NEAR reads low (below 0.1 NEAR, the amber runway). */
export const VAULT_LOW_SUGGESTION =
  "The vault's free NEAR also reads low (below 0.1 NEAR): Send NEAR to this vault.";

/**
 * The wording for a console-signed call that came back out of NEAR, or null for any other code.
 * `codes` are the SDK's out-of-NEAR codes, handed down from the server (out-of-near.ts).
 */
export function consoleOutOfNear(
  code: string | null,
  codes: readonly string[],
  vaultNearLow: boolean,
): { text: string; suggestTopUp: boolean } | null {
  if (code === null || !codes.includes(code)) return null;
  return vaultNearLow
    ? { text: `${SIGNER_OUT_OF_NEAR} ${VAULT_LOW_SUGGESTION}`, suggestTopUp: true }
    : { text: SIGNER_OUT_OF_NEAR, suggestTopUp: false };
}

/**
 * The outcome reader (lib/near/confirm.ts, Task 6) puts the SDK's vault-only text into `error` for
 * these codes. A console-signed call replaces it here, chosen by the code alone. TxButton shows the
 * same result object it hands to onResult, so the replaced text is what the signer reads.
 * Returns the wording used, or null when the code is not an out-of-NEAR one (nothing changed).
 */
export function rewordOutOfNear(
  r: { code: string | null; error: string | null },
  codes: readonly string[],
  vaultNearLow: boolean,
): { text: string; suggestTopUp: boolean } | null {
  const v = consoleOutOfNear(r.code, codes, vaultNearLow);
  if (v !== null) r.error = v.text;
  return v;
}
