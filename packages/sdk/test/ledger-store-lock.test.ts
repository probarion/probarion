import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";
import { createEd25519Signer, sha256Hex } from "@probarion/core";
import { afterAll, describe, expect, it } from "vitest";
import { LedgerError } from "../src/errors.js";
import { FileLedgerStore, type LedgerAppendBody } from "../src/ledger-store.js";
import { displayPath, type LockStep, withFileLock } from "../src/ledger-store-lock.js";
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

/** A one-shot latch for choreographing an interleaving. A gate nobody opens fails the test, it does not hang it. */
function gate(label: string, ms = 4000) {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    setTimeout(() => reject(new Error(`gate "${label}" was never opened`)), ms).unref();
  });
  promise.catch(() => undefined);
  return { open, wait: () => promise };
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

  it.each([
    ["empty", ""],
    ["not JSON", "not json at all"],
    ["JSON but not an object", "[]"],
    ["an object of the wrong shape", '{"pid":"nope"}'],
  ])(
    "a lock file that is %s is corruption: it fails loudly at once and is never broken",
    async (_name, text) => {
      // A held lock is published whole (hard link), so it is never empty or partial. Whatever such a file is,
      // no process may delete it on its own say-so, however old it is.
      const dir = await tempDir();
      const lockPath = join(dir, "x.lock");
      await writeFile(lockPath, text);
      const longAgo = new Date(Date.now() - 3_600_000);
      await utimes(lockPath, longAgo, longAgo);
      const started = Date.now();
      const error = await withFileLock(lockPath, async () => "ran", { timeoutMs: 10_000 }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(LedgerError);
      expect(error?.message).toContain(displayPath(lockPath));
      expect(error?.message).toMatch(/not a lock record|empty/);
      expect(error?.message).toMatch(/delete/);
      expect(error?.message).not.toContain("\\");
      expect(Date.now() - started).toBeLessThan(2000); // no waiting out the timeout
      expect(await readFile(lockPath, "utf8")).toBe(text);
      expect(await readdir(dir)).toEqual(["x.lock"]); // and its own temporary file is gone
    },
  );

  it("publishes the lock whole: absent until the link, complete the moment it exists", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    const seen: string[] = [];
    await withFileLock(lockPath, async () => undefined, {
      onStep: async (step) => {
        if (step === "tmp-written") {
          const state = await stat(lockPath).then(
            () => "exists",
            () => "absent",
          );
          seen.push(`tmp-written: lock ${state}`);
        }
        if (step === "published") {
          const info = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
          seen.push(
            `published: pid ${info.pid === process.pid ? "ok" : "wrong"}, token ${typeof info.token}`,
          );
        }
      },
    });
    expect(seen).toEqual(["tmp-written: lock absent", "published: pid ok, token string"]);
  });
});

