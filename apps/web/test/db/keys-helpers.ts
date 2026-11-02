import { afterEach, beforeEach, expect, vi } from "vitest";
import { parseMasterKey } from "@/lib/crypto/sodium";

// Shared by the Task 10 key tests. Masters are built at run time (no high-entropy literal in the repo:
// gitleaks scans history).
export const MASTER = parseMasterKey(Buffer.alloc(32, 5).toString("base64"));
export const NEW_MASTER = parseMasterKey(Buffer.alloc(32, 6).toString("base64"));
export const LOST_MASTER = parseMasterKey(Buffer.alloc(32, 7).toString("base64"));

/** Element `i`, or a failed test (never an `undefined` that a later check would wave through). */
export function at<T>(rows: readonly T[], i = 0): T {
  const row = rows[i];
  if (row === undefined) throw new Error(`expected a row at ${i}, got ${rows.length} row(s)`);
  return row;
}

/** The secret's base58 body, and a 30-character slice of it, appear nowhere in `text`. */
export function expectNoSecret(text: string, secret: string): void {
  const body = secret.slice("ed25519:".length);
  expect(body.length).toBeGreaterThan(60);
  expect(text).not.toContain(body);
  expect(text).not.toContain(body.slice(10, 40));
}

/**
 * Keeps test output quiet: every console method is spied for each test and its lines collected in
 * `lines` (cleared before each test), so a test can still check what was logged. Call it once at the
 * top of a file or describe block.
 */
export function silenceLogs(): { lines: string[] } {
  const box = { lines: [] as string[] };
  beforeEach(() => {
    box.lines.length = 0;
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        box.lines.push(args.map(String).join(" "));
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  return box;
}
