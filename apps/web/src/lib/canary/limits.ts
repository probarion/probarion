import { PROPOSAL_MAX_TOKENS } from "@probarion/core";
import type { Db } from "@/lib/db/port";
import { takeToken } from "@/lib/ratelimit";

/** Window lengths of the Canary's limiters, in seconds. None is over a day (ratelimit.test.ts): the daily cron prunes older rows. */
export const RAW_GLOBAL_WINDOW_S = 3600;
export const ATTEMPT_HOUR_WINDOW_S = 3600;
export const ATTEMPT_DAY_WINDOW_S = 86_400;

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
   * One address's share of those 60: two addresses could otherwise use the whole hour (the model limiter lets one address
   * make 30 attempts an hour) and keep every other visitor out. Taken before the global slots, so an address's overflow
   * never spends one. An IPv6 address counts by its /64 (`clientIp`), so rotating the low 64 bits changes nothing.
   */
  attemptsPerIpPerHour: 6,
  /**
   * When the Canary's ledger holds this many entries the Canary is closed. The ceiling is sized by COST, not by count: the
   * SDK reads the whole ledger on every attempt (2 to 4 times: before the decision, before a raw spend, before each anchor),
   * and an entry that carries attestation evidence and the model's full response is about 12 KB. 300 entries are about
   * 3.6 MB per read, so a few MB to 15 MB moved from the database per attempt; at 2,000 entries it would be 24 MB a read
   * and filling the ledger would read tens of GB. The ledger stays readable by the owner, and the OWNER starts a new
   * Canary vault when this one closes. A tail-only read in the SDK would lift the ceiling: parked until traffic beyond the
   * hackathon demo.
   */
  maxLedgerEntries: 300,
  dailyTokenBudget: 2_000_000, // model tokens per UTC day across all attempts
  /** The system prompt, the facts and the mandate view the model is shown, with room to spare (NOT the output cap). */
  promptOverheadTokens: 900,
  /**
   * How long one attempt holds the Canary tenant's `process` lease: the same 90 s as Payables' PROCESS_LEASE_SECONDS,
   * and it must outlast the route's `maxDuration` (60 s) with a margin. route.test.ts checks both.
   */
  leaseSeconds: 90,
  /**
   * One attempt, from the route's start (not from the first model call): the platform stops the function at 60 s, and these
   * 10 s are what is left to close the row and answer. Every phase gets the smaller of its own cap and the time left, and
   * the whole attempt is cut off at this deadline.
   */
  attemptBudgetMs: 50_000,
  /** ALL the model calls of one attempt (the catalog, the probe, the attestation report, the chat, the signature reads) share this. */
  modelBudgetMs: 30_000,
  /** One step on the chain (a read, signing, a send, a lookup), capped by the time left. */
  chainStepTimeoutMs: 8000,
  /** A raw spend is not started with less than this left: the dry run, the send and its row need the time. */
  rawMinRemainingMs: 15_000,
  /** How long a process keeps the model its first attempt resolved (the catalog and the probe do not change that fast). */
  modelCacheMs: 600_000,
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
  /** Less than `rawMinRemainingMs` of the attempt's time was left, or the time ran out before the spend could be asked about. */
  | "no_time"
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
  if (
    !(await takeToken(db, "canary:raw:global", CANARY_LIMITS.rawGlobalPerHour, RAW_GLOBAL_WINDOW_S))
      .allowed
  ) {
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
 * One attempt out of the Canary's caps, taken atomically before the model is called: the address's own 6 an hour first,
 * then the global 60 an hour and 600 a day. Over any: `ok: false` with the seconds until that window is over. A refusal
 * by the address takes nothing from the global slots, and one by the hour nothing from the day.
 */
export async function takeAttemptSlot(
  db: Db,
  ipHash: string,
): Promise<{ ok: true } | { ok: false; retryAfterS: number }> {
  const mine = await takeToken(
    db,
    `canary:attempts:ip:${ipHash}`,
    CANARY_LIMITS.attemptsPerIpPerHour,
    ATTEMPT_HOUR_WINDOW_S,
  );
  if (!mine.allowed)
    return { ok: false, retryAfterS: retryAfter(mine.reset_at, ATTEMPT_HOUR_WINDOW_S) };
  const hour = await takeToken(
    db,
    "canary:attempts:hour",
    CANARY_LIMITS.attemptsGlobalPerHour,
    ATTEMPT_HOUR_WINDOW_S,
  );
  if (!hour.allowed)
    return { ok: false, retryAfterS: retryAfter(hour.reset_at, ATTEMPT_HOUR_WINDOW_S) };
  const day = await takeToken(
    db,
    "canary:attempts:day",
    CANARY_LIMITS.attemptsGlobalPerDay,
    ATTEMPT_DAY_WINDOW_S,
  );
  if (!day.allowed)
    return { ok: false, retryAfterS: retryAfter(day.reset_at, ATTEMPT_DAY_WINDOW_S) };
  return { ok: true };
}

/** Model tokens used so far in the UTC day of `now`, across all attempts (what the model reported, else the estimate). */
export async function tokensToday(db: Db, now: Date): Promise<number> {
  return Number(await db.rpc<number>("canary_tokens_today", { now: now.toISOString() }));
}
