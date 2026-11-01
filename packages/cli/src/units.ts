import { USDC_DECIMALS } from "@probarion/core";
import { CliError } from "./errors.js";

const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
// The contract takes amounts as U128 and times as U64 decimal strings; a larger number is not
// refused politely, it fails to parse inside the wallet or the node.
const U128_MAX = (1n << 128n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const NS_PER_SECOND = 1_000_000_000n;

export function toUnits(human: string, decimals: number, what: string): string {
  const match = DECIMAL_RE.exec(human.trim());
  if (match === null) {
    throw new CliError(
      `${what} must be a plain decimal number such as 25 or 0.5, got ${JSON.stringify(human)}`,
    );
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").slice(1);
  if (fraction.length > decimals) {
    throw new CliError(`${what} has more than ${decimals} decimal places: ${human}`);
  }
  const units =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units > U128_MAX) throw new CliError(`${what} is too large: ${human}`);
  return units.toString();
}

export function toSmallestUnits(human: string, what = "amount"): string {
  return toUnits(human, USDC_DECIMALS, what);
}

export function nearToYocto(human: string, what = "NEAR amount"): string {
  return toUnits(human, 24, what);
}

export function fromUnits(units: string, decimals: number): string {
  const value = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? (value / base).toString() : `${value / base}.${fraction}`;
}

export function yoctoToNear(yocto: string): string {
  return fromUnits(yocto, 24);
}

/** A NEAR amount in one canonical spelling (`5.00` and ` 5 ` both print as `5`), checked on the way. */
export function canonicalNear(human: string, what: string): string {
  return yoctoToNear(nearToYocto(human, what));
}

/** Returns `units` unchanged when it is above zero; the contract refuses a zero amount. */
export function assertPositive(units: string, what: string): string {
  if (BigInt(units) === 0n) throw new CliError(`${what} must be above 0`);
  return units;
}

export function hoursToNs(hours: string): string {
  const value = hours.trim();
  if (!/^[1-9][0-9]{0,5}$/.test(value)) {
    throw new CliError(`hours must be a positive integer, got ${JSON.stringify(hours)}`);
  }
  return (BigInt(value) * 3_600_000_000_000n).toString();
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/;

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/**
 * `YYYY-MM-DD` means the end of that UTC day. A time must say its zone (`Z` or `+hh:mm`): an
 * expiry that depends on the machine's time zone is not an expiry the owner can review. Dates are
 * checked against the calendar (JavaScript's own parser turns February 31 into March 3). The result
 * is in the future and fits the contract's U64 nanoseconds.
 */
export function parseExpiry(value: string, now: Date): string {
  const trimmed = value.trim();
  const match = ISO_RE.exec(trimmed);
  const reject = (): never => {
    throw new CliError(
      `--expires must be a real date YYYY-MM-DD, or an ISO-8601 time with its zone such as 2026-12-31T17:00:00Z or 2026-12-31T17:00:00+07:00, got ${JSON.stringify(value)}`,
    );
  };
  if (match === null) return reject();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dateOnly = match[4] === undefined;
  const hour = dateOnly ? 23 : Number(match[4]);
  const minute = dateOnly ? 59 : Number(match[5]);
  const second = dateOnly ? 59 : Number(match[6] ?? "0");
  const fractionNs = dateOnly ? 999_000_000n : BigInt((match[7] ?? "").padEnd(9, "0") || "0");
  const zone = match[8] ?? "Z";
  const zoneHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    zoneHour > 23 ||
    zoneMinute > 59
  ) {
    return reject();
  }
  const notFuture = (): never => {
    throw new CliError(`--expires ${value} is not in the future`);
  };
  if (year < 1970) return notFuture();
  const utcSeconds = BigInt(Date.UTC(year, month - 1, day, hour, minute, second)) / 1000n;
  const offsetSeconds =
    BigInt(zoneHour * 3600 + zoneMinute * 60) * (zone.startsWith("-") ? -1n : 1n);
  const ns = (utcSeconds - offsetSeconds) * NS_PER_SECOND + fractionNs;
  if (ns <= BigInt(now.getTime()) * 1_000_000n) return notFuture();
  if (ns > U64_MAX) {
    throw new CliError(
      `--expires ${value} is too far in the future for the contract's u64 nanoseconds`,
    );
  }
  return ns.toString();
}

export function positiveInt(value: string, what: string): number {
  if (!/^[1-9][0-9]{0,8}$/.test(value.trim()))
    throw new CliError(`${what} must be a positive integer`);
  return Number(value.trim());
}

export function nonNegativeInt(value: string, what: string): number {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value.trim())) {
    throw new CliError(`${what} must be a non-negative integer`);
  }
  return Number(value.trim());
}
