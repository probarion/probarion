/** Small helpers shared by the Canary pages. Pure, and safe in the browser. */
import { formatUsdc } from "@/lib/near/units";

/** "4000" as "4,000": the same text in every runtime, whatever its locale data. */
export const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** "2026-11-06 10:15" for an ISO time, read in UTC. Text that is not a time is shown as it is. */
export function utcMinute(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** A plain object: not null, not an array. The one guard the Canary's parsers share. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Whole USDC from base units, or null for anything that is not a whole number of them (up to 39 digits, the size of
 * a U128). The one place that checks this before `formatUsdc`, which throws on anything else.
 */
export function usdcFromUnits(units: string | null): string | null {
  return units !== null && /^[0-9]{1,39}$/.test(units) ? formatUsdc(units) : null;
}
