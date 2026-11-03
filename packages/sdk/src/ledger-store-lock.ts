// An exclusive lock file for the ledger file, so that two processes appending to one ledger never
// interleave bytes or fork the chain (both reading the same head and both writing seq n + 1).
//
// Taking the lock
//   - The lock is `<ledger>.lock`. It is PUBLISHED, not created: the full record `{ pid, thread, host, token,
//     at }` is written to `<lock>.<token>.tmp` and synced to disk first, then `link(tmp, lock)` gives it its
//     name in one atomic step (EEXIST = somebody holds it), and the tmp name is unlinked. So a lock that
//     exists is always complete, even across a power cut: it is never empty and never half written.
//   - A file system without hard links (FAT, exFAT, some network shares) cannot do this. That is an error
//     that says so; there is no fallback to a non-atomic create, which is exactly the race this avoids.
//   - A lock file that is empty, not JSON or not a lock record is therefore corruption, not a lock being
//     written. It is never removed automatically, whatever its age: the error says to delete it by hand.
//   - A waiter polls with a short backoff and gives up after `timeoutMs` with an error that names the lock
//     file and its holder. Nothing is ever written without the lock.
//
// Breaking a stale lock
//   - A lock is stale only when its owner is provably gone: same host and the pid is not running; or a lock
//     of this very process and thread whose release failed (its token is in `leaked`).
//   - A lock held by a live process, another thread of this process, or another host is NEVER broken. A
//     recycled pid therefore makes a dead owner look alive: the wait ends with an error that says to delete
//     the lock file by hand. The trade is deliberate: a stuck writer is loud, a forked ledger is silent.
//   - Breaking is serialized by a second published file, `<lock>.break`, which holds the breaker's token.
//     Under it the breaker re-reads the lock and unlinks it only if it is still the SAME stale token it saw;
//     then it releases `.break` and everyone goes back to taking the lock the normal way. The lock name is
//     never renamed aside or put back, so there is no moment at which it is vacant while a live owner exists,
//     and a breaker that was slow to act finds the new owner's lock and leaves it alone.
//   - A `.break` file that outlives the timeout (its breaker died inside the critical section) is also not
//     removed automatically: the error says to delete it.
//   - Release unlinks the lock only if it still carries this holder's token. A release that cannot read the
//     lock (a transient error, retried) or remove it records the token in `leaked`, so the next caller in
//     this process can break it.
//
// Scope
//   - The lock is advisory and cooperative: it protects against other `FileLedgerStore`s, not against an
//     editor or a shell redirect. It assumes a local file system, not NFS or SMB shared between hosts.
//   - Ownership is judged by host name and pid. Containers that share a ledger directory (a bind mount)
//     need DISTINCT hostnames, or each sees the other's pid as its own or as a dead process. And if a
//     machine's hostname changes while a lock is held, that lock looks like another host's: it is never
//     broken, so after a crash it has to be deleted by hand. PID namespaces beyond that are not handled.
import { randomUUID } from "node:crypto";
import { link, open, readFile, rm, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { threadId } from "node:worker_threads";
import { LedgerError } from "./errors.js";
import { ensureDirectory, errorCode, isTransientFsError } from "./ledger-store-fs.js";

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const MAX_POLL_MS = 100;
const RELEASE_ATTEMPTS = 5;

/** The points of the protocol at which `onStep` is called (see `FileLockOptions.onStep`). */
export type LockStep =
  | "tmp-written" // the record is on disk under its temporary name; the lock does not exist yet
  | "published" // this caller now holds the lock
  | "stale-seen" // a stale lock was seen; the break mutex has not been asked for yet
  | "break-held" // this caller holds the break mutex; the lock has not been re-read yet
  | "break-rechecked"; // the lock was re-read under the break mutex; nothing has been removed yet

export interface FileLockOptions {
  /** How long to wait for another writer before giving up. Default 10 s. */
  timeoutMs?: number;
  /**
   * A test seam, never set in production: awaited at each `LockStep`, so that a test can hold one caller
   * at a precise point while another runs and force an interleaving without sleeping and hoping.
   */
  onStep?: (step: LockStep) => void | Promise<void>;
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

type Probe =
  | { kind: "gone" }
  | { kind: "held"; info: LockInfo }
  | { kind: "corrupt" } // exists, but is not a lock record
  | { kind: "busy" }; // exists, but could not be read right now (a transient error)

/**
 * Tokens of locks this module published and then failed to remove. Only these are "leaked" locks of our
 * own: a lock of our pid whose token is not here is either live or was released a moment ago, and a waiter
 * that looked at it earlier must not mistake it for stale.
 */
const leaked = new Set<string>();

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
    // not JSON
  }
  return null;
}

