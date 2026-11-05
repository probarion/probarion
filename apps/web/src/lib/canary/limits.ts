import { PROPOSAL_MAX_TOKENS } from "@probarion/core";
import type { Db } from "@/lib/db/port";
import { takeToken } from "@/lib/ratelimit";

/** Spec §14.3 and §21 abuse controls. The model's own request limits (per IP, global) are `LIMITS.canaryModel*`. */
export const CANARY_LIMITS = {
  maxTextChars: 4000,
  rawVisitorWindowS: 600, // 1 on-chain attempt per visitor every 10 minutes
  rawGlobalPerHour: 30, // at most 30 per hour in total
  minAllowanceYocto: 200_000_000_000_000_000_000_000n, // 0.2 NEAR: below it raw mode stops (the agent key's gas)
  /**
   * 0.5 NEAR: below it the Canary does not run at all (the LEDGER key's allowance). Every attempt anchors its ledger
   * on chain with that key, and when its allowance runs out the SDK swallows the failure: the anchors, and with them
   * the Canary's proof, would go stale without a word.
   */
  minLedgerAllowanceYocto: 500_000_000_000_000_000_000_000n,
  /**
   * Attempts that reach the model, in total: each one writes ledger entries and sends an anchor transaction, so
   * anonymous traffic sets the gas burn and the ledger's growth. These sit well below the model limiter
   * (`LIMITS.canaryModelGlobal`, 300 an hour).
   */
  attemptsGlobalPerHour: 60,
  attemptsGlobalPerDay: 600,
  /**
   * When the Canary's ledger holds this many entries the Canary is closed. The SDK reads the whole ledger several
   * times per attempt, so a ledger that grows without bound makes each attempt dearer than the last. The ledger stays
   * readable by the owner; the OWNER starts a new Canary vault before go-live traffic.
   */
  maxLedgerEntries: 2000,
  dailyTokenBudget: 2_000_000, // model tokens per UTC day across all attempts
  /** The system prompt, the facts and the mandate view the model is shown, with room to spare (NOT the output cap). */
  promptOverheadTokens: 900,
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
  | "global_limit"
  /** The contract's free dry run would accept (or hold) the spend: it is never sent, so nothing is paid. */
  | "contract_would_accept"
  /** The dry run could not be read: the spend is not sent. */
  | "check_failed"
  /** Neither the model nor the code gave an amount that can be sent. */
  | "no_amount"
  /** The decision the code wrote could not be read from the ledger, so there is no proposal to send. */
  | "decision_unreadable"
  /** The SDK itself refused the raw spend by code, before the chain. */
  | "sdk_refused"
  /** An error that certainly sent nothing (a bad input, no ledger, no node), or a counter that could not be read. */
  | "error";

/**
 * What an attempt is charged when the model reports no usage: half a token per character (a non-Latin text costs far
 * more than the quarter an English one does), the prompt and mandate view, and the LONGEST answer it may give.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2) + CANARY_LIMITS.promptOverheadTokens + PROPOSAL_MAX_TOKENS;
}

/** Seconds from `now` to the end of its UTC day, at least 1: when the daily budget is spent, when to come back. */
export function secondsUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
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

/** Seconds until a fixed window is over (at least 1; the whole window if the database's time is unreadable). */
function retryAfter(resetAt: string, windowS: number): number {
  const ms = Date.parse(resetAt) - Date.now();
  return Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 1000)) : windowS;
}

/**
 * One attempt out of the Canary's global caps (60 an hour and 600 a day), taken atomically before the model is called.
 * Over either: `ok: false` with the seconds until that window is over. A refusal by the hour takes nothing from the day.
 */
export async function takeAttemptSlot(
  db: Db,
): Promise<{ ok: true } | { ok: false; retryAfterS: number }> {
  const hour = await takeToken(
    db,
    "canary:attempts:hour",
    CANARY_LIMITS.attemptsGlobalPerHour,
    3600,
  );
  if (!hour.allowed) return { ok: false, retryAfterS: retryAfter(hour.reset_at, 3600) };
  const day = await takeToken(
    db,
    "canary:attempts:day",
    CANARY_LIMITS.attemptsGlobalPerDay,
    86_400,
  );
  if (!day.allowed) return { ok: false, retryAfterS: retryAfter(day.reset_at, 86_400) };
  return { ok: true };
}

/** Model tokens used so far in the UTC day of `now`, across all attempts (what the model reported, else the estimate). */
export async function tokensToday(db: Db, now: Date): Promise<number> {
  return Number(await db.rpc<number>("canary_tokens_today", { now: now.toISOString() }));
}
