import { afterAll, beforeAll, beforeEach, type MockInstance, vi } from "vitest";

/**
 * Keeps a test file quiet from its very first hook: every console method is spied in a `beforeAll` (so the lines
 * logged while a `beforeAll` seeds keys or tenants are caught too) and restored after the last test. `lines`
 * holds what the current test logged (cleared before each test). Call it before any other `beforeAll` of the
 * file, or at its top level.
 */
export function quietLogs(): { lines: string[] } {
  const box = { lines: [] as string[] };
  const spies: MockInstance[] = [];
  beforeAll(() => {
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
          box.lines.push(args.map(String).join(" "));
        }),
      );
    }
  });
  beforeEach(() => {
    box.lines.length = 0;
  });
  afterAll(() => {
    for (const s of spies) s.mockRestore();
  });
  return box;
}
