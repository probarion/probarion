// The chain state one decision is made from, and the mirrors of the contract's views that `decide()` needs.
// The contract is authoritative: these only let the code refuse early what `check_spend` would refuse anyway.
import type { MandateView, SpendStatus, SpendView, VaultConfig } from "@probarion/core";

export interface ChainContext {
  config: VaultConfig;
  mandates: MandateView[];
  spends: SpendView[];
}

/** Spends that hold their invoice and count toward the daily backstop (a release gives both back). */
const LIVE: ReadonlySet<SpendStatus> = new Set(["held", "pending", "paid", "burned"]);
const NS_PER_DAY = 86_400_000_000_000n;
const NS_PER_MS = 1_000_000n;

/**
 * Mirror of the contract's daily backstop window (checks.rs:63): the total of live spends created on the
 * UTC day of `now` (bucket `created_at_ns / DAY_NS`). The contract is authoritative.
 */
export function spentToday(spends: readonly SpendView[], now: Date): string {
  const today = (BigInt(now.getTime()) * NS_PER_MS) / NS_PER_DAY;
  let total = 0n;
  for (const spend of spends) {
    if (LIVE.has(spend.status) && BigInt(spend.created_at_ns) / NS_PER_DAY === today) {
      total += BigInt(spend.amount);
    }
  }
  return total.toString();
}

/** Invoice hashes that are paid, held or in flight. Released spends (failed, rejected, expired) free their invoice. */
export function liveInvoiceHashes(spends: readonly SpendView[]): Set<string> {
  return new Set(spends.filter((s) => LIVE.has(s.status)).map((s) => s.invoice_hash));
}

/** Every ref ever used on the vault: refs are unique per vault and a released spend keeps its ref. */
export function usedRefs(spends: readonly SpendView[]): Set<string> {
  return new Set(spends.map((s) => s.ref));
}