describe("withFileLock: breaking a stale lock, interleavings forced by hooks", () => {
  const staleText = () => lockText({ pid: deadPid(), thread: 0, token: "stale-L0" });

  it("a delayed breaker never removes the lock that replaced the stale one (A breaks, B is late, C arrives)", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    await writeFile(lockPath, staleText());

    const bSeen = gate("B saw the stale lock");
    const aPublished = gate("A published L1");
    const bDecided = gate("B re-read the lock");
    let inside = 0;
    let maxInside = 0;
    const order: string[] = [];
    const enter = (name: string) => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      order.push(`${name} in`);
    };
    const leave = (name: string) => {
      inside -= 1;
      order.push(`${name} out`);
    };

    const a = withFileLock(
      lockPath,
      async () => {
        enter("A");
        await bDecided.wait(); // B has now looked at L1 and must have left it alone
        const held = JSON.parse(await readFile(lockPath, "utf8")) as { token: string };
        expect(held.token).not.toBe("stale-L0");
        await sleep(50); // C polls meanwhile
        leave("A");
      },
      {
        timeoutMs: 8000,
        onStep: async (step) => {
          if (step === "stale-seen") await bSeen.wait();
          if (step === "published") aPublished.open();
        },
      },
    );
    const b = withFileLock(
      lockPath,
      async () => {
        enter("B");
        leave("B");
      },
      {
        timeoutMs: 8000,
        onStep: async (step) => {
          if (step === "stale-seen") {
            bSeen.open();
            await aPublished.wait(); // B is slow: A breaks L0 and publishes L1 in the meantime
          }
          if (step === "break-rechecked") bDecided.open();
        },
      },
    );
    await aPublished.wait();
    const c = withFileLock(
      lockPath,
      async () => {
        enter("C");
        leave("C");
      },
      { timeoutMs: 8000 },
    );
    await Promise.all([a, b, c]);

    expect(maxInside).toBe(1);
    expect(order.slice(0, 2)).toEqual(["A in", "A out"]);
    expect([...order].sort()).toEqual(["A in", "A out", "B in", "B out", "C in", "C out"]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("a lock released while a breaker is late is not resurrected, and the late breaker then takes it", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    await writeFile(lockPath, staleText());

    const bSeen = gate("B saw the stale lock");
    const aFinished = gate("A released");
    let aToken = "";
    let bToken = "";
    const bSteps: LockStep[] = [];

    const a = withFileLock(
      lockPath,
      async () => {
        aToken = (JSON.parse(await readFile(lockPath, "utf8")) as { token: string }).token;
      },
      {
        timeoutMs: 8000,
        onStep: async (step) => {
          if (step === "stale-seen") await bSeen.wait();
        },
      },
    ).then(() => aFinished.open());
    const b = withFileLock(
      lockPath,
      async () => {
        bToken = (JSON.parse(await readFile(lockPath, "utf8")) as { token: string }).token;
      },
      {
        timeoutMs: 8000,
        onStep: async (step) => {
          bSteps.push(step);
          if (step === "stale-seen") {
            bSeen.open();
            await aFinished.wait(); // A took L0 out, ran, and released its own lock meanwhile
          }
        },
      },
    );
    await Promise.all([a, b]);

    // B really went through the breaking path, found the lock gone, and left it at that.
    expect(bSteps).toEqual([
      "tmp-written",
      "stale-seen",
      "break-held",
      "break-rechecked",
      "published",
    ]);
    expect(aToken).not.toBe("");
    expect(bToken).not.toBe("");
    expect(bToken).not.toBe(aToken); // A's token was not left behind or put back
    expect(await readdir(dir)).toEqual([]);
    // Nothing is wedged: the next caller of this process takes the lock at once.
    expect(await withFileLock(lockPath, async () => "ran", { timeoutMs: 500 })).toBe("ran");
  });

  it("two breakers never hold the break mutex at the same time", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    await writeFile(lockPath, staleText());
    let inBreak = 0;
    let maxInBreak = 0;
    const onStep = async (step: LockStep) => {
      if (step === "break-held") {
        inBreak += 1;
        maxInBreak = Math.max(maxInBreak, inBreak);
        await sleep(25);
      }
      if (step === "break-rechecked") inBreak -= 1;
    };
    let ran = 0;
    const task = async () => {
      ran += 1;
    };
    await Promise.all(
      Array.from({ length: 3 }, () => withFileLock(lockPath, task, { timeoutMs: 8000, onStep })),
    );
    expect(ran).toBe(3);
    expect(maxInBreak).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it("a stale lock replaced by another stale lock is looked at again, not removed on the strength of the first look", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    await writeFile(lockPath, staleText());
    const steps: LockStep[] = [];
    let replaced = false;
    const result = await withFileLock(lockPath, async () => "ran", {
      timeoutMs: 8000,
      onStep: async (step) => {
        steps.push(step);
        if (step === "stale-seen" && !replaced) {
          replaced = true;
          // Between the breaker's first look and its turn at the break mutex, the stale lock is replaced
          // by a different one (which has also been abandoned by now).
          await writeFile(lockPath, lockText({ pid: deadPid(), thread: 0, token: "stale-L1" }));
        }
      },
    });
    expect(result).toBe("ran");
    // The first break found a different token and removed nothing; the second looked at L1 itself.
    expect(steps.filter((step) => step === "stale-seen")).toHaveLength(2);
    expect(steps.filter((step) => step === "break-rechecked")).toHaveLength(2);
    expect(await readdir(dir)).toEqual([]);
  });

  it("a lock file that turns corrupt while a breaker is deciding fails loudly and frees the break mutex", async () => {
    const dir = await tempDir();
    const lockPath = join(dir, "x.lock");
    await writeFile(lockPath, staleText());
    const error = await withFileLock(lockPath, async () => "ran", {
      timeoutMs: 8000,
      onStep: async (step) => {
        if (step === "break-held") await writeFile(lockPath, "");
      },
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(LedgerError);
    expect(error?.message).toMatch(/not a lock record|empty/);
    expect(await readdir(dir)).toEqual(["x.lock"]); // no .break and no .tmp left behind
  });

  it.each([
    ["with content", () => lockText({ token: "crashed-breaker" })],
    ["empty", () => ""],
  ])(
    "a break mutex file left behind (%s) fails loudly after the timeout and is not removed",
    async (_name, text) => {
      const dir = await tempDir();
      const lockPath = join(dir, "x.lock");
      await writeFile(lockPath, staleText());
      await writeFile(`${lockPath}.break`, text());
      const started = Date.now();
      const error = await withFileLock(lockPath, async () => "ran", { timeoutMs: 250 }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(LedgerError);
      expect(error?.message).toContain(displayPath(`${lockPath}.break`));
      expect(error?.message).toMatch(/delete/);
      expect(error?.message).not.toContain("\\");
      expect(Date.now() - started).toBeGreaterThanOrEqual(200); // it retried until the timeout
      expect((await readdir(dir)).sort()).toEqual(["x.lock", "x.lock.break"]);
    },
  );
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

  it("processes appending to one file at the same moment never interleave and never fork the chain", async () => {
    const dir = await tempDir();
    const path = join(dir, "ledger.jsonl");
    const goFile = join(await tempDir(), "go");
    const writers = 3;
    const perWriter = 8;
    const sdkRoot = fileURLToPath(new URL("..", import.meta.url));
    const children = Array.from({ length: writers }, (_, w) =>
      startWriter(sdkRoot, path, `w${w}`, perWriter, goFile),
    );
    // Start barrier: no child appends until every child has loaded its code and said it is ready, so the
    // appends really overlap instead of the first child finishing before the last one has started.
    await Promise.all(children.map((child) => child.ready));
    await writeFile(goFile, "go");
    const outcomes = await Promise.all(children.map((child) => child.done));
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

function startWriter(
  cwd: string,
  path: string,
  tag: string,
  count: number,
  goFile: string,
): { ready: Promise<void>; done: Promise<WriterOutcome> } {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "test/helpers/ledger-writer.ts", path, tag, String(count), goFile],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const ready = new Promise<void>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes("ready")) resolve();
    });
    child.on("error", reject);
    child.on("close", () =>
      reject(new Error(`writer ${tag} exited before it was ready: ${stderr}`)),
    );
  });
  ready.catch(() => undefined);
  const done = new Promise<WriterOutcome>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
  return { ready, done };
}
