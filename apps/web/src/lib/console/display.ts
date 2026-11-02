/**
 * How the console words chain state. Pure, so client and server components share it.
 *
 * The rule for every figure: a value that could not be read is shown as "unavailable", never as a
 * zero or an empty list. An owner who sees "0 USDC" may act on it.
 */
import type { Tone } from "@/components/ui";

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
      return { tone: "info", label: "pending" };
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

/**
 * Whether an approver can still act on a held spend. The vault refuses `approve` when it is frozen
 * (Frozen) or the hold has run out (HoldExpired); `reject` works either way.
 */
export function heldActions(
  heldUntilNs: string | null,
  frozen: boolean,
  nowMs: number,
): { canApprove: boolean; note: string | null } {
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
