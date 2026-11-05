import { safeText } from "@/lib/proof/sanitize";

// The strict forms the Payables pages, services and the confirmation message share, and the one way they write a
// time. Pure, so a client component may import it.

/** An invoice id. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A positive amount in USDC base units, in its one canonical spelling (a U128 fits in 39 digits). */
export const AMOUNT = /^[1-9][0-9]{0,38}$/;
/** 32 bytes in lower-case hex: an invoice hash, a nonce. */
export const HEX32 = /^[0-9a-f]{64}$/;
/** A non-negative decimal integer in its one canonical spelling. */
export const DIGITS = /^(0|[1-9][0-9]*)$/;

/** "2026-11-09 10:00 UTC" for an ISO time; anything else is shown as safe text. */
export function utcMinute(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? safeText(iso, 40)
    : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
