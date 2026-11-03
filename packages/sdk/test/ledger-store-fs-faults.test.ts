// Faults in the file system that a real disk will not produce on demand: a link that is refused, a read
// that fails while releasing, a directory that cannot be synced, a write that fails half way. They need
// node:fs/promises to fail on command, so this file mocks it (each function still calls the real one
// unless a test says otherwise).
import { spawnSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { threadId } from "node:worker_threads";
import { createEd25519Signer, sha256Hex } from "@probarion/core";
import { afterAll, afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { LedgerError } from "../src/errors.js";
import { FileLedgerStore, type LedgerAppendBody } from "../src/ledger-store.js";
import { withoutNamespacePrefix } from "../src/ledger-store-fs.js";
import { displayPath, withFileLock } from "../src/ledger-store-lock.js";
import { TEST_KEYS } from "../src/testing/index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    mkdir: vi.fn(actual.mkdir),
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    rm: vi.fn(actual.rm),
    stat: vi.fn(actual.stat),
  };
});

const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const fns = {
  link: fsp.link,
  mkdir: fsp.mkdir,
  open: fsp.open,
  readFile: fsp.readFile,
  rm: fsp.rm,
  stat: fsp.stat,
} as unknown as Record<"link" | "mkdir" | "open" | "readFile" | "rm" | "stat", Mock>;

beforeEach(() => {
  for (const name of Object.keys(fns) as Array<keyof typeof fns>) {
    fns[name].mockReset();
    fns[name].mockImplementation(real[name] as never);
  }
});

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

const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await real.mkdtemp(join(tmpdir(), "probarion-faults-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) =>
      real.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
});

function liveLock(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: process.pid,
    thread: threadId,
    host: hostname(),
    token: "held-by-someone",
    at: new Date().toISOString(),
    ...overrides,
  });
}

type AnyFn = (...args: unknown[]) => Promise<unknown>;

