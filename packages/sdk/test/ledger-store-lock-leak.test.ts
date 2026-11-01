// A release that fails must not wedge the process: the lock it leaves behind is its own and is broken by
// the next waiter. This needs `rm` to fail on demand, so it mocks node:fs/promises for this file only.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { withFileLock } from "../src/ledger-store-lock.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const tempDirs: string[] = [];

afterAll(async () => {
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await Promise.all(
    tempDirs.map((dir) =>
      real.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
});

describe("withFileLock: a release that fails", () => {
  it("keeps the task's result, leaves the lock, and the next caller of this process breaks it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probarion-lock-leak-"));
    tempDirs.push(dir);
    const lockPath = join(dir, "x.lock");
    vi.mocked(rm).mockImplementationOnce(async () => {
      throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    });

    expect(await withFileLock(lockPath, async () => "first", { timeoutMs: 2000 })).toBe("first");
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: process.pid });

    expect(await withFileLock(lockPath, async () => "second", { timeoutMs: 2000 })).toBe("second");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not hide the task's own error behind a failed release", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probarion-lock-leak-"));
    tempDirs.push(dir);
    const lockPath = join(dir, "x.lock");
    vi.mocked(rm).mockImplementationOnce(async () => {
      throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    });
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("the task failed");
      }),
    ).rejects.toThrow("the task failed");
  });
});