async function probe(path: string): Promise<Probe> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "gone" };
    if (isTransientFsError(error)) return { kind: "busy" };
    throw error;
  }
  const info = parseInfo(text);
  return info === null ? { kind: "corrupt" } : { kind: "held", info };
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

function isStale(info: LockInfo): boolean {
  if (info.host !== hostname()) return false;
  if (info.pid === process.pid) return info.thread === threadId && leaked.has(info.token);
  return !pidIsRunning(info.pid);
}

function newInfo(token: string): LockInfo {
  return {
    pid: process.pid,
    thread: threadId,
    host: hostname(),
    token,
    at: new Date().toISOString(),
  };
}

/**
 * Writes the whole record under a temporary name next to `target` and syncs it to disk. Returns that name.
 * The sync comes BEFORE the link: otherwise a power cut right after the link could leave a lock whose name
 * is on disk and whose content is not, i.e. an empty lock, which is never removed automatically.
 */
async function writeTmp(target: string, info: LockInfo): Promise<string> {
  const tmp = `${target}.${info.token}.tmp`;
  const handle = await open(tmp, "wx");
  try {
    await handle.writeFile(JSON.stringify(info));
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return tmp;
}

async function dropTmp(tmp: string): Promise<void> {
  await unlink(tmp).catch(() => undefined);
}

function noHardLinks(target: string, code: string): LedgerError {
  return new LedgerError(
    `${displayPath(target)}: cannot publish the ledger lock: the file system refused a hard link (${code}): ` +
      "no hard links, or access denied (EACCES), for example by SELinux or an ACL. " +
      "The lock is published with a hard link so that it is never visible half written, and there is no " +
      "weaker fallback. Keep the ledger on a local disk whose file system supports hard links " +
      "(NTFS, ext4, APFS), not on FAT, exFAT or a network share, and check the directory's permissions.",
  );
}

async function nameIsInUse(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    if (isTransientFsError(error)) return true;
    throw error;
  }
}

/** Atomically gives `tmp`'s content the name `target`. False when the name is taken. */
async function linkInto(target: string, tmp: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await link(tmp, target);
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST" || code === "EBUSY") return false;
      if (code === "EPERM" || code === "EACCES") {
        // Windows answers like this for a name that is being deleted; a file system without hard links
        // (or a security rule that denies the link) answers like this for every link. Told apart by
        // whether the name is in use. The name can also be deleted between link's answer and our look at
        // it, which would look like "not in use" for a link that was only too early: so one more try.
        if (await nameIsInUse(target)) return false;
        if (attempt === 0) continue;
        throw noHardLinks(target, code);
      }
      if (code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "ENOSYS") {
        throw noHardLinks(target, code);
      }
      throw error;
    }
  }
}

function corruptError(lockPath: string): LedgerError {
  return new LedgerError(
    `${displayPath(lockPath)}: the lock file is empty or not a lock record. A held lock is published whole, ` +
      "so this is corruption and not a lock being written; it is not removed automatically. " +
      `If no ledger process is running, delete ${displayPath(lockPath)} and retry.`,
  );
}

type Blocker = { by: "lock"; seen: Probe } | { by: "break" };

function timeoutError(lockPath: string, timeoutMs: number, blocker: Blocker): LedgerError {
  if (blocker.by === "break") {
    const breakPath = displayPath(`${lockPath}.break`);
    return new LedgerError(
      `${breakPath}: could not take the lock-recovery mutex within ${timeoutMs} ms; a process that was ` +
        `breaking a stale ledger lock may have died holding it. If no ledger process is running, delete ${breakPath} and retry.`,
    );
  }
  const who =
    blocker.seen.kind === "held"
      ? `held by pid ${blocker.seen.info.pid} on ${blocker.seen.info.host} since ${blocker.seen.info.at}`
      : "in use by an owner that could not be identified";
  return new LedgerError(
    `${displayPath(lockPath)}: could not take the ledger lock within ${timeoutMs} ms; it is ${who}. ` +
      "If that process is gone, delete the lock file and retry.",
  );
}