describe("withFileLock: a release that fails", () => {
  it("keeps the task's result, leaves the lock, and the next caller of this process breaks it", async () => {
    const lockPath = join(await tempDir(), "x.lock");
    fns.rm.mockImplementationOnce(async () => {
      throw errno("EIO");
    });

    expect(await withFileLock(lockPath, async () => "first", { timeoutMs: 2000 })).toBe("first");
    expect(JSON.parse(await real.readFile(lockPath, "utf8"))).toMatchObject({ pid: process.pid });

    expect(await withFileLock(lockPath, async () => "second", { timeoutMs: 2000 })).toBe("second");
    await expect(real.readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not hide the task's own error behind a failed release", async () => {
    const lockPath = join(await tempDir(), "x.lock");
    fns.rm.mockImplementationOnce(async () => {
      throw errno("EIO");
    });
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("the task failed");
      }),
    ).rejects.toThrow("the task failed");
  });

  /** Reads of `lockPath` fail with `code` while `failing.on` (counting them); every other read is real. */
  function failReads(lockPath: string, code: string, failing: { on: boolean; calls: number }) {
    fns.readFile.mockImplementation(async (path: unknown, ...rest: unknown[]) => {
      if (path === lockPath && failing.on) {
        failing.calls += 1;
        throw errno(code);
      }
      return (real.readFile as AnyFn)(path, ...rest);
    });
  }

  it("retries a transient read error while releasing (EBUSY), then removes the lock", async () => {
    const lockPath = join(await tempDir(), "x.lock");
    let failures = 0;
    fns.readFile.mockImplementation(async (path: unknown, ...rest: unknown[]) => {
      if (path === lockPath && failures < 2) {
        failures += 1;
        throw errno("EBUSY");
      }
      return (real.readFile as AnyFn)(path, ...rest);
    });
    expect(await withFileLock(lockPath, async () => "ran", { timeoutMs: 2000 })).toBe("ran");
    expect(failures).toBe(2);
    await expect(real.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("when it still cannot read the lock after every retry, the lock is marked leaked and the next caller takes it over", async () => {
    const lockPath = join(await tempDir(), "x.lock");
    const failing = { on: true, calls: 0 };
    failReads(lockPath, "EBUSY", failing);
    expect(await withFileLock(lockPath, async () => "ran", { timeoutMs: 2000 })).toBe("ran");
    expect(failing.calls).toBeGreaterThan(1); // it retried
    expect((await real.stat(lockPath)).isFile()).toBe(true); // and then left it, it could not tell it was its own
    failing.on = false;
    expect(await withFileLock(lockPath, async () => "again", { timeoutMs: 2000 })).toBe("again");
    await expect(real.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["EPERM", "EACCES"])("on Windows %s is transient too", async (code) => {
    const lockPath = join(await tempDir(), "x.lock");
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    if (original === undefined) throw new Error("no process.platform");
    let failures = 0;
    fns.readFile.mockImplementation(async (path: unknown, ...rest: unknown[]) => {
      if (path === lockPath && failures < 2) {
        failures += 1;
        throw errno(code);
      }
      return (real.readFile as AnyFn)(path, ...rest);
    });
    Object.defineProperty(process, "platform", { ...original, value: "win32" });
    try {
      expect(await withFileLock(lockPath, async () => "ran", { timeoutMs: 2000 })).toBe("ran");
    } finally {
      Object.defineProperty(process, "platform", original);
    }
    expect(failures).toBe(2);
    await expect(real.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("withFileLock: a file system that cannot publish a lock atomically", () => {
  it.each(["ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"])(
    "a link that fails with %s is an error that says so, and nothing is created non-atomically",
    async (code) => {
      const dir = await tempDir();
      const lockPath = join(dir, "x.lock");
      fns.link.mockImplementation(async () => {
        throw errno(code);
      });
      const error = await withFileLock(lockPath, async () => "ran", { timeoutMs: 2000 }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(LedgerError);
      expect(error?.message).toMatch(/hard links/);
      expect(error?.message).toContain(code);
      expect(error?.message).toContain(displayPath(lockPath));
      expect(error?.message).not.toContain("\\");
      expect(await real.readdir(dir)).toEqual([]); // no lock, and its temporary file is gone
      // The old way (create the lock name with O_EXCL, write into it) is not a fallback.
      expect(fns.open.mock.calls.filter(([path]) => path === lockPath)).toEqual([]);
    },
  );

  it("EPERM with no lock in the way is the same failure (a file system without hard links)", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    fns.link.mockImplementation(async () => {
      throw errno("EPERM");
    });
    await expect(withFileLock(lockPath, async () => "ran", { timeoutMs: 2000 })).rejects.toThrow(
      /hard links/,
    );
    expect(await real.readdir(dir)).toEqual([]);
  });

  it("EPERM while a lock exists is contention (Windows says so for a lock being removed), not a missing feature", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    await real.writeFile(lockPath, liveLock());
    fns.link.mockImplementation(async () => {
      throw errno("EPERM");
    });
    const error = await withFileLock(lockPath, async () => "ran", { timeoutMs: 150 }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(LedgerError);
    expect(error?.message).toMatch(/could not take the ledger lock/);
    expect(error?.message).not.toMatch(/hard links/);
  });

  it("says what else EPERM or EACCES can mean: no hard links, or access denied", async () => {
    const lockPath = join(await tempDir(), "x.lock");
    fns.link.mockImplementation(async () => {
      throw errno("EACCES");
    });
    const error = await withFileLock(lockPath, async () => "ran", { timeoutMs: 2000 }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(LedgerError);
    expect(error?.message).toMatch(/no hard links, or access denied \(EACCES\)/);
    expect(error?.message).toMatch(/SELinux|ACL/);
  });

  it.each(["EPERM", "EACCES"])(
    "%s with no lock in the way gets one more try before it is called a missing feature",
    async (code) => {
      // The name may have been deleted between link's answer and our look at it.
      const lockPath = join(await tempDir(), "x.lock");
      fns.link.mockImplementationOnce(async () => {
        throw errno(code);
      });
      expect(await withFileLock(lockPath, async () => "ran", { timeoutMs: 2000 })).toBe("ran");
      expect(fns.link).toHaveBeenCalledTimes(2);
    },
  );

  it("gives up after that one retry, not after many", async () => {
    const lockPath = join(await tempDir(), "x.lock");
    fns.link.mockImplementation(async () => {
      throw errno("EPERM");
    });
    await expect(withFileLock(lockPath, async () => "ran", { timeoutMs: 2000 })).rejects.toThrow(
      /hard links/,
    );
    expect(fns.link).toHaveBeenCalledTimes(2);
  });

  it("backs off when link keeps saying busy for a name that is not there (no tight loop)", async () => {
    // Antivirus holding the temporary file makes link answer EBUSY while no lock exists to read.
    const lockPath = join(await tempDir(), "x.lock");
    fns.link.mockImplementation(async () => {
      throw errno("EBUSY");
    });
    const started = Date.now();
    const error = await withFileLock(lockPath, async () => "ran", { timeoutMs: 250 }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(LedgerError);
    expect(error?.message).toMatch(/could not take the ledger lock/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200); // still bounded by the deadline, not before it
    // 2, 4, 8, ... 100 ms between tries is a dozen or so tries in 250 ms; a loop with no sleep is thousands.
    expect(fns.link.mock.calls.length).toBeLessThan(40);
  });

  it("an unexpected link error (disk full) is thrown as it is", async () => {
    const lockPath = join(await tempDir(), "x.lock");
    fns.link.mockImplementation(async () => {
      throw errno("ENOSPC");
    });
    await expect(
      withFileLock(lockPath, async () => "ran", { timeoutMs: 2000 }),
    ).rejects.toMatchObject({ code: "ENOSPC" });
  });
});

describe("withFileLock: the record is on disk before it is linked into place", () => {
  it("syncs the temporary file before link(), for the lock and for the break mutex", async () => {
    // A power cut after the link but before the data reached the disk would leave a lock that exists and
    // is empty. Empty locks are never removed automatically, so that would need a manual delete.
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    // A stale lock, so that this acquire publishes the break mutex as well as its own lock.
    await real.writeFile(lockPath, liveLock({ pid: dead, thread: 0, token: "stale-L0" }));
    const events: string[] = [];
    fns.open.mockImplementation(async (path: unknown, flags?: unknown, ...rest: unknown[]) => {
      const handle = (await (real.open as AnyFn)(path, flags, ...rest)) as fsp.FileHandle;
      if (typeof path === "string" && path.endsWith(".tmp")) {
        const kind = basename(path).startsWith("x.lock.break.") ? "break" : "lock";
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          events.push(`sync ${kind} tmp`);
          return sync();
        };
      }
      return handle;
    });
    fns.link.mockImplementation(async (from: unknown, to: unknown) => {
      events.push(`link ${basename(String(to))}`);
      return (real.link as AnyFn)(from, to);
    });
    expect(await withFileLock(lockPath, async () => "ran", { timeoutMs: 5000 })).toBe("ran");
    expect(events).toEqual([
      "sync lock tmp", // our record is durable before we try to name it
      "link x.lock", // taken: the stale lock is there
      "sync break tmp",
      "link x.lock.break",
      "link x.lock", // the stale lock is gone: this one succeeds
    ]);
  });
});

describe("FileLedgerStore: directory durability", () => {
  /** Records which directories get opened for reading and synced, whatever the platform does with them. */
  function watchDirectories(): { opened: string[]; synced: string[] } {
    const seen = { opened: [] as string[], synced: [] as string[] };
    fns.open.mockImplementation(async (path: unknown, flags?: unknown, ...rest: unknown[]) => {
      const handle = (await (real.open as AnyFn)(path, flags, ...rest)) as fsp.FileHandle;
      if (flags === "r") {
        seen.opened.push(String(path));
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          seen.synced.push(String(path));
          return sync();
        };
      }
      return handle;
    });
    return seen;
  }

  it("opens and syncs the ledger's directory when the file is created, and not again", async () => {
    const dir = await tempDir();
    const store = new FileLedgerStore(join(dir, "ledger.jsonl"));
    const seen = watchDirectories();
    await store.append(body(0), sign);
    expect(seen.synced.filter((path) => path === dir)).toHaveLength(1);
    await store.append(body(1), sign);
    expect(seen.synced.filter((path) => path === dir)).toHaveLength(1);
  });

  it("withoutNamespacePrefix drops the Windows \\\\?\\ prefix and nothing else", () => {
    expect(withoutNamespacePrefix(String.raw`\\?\C:\Users\x\a`)).toBe(String.raw`C:\Users\x\a`);
    expect(withoutNamespacePrefix(String.raw`\\?\UNC\srv\share\a`)).toBe(String.raw`\\srv\share\a`);
    expect(withoutNamespacePrefix(String.raw`C:\plain`)).toBe(String.raw`C:\plain`);
    expect(withoutNamespacePrefix("/posix/path")).toBe("/posix/path");
  });

  it("syncs the parent of every directory it had to create", async () => {
    const base = await tempDir();
    const a = join(base, "a");
    const b = join(a, "b");
    const store = new FileLedgerStore(join(b, "ledger.jsonl"));
    const seen = watchDirectories();
    await store.append(body(0), sign);
    // base holds a, a holds b, b holds the ledger file: exactly these, and no ancestor above base. (On
    // Windows `mkdir` reports the first directory it made as `\\?\C:\...`; a stop test that did not
    // allow for that walked up to the drive root.)
    expect(seen.synced).toEqual([a, base, b]);
    // Nothing new is created by the next append, so no directory is synced again.
    const before = seen.synced.length;
    await store.append(body(1), sign);
    expect(seen.synced.length).toBe(before);
  });

  it.each(["EISDIR", "EPERM", "EINVAL"])(
    "a directory that cannot be synced (%s) is not an error",
    async (code) => {
      const dir = await tempDir();
      const store = new FileLedgerStore(join(dir, "ledger.jsonl"));
      fns.open.mockImplementation(async (path: unknown, flags?: unknown, ...rest: unknown[]) => {
        if (path === dir && flags === "r") throw errno(code);
        return (real.open as AnyFn)(path, flags, ...rest);
      });
      expect((await store.append(body(0), sign)).body.seq).toBe(0);
    },
  );

  /** Opens of `dir` for reading get a handle whose sync() fails with `code`. */
  function directorySyncFails(dir: string, code: string): void {
    fns.open.mockImplementation(async (path: unknown, flags?: unknown, ...rest: unknown[]) => {
      const handle = (await (real.open as AnyFn)(path, flags, ...rest)) as fsp.FileHandle;
      if (path === dir && flags === "r") {
        handle.sync = async () => {
          throw errno(code);
        };
      }
      return handle;
    });
  }

  it.each(["EISDIR", "EPERM", "EINVAL"])(
    "a directory handle whose sync is not supported (%s) is not an error either",
    async (code) => {
      const dir = await tempDir();
      const store = new FileLedgerStore(join(dir, "ledger.jsonl"));
      directorySyncFails(dir, code);
      expect((await store.append(body(0), sign)).body.seq).toBe(0);
    },
  );

  it("an EIO from the directory's sync fails the append and takes the line back out", async () => {
    const dir = await tempDir();
    const path = join(dir, "ledger.jsonl");
    const store = new FileLedgerStore(path);
    directorySyncFails(dir, "EIO");
    await expect(store.append(body(0), sign)).rejects.toMatchObject({ code: "EIO" });
    expect(await real.readFile(path, "utf8")).toBe("");
  });

  it("any other failure to sync the directory (EIO) fails the append and takes the line back out", async () => {
    const dir = await tempDir();
    const path = join(dir, "ledger.jsonl");
    const store = new FileLedgerStore(path);
    let failing = true;
    fns.open.mockImplementation(async (target: unknown, flags?: unknown, ...rest: unknown[]) => {
      if (failing && target === dir && flags === "r") throw errno("EIO");
      return (real.open as AnyFn)(target, flags, ...rest);
    });
    await expect(store.append(body(0), sign)).rejects.toMatchObject({ code: "EIO" });
    expect(await real.readFile(path, "utf8")).toBe(""); // nothing of the entry is left
    expect(await real.readdir(dir)).toEqual(["ledger.jsonl"]); // and no lock either
    failing = false;
    expect((await store.append(body(0), sign)).body.seq).toBe(0);
  });

  it("an EIO while syncing a directory it just created fails the append before anything is written", async () => {
    const base = await tempDir();
    const path = join(base, "a", "ledger.jsonl");
    const store = new FileLedgerStore(path);
    fns.open.mockImplementation(async (target: unknown, flags?: unknown, ...rest: unknown[]) => {
      if (target === base && flags === "r") throw errno("EIO");
      return (real.open as AnyFn)(target, flags, ...rest);
    });
    await expect(store.append(body(0), sign)).rejects.toMatchObject({ code: "EIO" });
    await expect(real.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("FileLedgerStore: rollback of a failed write", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  type WriteFile = (this: unknown, data: Buffer | string) => Promise<void>;

  async function handlePrototype(path: string): Promise<{ writeFile: WriteFile }> {
    const handle = await real.open(path, "r");
    const proto = Object.getPrototypeOf(handle) as { writeFile: WriteFile };
    await handle.close();
    return proto;
  }

  it("does not truncate a file that grew beyond our own write; it throws a LedgerError and leaves the file alone", async () => {
    const dir = await tempDir();
    const path = join(dir, "ledger.jsonl");
    const store = new FileLedgerStore(path);
    await store.append(body(0), sign);
    const before = await real.readFile(path);

    const proto = await handlePrototype(path);
    const original = proto.writeFile;
    let half = 0;
    let junk = 0;
    const spy = vi.spyOn(proto, "writeFile").mockImplementation(async function (
      this: unknown,
      data: Buffer | string,
    ) {
      if (typeof data === "string" || half > 0) return original.call(this, data);
      half = Math.floor(data.length / 2);
      await original.call(this, data.subarray(0, half));
      // Another process that does not honour the lock writes after our partial line.
      junk = data.length * 2;
      await real.appendFile(path, Buffer.alloc(junk, 0x58));
      throw errno("ENOSPC");
    });
    spies.push(spy);

    const error = await store.append(body(1), sign).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(LedgerError);
    expect(error?.message).toMatch(/has grown by .* another process wrote/);
    expect(error?.message).toMatch(/ENOSPC/); // the original failure is not lost
    expect(error?.message).toContain(displayPath(path));
    expect(error?.message).not.toContain("\\");
    const after = await real.readFile(path);
    expect(after.length).toBe(before.length + half + junk); // nothing was truncated
    expect(after.subarray(0, before.length)).toEqual(before);
  });

  it("still truncates when only our own bytes are beyond the old end", async () => {
    const dir = await tempDir();
    const path = join(dir, "ledger.jsonl");
    const store = new FileLedgerStore(path);
    await store.append(body(0), sign);
    const before = await real.readFile(path);
    const proto = await handlePrototype(path);
    const original = proto.writeFile;
    let failed = false;
    const spy = vi.spyOn(proto, "writeFile").mockImplementation(async function (
      this: unknown,
      data: Buffer | string,
    ) {
      if (typeof data === "string" || failed) return original.call(this, data);
      failed = true;
      await original.call(this, data); // the whole line is written, then the flush fails
      throw errno("EIO");
    });
    spies.push(spy);
    await expect(store.append(body(1), sign)).rejects.toMatchObject({ code: "EIO" });
    expect(await real.readFile(path)).toEqual(before);
  });
});
