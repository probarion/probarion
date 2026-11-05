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
      maxLedgerEntries: 2000,
      dailyTokenBudget: 2_000_000,
      promptOverheadTokens: 900,
      leaseSeconds: 90,
    });
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
    expect(await takeAttemptSlot(db())).toEqual({ ok: true });
    expect(await count("canary:attempts:hour")).toBe(1);
    expect(await count("canary:attempts:day")).toBe(1);
    await pg.query("update rate_limits set count = 60 where bucket = 'canary:attempts:hour'");
    const full = await takeAttemptSlot(db());
    expect(full.ok).toBe(false);
    if (!full.ok) {
      expect(full.retryAfterS).toBeGreaterThan(3590);
      expect(full.retryAfterS).toBeLessThanOrEqual(3600);
    }
    // a refusal by the hour does not touch the day
    expect(await count("canary:attempts:day")).toBe(1);
    await pg.query("update rate_limits set count = 5 where bucket = 'canary:attempts:hour'");
    await pg.query("update rate_limits set count = 600 where bucket = 'canary:attempts:day'");
    const day = await takeAttemptSlot(db());
    expect(day.ok).toBe(false);
    if (!day.ok) expect(day.retryAfterS).toBeGreaterThan(86_300);
    // a window that is over starts again
    await pg.query(
      "update rate_limits set window_start = now() - interval '3601 seconds' where bucket = 'canary:attempts:hour'",
    );
    await pg.query(
      "update rate_limits set window_start = now() - interval '86401 seconds' where bucket = 'canary:attempts:day'",
    );
    expect(await takeAttemptSlot(db())).toEqual({ ok: true });
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
      est_tokens: 1234,
    });
    expect(await tokensToday(db(), new Date())).toBe(1234);
    expect(await tokensToday(db(), new Date(Date.now() + 2 * 86_400_000))).toBe(0);
  });
});
