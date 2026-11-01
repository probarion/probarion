import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { threadId } from "node:worker_threads";
import { createEd25519Signer, sha256Hex } from "@probarion/core";
import { afterAll, describe, expect, it } from "vitest";
import { LedgerError } from "../src/errors.js";
import { FileLedgerStore, type LedgerAppendBody } from "../src/ledger-store.js";
import { displayPath, withFileLock } from "../src/ledger-store-lock.js";
import { TEST_KEYS } from "../src/testing/index.js";

const sign = createEd25519Signer(TEST_KEYS.ledger.secretKey);

function body(n: number): LedgerAppendBody {
  return {
    v: 1,
    vault: "acme.vaults.probarion.testnet",
    kind: "note",
    at: "2026-11-05T12:00:00.000Z",
    request_id: `req-${n}`,
    mandate_id: null,
    invoice_hash: sha256Hex(`invoice-${n}`),
    amount: null,
    proposal: null,
    evidence: null,
    rules: [],
    verdict: null,
    decided_by: null,
    contract: null,
    settlement: null,
    refs: null,
  };
}

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "probarion-lock-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

/** A pid that belonged to a process that has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  if (child.pid === undefined) throw new Error("could not spawn a child process");
  return child.pid;
}

function lockText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: process.pid,
    thread: threadId,
    host: hostname(),
    token: "someone-elses-token",
    at: new Date().toISOString(),
    ...overrides,
  });
}

describe("withFileLock", () => {
  it("creates the lock for the task, removes it afterwards and returns the result", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "sub", "x.lock");
    const result = await withFileLock(lockPath, async () => {
      const info = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      expect(info).toMatchObject({ pid: process.pid, host: hostname() });
      return 42;
    });
    expect(result).toBe(42);
    expect(await readdir(join(dir, "sub"))).toEqual([]);
  });

  it("removes the lock when the task throws", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await readdir(dir)).toEqual([]);
  });

  it("runs competing tasks one at a time", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    let inside = 0;
    let overlap = false;
    let ran = 0;
    const task = async () => {
      inside += 1;
      if (inside > 1) overlap = true;
      await sleep(2);
      inside -= 1;
      ran += 1;
    };
    // Several rounds: a waiter that misjudges a lock released a moment ago as stale is a race, and a
    // single round of six tasks hit it only about once in twenty runs.
    for (let round = 0; round < 6; round++) {
      await Promise.all(Array.from({ length: 8 }, () => withFileLock(lockPath, task)));
    }
    expect(ran).toBe(48);
    expect(overlap).toBe(false);
  }, 60_000);

  it("never removes a lock that is no longer its own", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    await withFileLock(lockPath, async () => {
      // Someone broke our lock and took it over while we were working.
      await writeFile(lockPath, lockText({ pid: process.pid + 1, token: "the-new-owner" }));
    });
    expect(JSON.parse(await readFile(lockPath, "utf8")).token).toBe("the-new-owner");
  });

  it("breaks a lock whose owner process is gone", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    await writeFile(lockPath, lockText({ pid: deadPid(), thread: 0 }));
    expect(await withFileLock(lockPath, async () => "ran", { timeoutMs: 2000 })).toBe("ran");
    expect(await readdir(dir)).toEqual([]);
  });

  it("does not break a lock owned by a live process, and says who holds it", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    await withFileLock(lockPath, async () => {
      const error = await withFileLock(lockPath, async () => "ran", { timeoutMs: 120 }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(LedgerError);
      expect(error?.message).toContain(displayPath(lockPath));
      expect(error?.message).toContain(`pid ${process.pid}`);
      expect(error?.message).toContain(hostname());
      expect(error?.message).toMatch(/delete the lock file/);
      expect(error?.message).not.toContain("\\");
    });
  });

  it("does not break a lock from another host, even when its pid is not running here", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    await writeFile(lockPath, lockText({ pid: deadPid(), thread: 0, host: "some-other-host" }));
    await expect(withFileLock(lockPath, async () => "ran", { timeoutMs: 120 })).rejects.toThrow(
      /some-other-host/,
    );
    expect((await stat(lockPath)).isFile()).toBe(true);
  });

  it("does not break a lock of this process it cannot show to be leaked", async () => {
    // Same pid and thread, but a token this module never failed to release: live, or released a moment
    // ago and seen late. Either way it is not for a waiter to remove.
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    await writeFile(lockPath, lockText({ token: "unknown-token" }));
    await expect(withFileLock(lockPath, async () => "ran", { timeoutMs: 120 })).rejects.toThrow(
      LedgerError,
    );
    expect((await stat(lockPath)).isFile()).toBe(true);
  });

  it("does not break a lock of this process's other thread", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    await writeFile(lockPath, lockText({ thread: threadId + 1 }));
    await expect(withFileLock(lockPath, async () => "ran", { timeoutMs: 120 })).rejects.toThrow(
      LedgerError,
    );
  });

  it("waits out a lock file that is still being written, then breaks an unreadable old one", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    // Created a moment ago and still empty: its owner is probably about to write into it.
    await writeFile(lockPath, "");
    await expect(withFileLock(lockPath, async () => "ran", { timeoutMs: 120 })).rejects.toThrow(
      LedgerError,
    );
    // The same file, left behind long ago by a process that died between create and write.
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(lockPath, longAgo, longAgo);
    expect(await withFileLock(lockPath, async () => "ran", { timeoutMs: 2000 })).toBe("ran");
    await writeFile(lockPath, "not json at all");
    await utimes(lockPath, longAgo, longAgo);
    expect(await withFileLock(lockPath, async () => "ran", { timeoutMs: 2000 })).toBe("ran");
  });
});

describe("FileLedgerStore: crashed and competing writers", () => {
  it("appends after a writer died holding the lock", async () => {
    const dir = await tempDir();
    const path = join(dir, "ledger.jsonl");
    const store = new FileLedgerStore(path);
    await store.append(body(0), sign);
    await writeFile(`${path}.lock`, lockText({ pid: deadPid(), thread: 0 }));
    expect((await store.append(body(1), sign)).body.seq).toBe(1);
    expect(await readdir(dir)).toEqual(["ledger.jsonl"]);
  });

  it("gives up with an error that names the lock when a live writer keeps it, and writes nothing", async () => {
    const dir = await tempDir();
    const path = join(dir, "ledger.jsonl");
    const store = new FileLedgerStore(path, { lockTimeoutMs: 120 });
    await store.append(body(0), sign);
    const before = await readFile(path, "utf8");
    await withFileLock(`${path}.lock`, async () => {
      await expect(store.append(body(1), sign)).rejects.toThrow(/ledger\.jsonl\.lock/);
    });
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await store.append(body(1), sign)).body.seq).toBe(1);
  });

  it("two processes appending to one file never interleave and never fork the chain", async () => {
    const dir = await tempDir();
    const path = join(dir, "ledger.jsonl");
    const writers = 3;
    const perWriter = 8;
    const sdkRoot = new URL("..", import.meta.url);
    const runs = Array.from({ length: writers }, (_, w) =>
      runWriter(sdkRoot, path, `w${w}`, perWriter),
    );
    const outcomes = await Promise.all(runs);
    for (const outcome of outcomes) expect(outcome).toEqual({ code: 0, stderr: "" });

    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.slice(0, -1).split("\n");
    expect(lines).toHaveLength(writers * perWriter);
    const entries = lines.map(
      (line) => JSON.parse(line) as Awaited<ReturnType<FileLedgerStore["head"]>> & object,
    );
    expect(entries.map((e) => e.body.seq)).toEqual(
      Array.from({ length: lines.length }, (_, i) => i),
    );
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]?.body.prev_link).toBe(entries[i - 1]?.link);
    }
    expect(new Set(entries.map((e) => e.body.request_id)).size).toBe(lines.length);
    expect(await readdir(dir)).toEqual(["ledger.jsonl"]);
  }, 90_000);
});

interface WriterOutcome {
  code: number | null;
  stderr: string;
}

async function runWriter(
  sdkRoot: URL,
  path: string,
  tag: string,
  count: number,
): Promise<WriterOutcome> {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cwd = fileURLToPath(sdkRoot);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "test/helpers/ledger-writer.ts", path, tag, String(count)],
      { cwd, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}
