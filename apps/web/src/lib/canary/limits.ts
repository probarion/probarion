import type { Db } from "@/lib/db/port";
import { takeToken } from "@/lib/ratelimit";

/** Spec §14.3 and §21 abuse controls. The model's own request limits (per IP, global) are `LIMITS.canaryModel*`. */
export const CANARY_LIMITS = {
  maxTextChars: 4000,
  rawVisitorWindowS: 600, // 1 on-chain attempt per visitor every 10 minutes
  rawGlobalPerHour: 30, // at most 30 per hour in total
  minAllowanceYocto: 200_000_000_000_000_000_000_000n, // 0.2 NEAR
  dailyTokenBudget: 2_000_000, // model tokens per UTC day across all attempts
  promptOverheadTokens: 900, // system prompt + output cap, used when the SDK reports no usage
  /**
   * How long one attempt holds the Canary tenant's `process` lease: the same 90 s as Payables' PROCESS_LEASE_SECONDS,
   * and it must outlast the route's `maxDuration` (60 s) with a margin. route.test.ts checks both.
   */
  leaseSeconds: 90,
} as const;

export type RawSkip =
  | "mode"
  | "not_refused_by_code"
  | "not_pay"
  | "allowance_low"
  | "visitor_limit"
  | "global_limit";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + CANARY_LIMITS.promptOverheadTokens;
}

/** Atomic fixed-window counters: the IP hash and the cookie each get 1 per 10 min; then the global 30/h. */
export async function claimRawSlot(
  db: Db,
  v: { ipHash: string; visitorHash: string },
): Promise<RawSkip | null> {
  const window = CANARY_LIMITS.rawVisitorWindowS;
  if (!(await takeToken(db, `canary:raw:ip:${v.ipHash}`, 1, window)).allowed) {
    return "visitor_limit";
  }
  if (!(await takeToken(db, `canary:raw:cookie:${v.visitorHash}`, 1, window)).allowed) {
    return "visitor_limit";
  }
  if (!(await takeToken(db, "canary:raw:global", CANARY_LIMITS.rawGlobalPerHour, 3600)).allowed) {
    return "global_limit";
  }
  return null;
}

/** Model tokens used so far in the UTC day of `now`, across all attempts (what the model reported, else the estimate). */
export async function tokensToday(db: Db, now: Date): Promise<number> {
  return Number(await db.rpc<number>("canary_tokens_today", { now: now.toISOString() }));
}
