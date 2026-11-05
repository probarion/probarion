import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../test/db/harness";
import { pgliteDb } from "../../../test/db/pglite-db";
import { CANARY_LIMITS, claimRawSlot, estimateTokens, tokensToday } from "./limits";

const H = (c: string) => c.repeat(64);

describe("CANARY_LIMITS", () => {
  it("states the spec's abuse controls", () => {
    expect(CANARY_LIMITS).toEqual({
      maxTextChars: 4000,
      rawVisitorWindowS: 600,
      rawGlobalPerHour: 30,
      minAllowanceYocto: 200_000_000_000_000_000_000_000n,
      dailyTokenBudget: 2_000_000,
      promptOverheadTokens: 900,
      leaseSeconds: 90,
    });
  });

  it("estimates a quarter of the characters, rounded up, plus the prompt overhead", () => {
    expect(estimateTokens("")).toBe(900);
    expect(estimateTokens("abcd")).toBe(901);
    expect(estimateTokens("abcde")).toBe(902);
    expect(estimateTokens("x".repeat(4000))).toBe(1900);
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
