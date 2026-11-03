/**
 * How a mandate read from the chain is worded and shown. Pure, no SDK, no I/O: a page, a table cell
 * and a test share it. Every figure and string here came from the chain, so nothing is trusted to be
 * well formed: an unreadable value is shown as "unreadable" (or offers no action), never as a zero, an
 * empty string or a throw.
 */
import type { MandateView } from "@probarion/core";
import type { Tone } from "@/components/ui";
import { mandateStatusView } from "@/lib/console/display";
import { formatUsdc } from "@/lib/near/units";
import { isNearAccountId } from "@/lib/near/validate";

export const DIGITS = /^(0|[1-9][0-9]*)$/;
const NS_PER_MS = 1_000_000n;

/**
 * Characters that are never shown as they came and never accepted in a label: control characters,
 * format characters (\p{Cf}: direction marks and overrides, zero-width space, and also the zero-width
 * joiner and non-joiner that emoji sequences and some scripts use), surrogates that are not part of a
 * pair (no JSON string can carry one), and line/paragraph separators.
 */
export const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_TEXT_ALL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/** Text that came from the chain, made safe to show: unsafe characters replaced, length cut. */
export function safeChainText(value: unknown, max = 64): string {
  if (typeof value !== "string") return "unreadable";
  const clean = value.replace(UNSAFE_TEXT_ALL, "�");
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : clean;
}

/** Base units as USDC text, or "unreadable" for anything that is not a decimal (never a throw, never 0). */
export function usdcText(units: string): string {
  return typeof units === "string" && DIGITS.test(units) ? formatUsdc(units) : "unreadable";
}

/** `max_total - spent - reserved`: what the contract still lets through (`OverMandateTotal`). */
export function remainingUnits(
  m: Pick<MandateView, "max_total" | "spent" | "reserved">,
): string | null {
  const parts = [m.max_total, m.spent, m.reserved];
  if (!parts.every((p) => typeof p === "string" && DIGITS.test(p))) return null;
  const left = BigInt(m.max_total) - BigInt(m.spent) - BigInt(m.reserved);
  return (left < 0n ? 0n : left).toString();
}

export interface MandateState {
  key: "active" | "expired" | "revoked" | "exhausted" | "unknown";
  label: string;
  tone: Tone;
  /** Whether Revoke is offered: only where it still changes what the contract will do. */
  canRevoke: boolean;
  /** Why Revoke is offered on a mandate that looks finished (an expired one), or null. */
  revokeNote: string | null;
}

/** W-T9-R1: what Revoke does on an expired mandate that still has funds reserved. */
export const EXPIRED_REVOKE_NOTE =
  "Expired, but part of it is still reserved by held or pending payments. Revoking stops its held payments from being approved.";

/**
 * The chain's `status` is active, revoked or exhausted; it never says expired, because expiry is a
 * time. The contract refuses a NEW spend when `now >= expires_at_ns` (checks.rs), so that is when this
 * says expired, even though the chain still says `active`.
 *
 * Revoke, by case (contracts/vault/src/held.rs, mandates.rs):
 *  - active or exhausted, in date: offered. (A released spend gives its use back, so an exhausted
 *    mandate can pay again.)
 *  - revoked: never. Revoked wins over expired.
 *  - expired: offered only while funds are still reserved (`reserved > 0`, held or pending
 *    payments). `approve` does not look at the mandate's expiry, only that it is not revoked, so a spend
 *    that was held before the expiry can still be paid after it. Revoking is what stops that (it makes
 *    `approve` fail with MandateInactive). A payout already pending still settles either way. With
 *    nothing reserved there is nothing left to stop, so no Revoke.
 *  - a status, expiry or reserved figure that cannot be read: nothing is offered.
 */
export function mandateState(
  m: Pick<MandateView, "status" | "expires_at_ns" | "reserved">,
  nowMs: number,
): MandateState {
  const status: string = m.status;
  if (status === "revoked") {
    return { key: "revoked", ...mandateStatusView("revoked"), canRevoke: false, revokeNote: null };
  }
  if (status !== "active" && status !== "exhausted") {
    return {
      key: "unknown",
      tone: "neutral",
      label: safeChainText(status, 39) || "unknown",
      canRevoke: false,
      revokeNote: null,
    };
  }
  if (typeof m.expires_at_ns !== "string" || !DIGITS.test(m.expires_at_ns)) {
    return {
      key: "unknown",
      tone: "warn",
      label: "expiry unreadable",
      canRevoke: false,
      revokeNote: null,
    };
  }
  if (BigInt(Math.floor(nowMs)) * NS_PER_MS >= BigInt(m.expires_at_ns)) {
    const held =
      typeof m.reserved === "string" && DIGITS.test(m.reserved) && BigInt(m.reserved) > 0n;
    return {
      key: "expired",
      tone: "neutral",
      label: "expired",
      canRevoke: held,
      revokeNote: held ? EXPIRED_REVOKE_NOTE : null,
    };
  }
  return { key: status, ...mandateStatusView(status), canRevoke: true, revokeNote: null };
}

export type PayeeView =
  /** A valid account id: safe to build an explorer link from. */
  | { kind: "near"; account: string }
  /** The address matches its chain's format (validate.rs). */
  | { kind: "intents"; chain: "base" | "solana"; address: string }
  /** Anything else, as text already made safe. Never linked. */
  | { kind: "unreadable"; text: string };

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A payee read from the chain, checked before it is shown or linked: an account id must fit the NEAR
 * grammar, an address its chain's format. What does not fit is shown as plain safe text with no link.
 */
export function payeeView(payee: unknown): PayeeView {
  if (typeof payee !== "object" || payee === null) {
    return { kind: "unreadable", text: "unreadable payee" };
  }
  const p = payee as Record<string, unknown>;
  if (p.type === "near") {
    return typeof p.account_id === "string" && isNearAccountId(p.account_id)
      ? { kind: "near", account: p.account_id }
      : { kind: "unreadable", text: safeChainText(p.account_id) };
  }
  if (p.type === "intents" && typeof p.address === "string") {
    if (p.chain === "base" && EVM_ADDRESS.test(p.address)) {
      return { kind: "intents", chain: "base", address: p.address };
    }
    if (p.chain === "solana" && SOLANA_ADDRESS.test(p.address)) {
      return { kind: "intents", chain: "solana", address: p.address };
    }
    return {
      kind: "unreadable",
      text: `${safeChainText(p.chain, 16)}:${safeChainText(p.address)}`,
    };
  }
  return { kind: "unreadable", text: "unreadable payee" };
}

/**
 * `2026-12-31 23:59 UTC` for a time in nanoseconds (with `withSeconds`, `2026-12-31 23:59:59 UTC`, the
 * exact time a mandate's expiry carries), or "unreadable" (never a throw).
 */
export function expiryText(ns: string, withSeconds = false): string {
  if (typeof ns !== "string" || !DIGITS.test(ns)) return "unreadable";
  const date = new Date(Number(BigInt(ns) / NS_PER_MS));
  if (Number.isNaN(date.getTime())) return "unreadable";
  const iso = date.toISOString();
  return `${iso.slice(0, withSeconds ? 19 : 16).replace("T", " ")} UTC`;
}

/** The start and end of a purpose sha256 (64 lowercase hex), or "unreadable". */
export function purposeShort(hash: string): string {
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
    ? `${hash.slice(0, 8)}…${hash.slice(-6)}`
    : "unreadable";
}

/** The full hash when it is a sha256 (for a tooltip), else undefined: a chain string never goes in an attribute unchecked. */
export function purposeTitle(hash: string): string | undefined {
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? hash : undefined;
}
