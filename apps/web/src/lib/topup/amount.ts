import { AmountError, parseUsdc } from "@/lib/near/units";

/**
 * Kept apart from oneclick.ts so the console panels can use it without loading the 1Click SDK into the
 * browser: the route, the server action and the two panels all read an amount through here.
 */

/** 1 USDC. */
export const MIN_TOPUP_UNITS = 1_000_000n;
/** 1,000 USDC per top-up during the beta. */
export const MAX_TOPUP_UNITS = 1_000_000_000n;
export const TOPUP_RANGE_TEXT = "Between 1 and 1000 USDC";

export type ParsedAmount = { units: string } | { problem: string };

function parse(amount: string): { units: string } | { problem: string } {
  try {
    return { units: parseUsdc(amount) };
  } catch (e) {
    return { problem: e instanceof AmountError ? e.message : "Invalid amount" };
  }
}

/** The USDC the owner asks 1Click to put into the vault's Intents account, in units, or why it cannot be asked. */
export function parseTopupAmount(amount: string): ParsedAmount {
  const r = parse(amount);
  if ("problem" in r) return r;
  const v = BigInt(r.units);
  return v < MIN_TOPUP_UNITS || v > MAX_TOPUP_UNITS ? { problem: TOPUP_RANGE_TEXT } : r;
}

/** The USDC the owner sends from their wallet to the vault, in units: any amount above zero. */
export function parseFundAmount(amount: string): ParsedAmount {
  const r = parse(amount);
  if ("problem" in r) return r;
  return BigInt(r.units) <= 0n ? { problem: "Must be above 0" } : r;
}
