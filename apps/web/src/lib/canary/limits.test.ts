import type { PGlite } from "@electric-sql/pglite";
import { PROPOSAL_MAX_TOKENS } from "@probarion/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../test/db/harness";
import { pgliteDb } from "../../../test/db/pglite-db";
import {
  CANARY_LIMITS,
  claimRawSlot,
  estimateTokens,
  secondsUntilUtcMidnight,
  takeAttemptSlot,
  tokensToday,
} from "./limits";

const H = (c: string) => c.repeat(64);

describe("CANARY_LIMITS", () => {
  it("states the spec's abuse controls", () => {
    expect(CANARY_LIMITS).toEqual({
      maxTextChars: 4000,
      rawVisitorWindowS: 600,
      rawGlobalPerHour: 30,
      minAllowanceYocto: 200_000_000_000_000_000_000_000n,
      minLedgerAllowanceYocto: 500_000_000_000_000_000_000_000n,
      attemptsGlobalPerHour: 60,
      attemptsGlobalPerDay: 600,
      attemptsPerIpPerHour: 6,
      maxLedgerEntries: 300,
      dailyTokenBudget: 2_000_000,
      promptOverheadTokens: 900,
      leaseSeconds: 130,
      attemptBudgetMs: 80_000,
      modelBudgetMs: 40_000,
      chainStepTimeoutMs: 8000,
      rawMinRemainingMs: 15_000,
      modelCacheMs: 600_000,
    });
  });

  // The ledger ceiling bounds what an attempt COSTS, not only how many entries there are: an attempt reads the whole
  // ledger 2 to 4 times, and an entry with its attestation evidence and the model's full response is about 12 KB, so 300
  // entries are about 3.6 MB a read, a few MB to 15 MB an attempt.
  it("keeps the ledger ceiling at the size whose reads stay cheap, and the deadline inside the platform's", () => {
    expect(CANARY_LIMITS.maxLedgerEntries * 12_000).toBeLessThanOrEqual(3_600_000);
    // 10 s of the route's 90 s are left to close the row and answer (route.test.ts holds it to maxDuration)
    expect(CANARY_LIMITS.attemptBudgetMs).toBeLessThanOrEqual(80_000);
    // the budgets nest: the model and the raw step each get less than the whole attempt, a chain step less than the raw step
    expect(CANARY_LIMITS.modelBudgetMs).toBeLessThan(CANARY_LIMITS.attemptBudgetMs);
    expect(CANARY_LIMITS.rawMinRemainingMs).toBeLessThan(CANARY_LIMITS.attemptBudgetMs);
    expect(CANARY_LIMITS.chainStepTimeoutMs).toBeLessThan(CANARY_LIMITS.rawMinRemainingMs);
  });

  // Production, 2026-11-10: about 10 s went by before the first model call and a slow private model took most of its 30 s,
  // so the raw step found less than its 15 s and sent nothing (no_time); a chat that times out decides rules-only and gives
  // not_pay instead. A model that uses its whole budget must still leave the raw step its floor where the spend starts:
  // service.ts checks the floor at the raw gate and again just before the send, and the gate's own steps come between.
  it("leaves the raw step its floor after a model that uses its whole budget", () => {
    // the time before the model, and the decision's write and anchor after it
    const aroundModelMs = 20_000;
    // the agent-key read, the dry run, the limiter's calls and the pending row, before the second floor check (service.ts)
    const gateMs = 5_000;
    expect(
      aroundModelMs + CANARY_LIMITS.modelBudgetMs + gateMs + CANARY_LIMITS.rawMinRemainingMs,
    ).toBeLessThanOrEqual(CANARY_LIMITS.attemptBudgetMs);
  });

  // Unknown usage is charged at the worst case: half a token per character (non-Latin text), the system prompt and the
  // mandates the model is shown, and the longest answer it may give (PROPOSAL_MAX_TOKENS, 4096).
  it("estimates half the characters, rounded up, plus the prompt overhead and the longest answer", () => {
    expect(estimateTokens("")).toBe(900 + PROPOSAL_MAX_TOKENS);
    expect(estimateTokens("a")).toBe(1 + 900 + PROPOSAL_MAX_TOKENS);
    expect(estimateTokens("abc")).toBe(2 + 900 + PROPOSAL_MAX_TOKENS);
    expect(estimateTokens("x".repeat(4000))).toBe(2000 + 900 + PROPOSAL_MAX_TOKENS);
    expect(PROPOSAL_MAX_TOKENS).toBe(4096);
  });
});