type BreakOutcome = "removed" | "changed" | "blocked" | "busy";

/**
 * Removes the stale lock `observed`, if it is still there, still the same, and still provably stale, while
 * holding the break mutex. "removed" and "changed" mean: go and try to take the lock again at once.
 */
async function breakStale(
  lockPath: string,
  observed: LockInfo,
  step: (name: LockStep) => Promise<void>,
): Promise<BreakOutcome> {
  const breakPath = `${lockPath}.break`;
  const info = newInfo(randomUUID());
  const tmp = await writeTmp(breakPath, info);
  try {
    if (!(await linkInto(breakPath, tmp))) return "blocked";
    try {
      await step("break-held");
      const again = await probe(lockPath);
      if (again.kind === "busy") return "busy";
      await step("break-rechecked");
      if (again.kind === "held" && again.info.token === observed.token && isStale(again.info)) {
        try {
          await rm(lockPath, { force: true });
        } catch (error) {
          if (isTransientFsError(error)) return "busy";
          throw error;
        }
        return "removed";
      }
      // Gone, replaced by someone else's lock, or not a lock record at all (the caller finds that out and
      // reports it): not ours to touch.
      return "changed";
    } finally {
      await releaseOwned(breakPath, info.token).catch(() => undefined);
    }
  } finally {
    await dropTmp(tmp);
  }
}

async function acquire(
  lockPath: string,
  timeoutMs: number,
  onStep: FileLockOptions["onStep"],
): Promise<string> {
  const step = async (name: LockStep): Promise<void> => {
    await onStep?.(name);
  };
  await ensureDirectory(dirname(lockPath));
  const info = newInfo(randomUUID());
  const deadline = Date.now() + timeoutMs;
  const tmp = await writeTmp(lockPath, info);
  try {
    await step("tmp-written");
    let delay = 2;
    for (;;) {
      if (await linkInto(lockPath, tmp)) {
        try {
          await step("published");
        } catch (error) {
          await releaseOwned(lockPath, info.token).catch(() => undefined);
          throw error;
        }
        return info.token;
      }
      const seen = await probe(lockPath);
      if (seen.kind === "corrupt") throw corruptError(lockPath);
      let blocker: Blocker = { by: "lock", seen };
      // "gone" (the lock was released since link said the name was taken, or link said busy while there is
      // no lock, as it does while antivirus holds the temporary file) takes the normal backoff below, so
      // it is never a tight loop; it is still bounded by the deadline.
      if (seen.kind === "held" && isStale(seen.info)) {
        await step("stale-seen");
        const outcome = await breakStale(lockPath, seen.info, step);
        if ((outcome === "removed" || outcome === "changed") && Date.now() < deadline) continue;
        if (outcome === "blocked") blocker = { by: "break" };
      }
      if (Date.now() >= deadline) throw timeoutError(lockPath, timeoutMs, blocker);
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_POLL_MS);
    }
  } finally {
    await dropTmp(tmp);
  }
}

/**
 * Removes `path` if, and only if, it still carries `token`. A transient read or remove error is retried; if
 * it is still failing after the last try, the token is recorded as leaked (this process may then break the
 * file when it next meets it) and nothing is thrown. Any other error is thrown, after recording the token.
 */
async function releaseOwned(path: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
    let seen: Probe;
    try {
      seen = await probe(path);
    } catch (error) {
      leaked.add(token);
      throw error;
    }
    if (seen.kind === "busy") {
      await sleep(20 * (attempt + 1));
      continue;
    }
    // Gone, or taken over, or not a record: never delete a file that is not provably ours.
    if (seen.kind !== "held" || seen.info.token !== token) return;
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      if (!isTransientFsError(error)) {
        leaked.add(token);
        throw error;
      }
      await sleep(20 * (attempt + 1));
    }
  }
  leaked.add(token); // still unreadable or undeletable after every retry
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
  const token = await acquire(
    lockPath,
    options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    options.onStep,
  );
  try {
    return await task();
  } finally {
    await releaseOwned(lockPath, token).catch(() => undefined);
  }
}
