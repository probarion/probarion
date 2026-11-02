import { USDC_DECIMALS } from "@probarion/core";

/** A human amount or date the owner typed that cannot be turned into chain units. Its message is for the form. */
export class AmountError extends Error {}

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

/** "12.5" with 6 decimals -> "12500000". Plain decimals only: no sign, exponent, separator or leading zero. */
export function parseUnits(human: string, decimals: number): string {
  const s = human.trim();
  if (!DECIMAL.test(s)) throw new AmountError("Use a plain decimal number such as 12.50");
  const [int, frac = ""] = s.split(".") as [string, string?];
  if (frac.length > decimals) throw new AmountError(`At most ${decimals} decimal places`);
  return (
    BigInt(int) * 10n ** BigInt(decimals) +
    BigInt(frac.padEnd(decimals, "0") || "0")
  ).toString();
}

/**
 * Base units -> a decimal string with no trailing zeros. Digits past `maxFrac` are cut, never
 * rounded, so a balance is never shown as more than it is.
 */
export function formatUnits(units: string, decimals: number, maxFrac: number = decimals): string {
  const v = BigInt(units);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / base}${frac ? `.${frac}` : ""}`;
}

export const parseUsdc = (h: string) => parseUnits(h, USDC_DECIMALS);
export const formatUsdc = (u: string) => formatUnits(u, USDC_DECIMALS);
export const parseNear = (h: string) => parseUnits(h, 24);
export const formatNear = (u: string, maxFrac = 4) => formatUnits(u, 24, maxFrac);

export function hoursToNs(hours: number): string {
  return (BigInt(Math.round(hours * 3600)) * 1_000_000_000n).toString();
}

/** "YYYY-MM-DD" -> the last second of that UTC day, in ns (mandate expiry). */
export function dateToNs(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) throw new AmountError("Use a date like 2026-12-31");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d, 23, 59, 59);
  const check = new Date(ms);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new AmountError("Not a real date");
  }
  return (BigInt(ms) * 1_000_000n).toString();
}

export function nsToDate(ns: string): Date {
  return new Date(Number(BigInt(ns) / 1_000_000n));
}