describe("secondsUntilUtcMidnight", () => {
  it("counts to the end of the UTC day, at least one second", () => {
    expect(secondsUntilUtcMidnight(new Date("2026-11-09T22:00:00Z"))).toBe(7200);
    expect(secondsUntilUtcMidnight(new Date("2026-11-09T00:00:00Z"))).toBe(86_400);
    expect(secondsUntilUtcMidnight(new Date("2026-11-09T23:59:59.500Z"))).toBe(1);
    expect(secondsUntilUtcMidnight(new Date("2026-11-09T23:59:59Z"))).toBe(1);
  });
});

describe("claimRawSlot and tokensToday", () => {
  let pg: PGlite;
  const db = () => pgliteDb(pg);
  const count = async (bucket: string) =>
    (await pg.query<{ count: number }>("select count from rate_limits where bucket = $1", [bucket]))
      .rows[0]?.count;

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await pg.exec("truncate public.rate_limits; truncate public.canary_attempts");
  });

  it("gives one slot per IP hash and one per cookie hash, each for ten minutes", async () => {
    expect(await claimRawSlot(db(), { ipHash: H("1"), visitorHash: H("a") })).toBeNull();
    // the same IP with another cookie: the IP is spent, and the new cookie is not touched
    expect(await claimRawSlot(db(), { ipHash: H("1"), visitorHash: H("b") })).toBe("visitor_limit");
    // the same cookie from another IP: the cookie is spent
    expect(await claimRawSlot(db(), { ipHash: H("2"), visitorHash: H("a") })).toBe("visitor_limit");
    expect(await claimRawSlot(db(), { ipHash: H("3"), visitorHash: H("b") })).toBeNull();
    // the buckets are the IP's and the cookie's own; a refused hit counts and is not refunded
    expect(await count(`canary:raw:ip:${H("1")}`)).toBe(2);
    expect(await count(`canary:raw:cookie:${H("a")}`)).toBe(2);
    expect(await claimRawSlot(db(), { ipHash: H("2"), visitorHash: H("c") })).toBe("visitor_limit");
    // the window is ten minutes from the first hit
    await pg.query(
      "update rate_limits set window_start = now() - interval '601 seconds' where bucket = $1",
      [`canary:raw:ip:${H("1")}`],
    );
    await pg.query(
      "update rate_limits set window_start = now() - interval '599 seconds' where bucket = $1",
      [`canary:raw:cookie:${H("a")}`],
    );
    expect(await claimRawSlot(db(), { ipHash: H("1"), visitorHash: H("d") })).toBeNull();
    expect(await claimRawSlot(db(), { ipHash: H("4"), visitorHash: H("a") })).toBe("visitor_limit");
  });

  it("takes a global slot only for a visitor who passed both visitor limits", async () => {
    await claimRawSlot(db(), { ipHash: H("1"), visitorHash: H("a") });
    await claimRawSlot(db(), { ipHash: H("1"), visitorHash: H("b") });
    await claimRawSlot(db(), { ipHash: H("2"), visitorHash: H("a") });
    expect(await count("canary:raw:global")).toBe(1);
  });

  it("allows 30 an hour in total and refuses the 31st", async () => {
    for (let i = 0; i < 30; i += 1) {
      const who = {
        ipHash: `1${i.toString(16).padStart(63, "0")}`,
        visitorHash: `2${i.toString(16).padStart(63, "0")}`,
      };
      expect(await claimRawSlot(db(), who), String(i)).toBeNull();
    }
    expect(await claimRawSlot(db(), { ipHash: H("e"), visitorHash: H("f") })).toBe("global_limit");
    await pg.query(
      "update rate_limits set window_start = now() - interval '3601 seconds' where bucket = 'canary:raw:global'",
    );
    expect(await claimRawSlot(db(), { ipHash: H("d"), visitorHash: H("c") })).toBeNull();
  });

  it("takes an attempt slot from the hour and the day, and says when to come back when either is full", async () => {
    expect(await takeAttemptSlot(db(), H("1"))).toEqual({ ok: true });
    expect(await count("canary:attempts:hour")).toBe(1);
    expect(await count("canary:attempts:day")).toBe(1);
    await pg.query("update rate_limits set count = 60 where bucket = 'canary:attempts:hour'");
    const full = await takeAttemptSlot(db(), H("1"));
    expect(full.ok).toBe(false);
    if (!full.ok) {
      expect(full.retryAfterS).toBeGreaterThan(3590);
      expect(full.retryAfterS).toBeLessThanOrEqual(3600);
    }
    // a refusal by the hour does not touch the day
    expect(await count("canary:attempts:day")).toBe(1);
    await pg.query("update rate_limits set count = 5 where bucket = 'canary:attempts:hour'");
    await pg.query("update rate_limits set count = 600 where bucket = 'canary:attempts:day'");
    const day = await takeAttemptSlot(db(), H("1"));
    expect(day.ok).toBe(false);
    if (!day.ok) expect(day.retryAfterS).toBeGreaterThan(86_300);
    // a window that is over starts again
    await pg.query(
      "update rate_limits set window_start = now() - interval '3601 seconds' where bucket = 'canary:attempts:hour'",
    );
    await pg.query(
      "update rate_limits set window_start = now() - interval '86401 seconds' where bucket = 'canary:attempts:day'",
    );
    expect(await takeAttemptSlot(db(), H("1"))).toEqual({ ok: true });
  });

  it("gives each address 6 attempts an hour of the cap, taken before the global slots", async () => {
    for (let i = 1; i <= 6; i += 1) {
      expect(await takeAttemptSlot(db(), H("a")), String(i)).toEqual({ ok: true });
    }
    const hourBefore = await count("canary:attempts:hour");
    const over = await takeAttemptSlot(db(), H("a"));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.retryAfterS).toBeGreaterThan(3590);
      expect(over.retryAfterS).toBeLessThanOrEqual(3600);
    }
    // one address's overflow never spends a global slot
    expect(await count("canary:attempts:hour")).toBe(hourBefore);
    expect(await count("canary:attempts:day")).toBe(hourBefore);
    // another address is not affected, and the bucket is the address's own
    expect(await takeAttemptSlot(db(), H("b"))).toEqual({ ok: true });
    expect(await count(`canary:attempts:ip:${H("a")}`)).toBe(7);
    expect(await count(`canary:attempts:ip:${H("b")}`)).toBe(1);
    // the window is an hour from the first attempt
    await pg.query(
      "update rate_limits set window_start = now() - interval '3601 seconds' where bucket = $1",
      [`canary:attempts:ip:${H("a")}`],
    );
    expect(await takeAttemptSlot(db(), H("a"))).toEqual({ ok: true });
  });

  it("lets two addresses use their own share and still leave the rest of the cap for everyone else", async () => {
    for (const ip of ["a", "b"]) {
      for (let i = 0; i < 6; i += 1) await takeAttemptSlot(db(), H(ip));
    }
    // 12 of 60 are taken: a third visitor is not locked out
    expect(await takeAttemptSlot(db(), H("c"))).toEqual({ ok: true });
    expect(await count("canary:attempts:hour")).toBe(13);
  });

  it("sums the day's model tokens as a number", async () => {
    expect(await tokensToday(db(), new Date())).toBe(0);
    await db().rpc("canary_attempt_insert", {
      visitor_hash: H("1"),
      ip_hash: H("2"),
      mode: "live",
      text_sha256: H("3"),
      text_length: 5,
      code_status: "refused_by_code",
      request_id: "r",
      network: "mainnet",
      est_tokens: 1234,
    });
    expect(await tokensToday(db(), new Date())).toBe(1234);
    expect(await tokensToday(db(), new Date(Date.now() + 2 * 86_400_000))).toBe(0);
  });
});
