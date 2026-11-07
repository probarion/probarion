import type { MandateView } from "@probarion/core";
import { usdcFromUnits } from "./format";

/** What the page read from the chain. A null is a read that failed: it is never shown as a zero. */
export interface VaultReads {
  usdc: string | null;
  /** The vault's Base USDC balance inside Intents. */
  base: string | null;
  mandates: MandateView[] | null;
}

export type MandateLine =
  | { kind: "unreadable" }
  | { kind: "none" }
  | {
      kind: "active";
      /** How many mandates are active. The line is about the first. */
      count: number;
      payee: string;
      maxPerPayment: string;
      holdsEverySpend: boolean;
    };

export interface VaultSummary {
  /** USDC in whole units, or null when unreadable. */
  balance: string | null;
  /** Shown only when it was read and is above zero. */
  base: string | null;
  mandate: MandateLine;
}

const usdc = usdcFromUnits;

const payeeOf = (m: MandateView): string =>
  m.payee.type === "near" ? m.payee.account_id : `${m.payee.chain}:${m.payee.address}`;

function mandateLine(mandates: MandateView[] | null): MandateLine {
  if (mandates === null) return { kind: "unreadable" };
  const active = mandates.filter((m) => m.status === "active");
  const first = active[0];
  if (first === undefined) return { kind: "none" };
  const max = usdc(first.max_per_payment);
  if (max === null) return { kind: "unreadable" };
  return {
    kind: "active",
    count: active.length,
    payee: payeeOf(first),
    maxPerPayment: max,
    // approval_above is the amount past which a person must approve: at 0, every spend waits for one.
    holdsEverySpend: first.approval_above === "0",
  };
}

export function summarizeVault(reads: VaultReads): VaultSummary {
  const base = usdc(reads.base);
  return {
    balance: usdc(reads.usdc),
    base: base !== null && BigInt(reads.base ?? "0") > 0n ? base : null,
    mandate: mandateLine(reads.mandates),
  };
}
