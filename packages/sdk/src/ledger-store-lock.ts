// An exclusive lock file for the ledger file, so that two processes appending to one ledger never
// interleave bytes or fork the chain (both reading the same head and both writing seq n + 1).
//
//   - The lock is `<ledger>.lock`, created with O_CREAT|O_EXCL (`wx`): one creator wins on NTFS and on
//     POSIX alike. Its content is `{ pid, thread, host, token, at }`.
//   - A waiter polls with a short backoff and gives up after `timeoutMs` with an error that names the lock
//     file and its holder. Nothing is ever written without the lock.
//   - A lock whose owner is provably gone is broken: same host and the pid is not running; or a lock of
//     this very process and thread whose release failed (its token is in `leaked`); or a file that stayed
//     empty or unparseable for more than UNREADABLE_LOCK_GRACE_MS (a process died between create and write).
//   - A lock held by a live process, or by another host, is NEVER broken. A recycled pid therefore makes a
//     dead owner look alive: the wait ends with an error that says to delete the lock file by hand. That is
//     the deliberate trade: a stuck writer is loud, a forked ledger would be silent.
//   - Stale locks are broken by renaming them aside (atomic) and checking what was moved; a lock that turns
//     out to be a fresh one is linked back. Two recoveries racing with a third new owner in the same
//     instant can still lose that last put-back; this needs a crashed writer AND three live processes.
//   - Release removes the file only when it still carries this holder's token.
//
// The lock is advisory and cooperative: it protects against other `FileLedgerStore`s, not against an
// editor or a shell redirect. It assumes a local file system (not NFS or SMB shared between hosts).
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { threadId } from "node:worker_threads";
import { LedgerError } from "./errors.js";

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const UNREADABLE_LOCK_GRACE_MS = 5_000;
const MAX_POLL_MS = 100;

export interface FileLockOptions {
  /** How long to wait for another writer before giving up. Default 10 s. */
  timeoutMs?: number;
}

/** A path as it is printed in messages: always forward slashes (R11). */
export function displayPath(path: string): string {
  return path.replaceAll("\\", "/");
}

interface LockInfo {
  pid: number;
  thread: number;
  host: string;
  token: string;
  at: string;
}

interface Holder {
  /** null when the file is empty or not a lock record. */
  info: LockInfo | null;
  ageMs: number;
}

/**
 * Tokens of locks this module created and then failed to remove. Only these are "leaked" locks of our own:
 * a lock of our pid whose token is not here is either live or was released a moment ago, and a waiter that
 * looked at it earlier must not mistake it for stale.
 */
const leaked = new Set<string>();

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? ((error as { code?: unknown }).code as string | undefined)
    : undefined;
}

/** Windows reports a lock file that is open, or deleted but still open elsewhere, as EPERM/EBUSY/EACCES. */
function isTransientOnWindows(error: unknown): boolean {
  const code = errorCode(error);
  return (
    process.platform === "win32" && (code === "EPERM" || code === "EBUSY" || code === "EACCES")
  );
}

function parseInfo(text: string): LockInfo | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const v = value as Record<string, unknown>;
    if (
      typeof v.pid === "number" &&
      Number.isSafeInteger(v.pid) &&
      v.pid > 0 &&
      typeof v.thread === "number" &&
      Number.isSafeInteger(v.thread) &&
      typeof v.host === "string" &&
      typeof v.token === "string" &&
      typeof v.at === "string"
    ) {
      return { pid: v.pid, thread: v.thread, host: v.host, token: v.token, at: v.at };
    }
  } catch {
    // not JSON: an unreadable lock
  }
  return null;
}

/** null when the lock file does not exist. */
async function readHolder(lockPath: string): Promise<Holder | null> {
  try {
    const text = await readFile(lockPath, "utf8");
    const { mtimeMs } = await stat(lockPath);
    return { info: parseInfo(text), ageMs: Date.now() - mtimeMs };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (isTransientOnWindows(error)) return { info: null, ageMs: 0 };
    throw error;
  }
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: it exists but belongs to someone else.
    return errorCode(error) !== "ESRCH";
  }
}

function isStale(holder: Holder): boolean {
  const { info } = holder;
  if (info === null) return holder.ageMs > UNREADABLE_LOCK_GRACE_MS;
  if (info.host !== hostname()) return false;
  if (info.pid === process.pid) return info.thread === threadId && leaked.has(info.token);
  return !pidIsRunning(info.pid);
}

/** True when the lock file was removed and the caller should try to create it again at once. */
async function breakStale(lockPath: string, observed: Holder): Promise<boolean> {
  const aside = `${lockPath}.${randomUUID()}.stale`;
  try {
    await rename(lockPath, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true; // someone else broke it first
    if (isTransientOnWindows(error)) return false;
    throw error;
  }
  const moved = await readHolder(aside);
  const same =
    moved !== null &&
    (moved.info === null
      ? observed.info === null
      : observed.info !== null && moved.info.token === observed.info.token);
  if (!same) {
    // A new owner took the lock between our look and our rename: put it back if the name is free.
    await link(aside, lockPath).catch(() => undefined);
  }
  await rm(aside, { force: true }).catch(() => undefined);
  return same;
}

async function tryCreate(lockPath: string, info: LockInfo): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (errorCode(error) === "EEXIST" || isTransientOnWindows(error)) return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(info));
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return true;
}

function timeoutError(lockPath: string, timeoutMs: number, holder: Holder | null): LedgerError {
  const who =
    holder?.info != null
      ? `held by pid ${holder.info.pid} on ${holder.info.host} since ${holder.info.at}`
      : "held by an unknown owner (the lock file is empty or unreadable)";
  return new LedgerError(
    `${displayPath(lockPath)}: could not take the ledger lock within ${timeoutMs} ms; it is ${who}. ` +
      "If that process is gone, delete the lock file and retry.",
  );
}

async function acquire(lockPath: string, timeoutMs: number): Promise<string> {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const info: LockInfo = {
    pid: process.pid,
    thread: threadId,
    host: hostname(),
    token,
    at: new Date().toISOString(),
  };
  const deadline = Date.now() + timeoutMs;
  let delay = 2;
  for (;;) {
    if (await tryCreate(lockPath, info)) return token;
    const holder = await readHolder(lockPath);
    if (holder !== null && isStale(holder) && (await breakStale(lockPath, holder))) continue;
    if (Date.now() >= deadline) throw timeoutError(lockPath, timeoutMs, holder);
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_POLL_MS);
  }
}

async function release(lockPath: string, token: string): Promise<void> {
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const holder = await readHolder(lockPath);
      if (holder?.info?.token !== token) return; // gone, or taken over: never delete someone else's lock
      try {
        await rm(lockPath, { force: true });
        return;
      } catch (error) {
        if (!isTransientOnWindows(error)) throw error;
        await sleep(20 * (attempt + 1));
      }
    }
    leaked.add(token); // still there after every retry
  } catch (error) {
    leaked.add(token);
    throw error;
  }
}

/**
 * Runs `task` while holding the exclusive lock file `lockPath` (creating its directory). The lock is
 * released when the task finishes or throws; a failure to release never replaces the task's result.
 */
export async function withFileLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const token = await acquire(lockPath, options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  try {
    return await task();
  } finally {
    await release(lockPath, token).catch(() => undefined);
  }
}
