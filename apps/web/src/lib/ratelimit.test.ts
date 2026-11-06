import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codeOnly, isSourceFile, isTestFile, walk } from "../../test/deploy-scan";
import { NONCE_BURN_WINDOW_SECONDS } from "./auth/challenge";
import {
  ATTEMPT_DAY_WINDOW_S,
  ATTEMPT_HOUR_WINDOW_S,
  CANARY_LIMITS,
  RAW_GLOBAL_WINDOW_S,
} from "./canary/limits";
import { LIMITS, RATE_LIMIT_KEEP_S } from "./ratelimit";

// The daily cron prunes `rate_limits` (migration 0009, rate_limits_prune): it deletes every row whose window started
// more than RATE_LIMIT_KEEP_S ago. That is safe only while no window the app asks for is longer than that: a row older
// than a day then belongs to a window that is over, and deleting it cannot give anyone a window back. These tests read
// every window from the constants the calls use.

const WEB = fileURLToPath(new URL("../..", import.meta.url));
const DAY_S = 86_400;

const windowsOf = (limits: Record<string, readonly [number, number]>) =>
  Object.entries(limits).map(([name, [, windowS]]) => [name, windowS] as const);

describe("how long the prune keeps a row", () => {
  it("is a day, and the SQL of the prune says the same day", () => {
    expect(RATE_LIMIT_KEEP_S).toBe(DAY_S);
    const sql = readFileSync(
      join(WEB, "supabase", "migrations", "20261108000009_metrics.sql"),
      "utf8",
    );
    const prune = /create or replace function public\.rate_limits_prune[\s\S]*?end \$\$;/.exec(sql);
    expect(prune, "rate_limits_prune in the migration").not.toBeNull();
    expect(prune?.[0]).toContain("window_start < now() - interval '1 day'");
  });
});

describe("every rate-limit window is at most a day, so the prune cannot reopen a live window", () => {
  it("covers every window of LIMITS", () => {
    const all = windowsOf(LIMITS);
    expect(all.length).toBeGreaterThan(10);
    for (const [name, windowS] of all) {
      expect(Number.isInteger(windowS) && windowS > 0, name).toBe(true);
      expect(windowS, name).toBeLessThanOrEqual(RATE_LIMIT_KEEP_S);
    }
  });

  it("keeps the per-address confirmation window at exactly the longest a window may be, a day", () => {
    expect(LIMITS.alertConfirmAddress).toEqual([3, RATE_LIMIT_KEEP_S]);
  });

  it("covers the Canary's windows in limits.ts", () => {
    const canary = {
      rawVisitorWindowS: CANARY_LIMITS.rawVisitorWindowS,
      RAW_GLOBAL_WINDOW_S,
      ATTEMPT_HOUR_WINDOW_S,
      ATTEMPT_DAY_WINDOW_S,
    };
    for (const [name, windowS] of Object.entries(canary)) {
      expect(Number.isInteger(windowS) && windowS > 0, name).toBe(true);
      expect(windowS, name).toBeLessThanOrEqual(RATE_LIMIT_KEEP_S);
    }
    // The day's limit is the longest one, and it is exactly the day the prune keeps.
    expect(ATTEMPT_DAY_WINDOW_S).toBe(DAY_S);
  });

  it("covers the nonce burn of the sign-in", () => {
    expect(NONCE_BURN_WINDOW_SECONDS).toBeGreaterThan(0);
    expect(NONCE_BURN_WINDOW_SECONDS).toBeLessThanOrEqual(RATE_LIMIT_KEEP_S);
  });
});

/** The arguments of each call of `name(...)` in `src`, split at the commas that are not inside a bracket. */
function callArgs(src: string, name: string): string[][] {
  const code = codeOnly(src);
  const calls: string[][] = [];
  for (let at = code.indexOf(`${name}(`); at !== -1; at = code.indexOf(`${name}(`, at + 1)) {
    // A definition (`function name(`) or a property (`.name(`) is not a call.
    if (/function\s+$/.test(code.slice(0, at)) || code.charAt(at - 1) === ".") continue;
    const args: string[] = [];
    let depth = 0;
    let arg = "";
    for (let i = at + name.length + 1; i < code.length; i++) {
      const c = code.charAt(i);
      if (c === "(" || c === "[" || c === "{") depth++;
      if ((c === ")" || c === "]" || c === "}") && depth-- === 0) break;
      if (c === "," && depth === 0) {
        args.push(arg.trim());
        arg = "";
      } else {
        arg += c;
      }
    }
    if (arg.trim() !== "") args.push(arg.trim());
    calls.push(args);
  }
  return calls;
}

describe("every call takes its window from a constant the tests above read", () => {
  // A window that is only a literal inside a call, or a name nobody lists, cannot be read by the tests above. So a call
  // names its window with one of these, and a new one is added here when it is added to the constants.
  const WINDOW_NAMES = [
    "windowSeconds", // the limiter's own pass-through, and the proof page's [max, windowSeconds] of LIMITS.proofPage
    "window", // claimRawSlot: CANARY_LIMITS.rawVisitorWindowS
    "NONCE_BURN_WINDOW_SECONDS",
    "RAW_GLOBAL_WINDOW_S",
    "ATTEMPT_HOUR_WINDOW_S",
    "ATTEMPT_DAY_WINDOW_S",
  ];
  const sources = walk(join(WEB, "src"))
    .filter((f) => isSourceFile(f) && !isTestFile(f))
    .map((f) => ({ f: f.slice(WEB.length), src: readFileSync(f, "utf8") }));
  const takes = sources.flatMap((s) => callArgs(s.src, "takeToken").map((a) => ({ f: s.f, a })));
  const caps = sources.flatMap((s) =>
    callArgs(s.src, "rateLimitOr429").map((a) => ({ f: s.f, a })),
  );

  it("finds the calls it checks", () => {
    expect(takes.length).toBeGreaterThan(5);
    expect(caps.length).toBeGreaterThan(8);
    expect(takes.every(({ a }) => a.length === 4)).toBe(true);
    expect(caps.every(({ a }) => a.length === 3)).toBe(true);
  });

  it("takeToken(db, bucket, max, window): the window is one of those names, never a number", () => {
    const other = takes.filter(({ a }) => !WINDOW_NAMES.includes(a[3] ?? ""));
    expect(other.map(({ f, a }) => `${f}: ${a.join(", ")}`)).toEqual([]);
  });

  it("rateLimitOr429(db, bucket, limit): the limit is LIMITS.<name>, never a pair written in the call", () => {
    const other = caps.filter(({ a }) => !/^(LIMITS\.[A-Za-z]+|limit)$/.test(a[2] ?? ""));
    expect(other.map(({ f, a }) => `${f}: ${a.join(", ")}`)).toEqual([]);
  });

  it("states the limits that a route builds from a table in LIMITS too", () => {
    // topup/gate.ts passes `limit` from its BUCKETS table: every entry of it is a LIMITS entry.
    const gate = readFileSync(join(WEB, "src", "lib", "topup", "gate.ts"), "utf8");
    const entries = [...gate.matchAll(/=> \[[^\]]*, (\S+)\] as const/g)].map((m) => m[1]);
    expect(entries.length).toBe(3);
    expect(entries.filter((e) => !(e ?? "").startsWith("LIMITS."))).toEqual([]);
  });
});
