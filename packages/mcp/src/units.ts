import { USDC_DECIMALS } from "@probarion/core";

/** USDC as a person writes it: up to 12 integer digits, up to 6 decimals, no sign, exponent or separator. */
export const USDC_AMOUNT_RE = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;

export class AmountError extends Error {}

const BASE = 10n ** BigInt(USDC_DECIMALS);

/** "25.50" USDC to "25500000" smallest units. Zero, and anything that is not a plain decimal, throws. */
export function parseUsdc(human: string): string {
  if (!USDC_AMOUNT_RE.test(human)) {
    throw new AmountError(
      `amount must be a USDC decimal string such as "25" or "25.50", with at most ${USDC_DECIMALS} decimals; got ${JSON.stringify(human).slice(0, 40)}`,
    );
  }
  const [whole = "0", fraction = ""] = human.split(".");
  const units = BigInt(whole) * BASE + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
  if (units === 0n) throw new AmountError("amount must be greater than 0");
  return units.toString();
}

/** "25500000" smallest units to "25.50" USDC: at least two decimals, no trailing zeros past them. */
export function formatUsdc(units: string): string {
  const value = BigInt(units);
  let fraction = (value % BASE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${value / BASE}.${fraction}`;
}
