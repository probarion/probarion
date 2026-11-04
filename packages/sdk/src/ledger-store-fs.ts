// File-system helpers shared by the ledger store and its lock.
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * A failure that means "in use right now, try again": EBUSY everywhere, and on Windows also EPERM and
 * EACCES (a file that is open elsewhere, or deleted but still open). Read at call time, not import time.
 */
export function isTransientFsError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "EBUSY") return true;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES");
}

/** What `fsync` on a directory says on file systems (and Windows) that cannot do it. Anything else is real. */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EINVAL"]);

/**
 * Makes the directory entries inside `dir` durable (a new file's name, a new subdirectory's name). Where
 * the platform cannot sync a directory (EISDIR, EPERM, EINVAL; Windows is one) this does nothing. Any
 * other error, such as EIO, is thrown: it means the names may not survive a crash.
 */
export async function syncDirectory(dir: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(dir, "r");
  } catch (error) {
    if (DIRECTORY_SYNC_UNSUPPORTED.has(errorCode(error) ?? "")) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(errorCode(error) ?? "")) throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * On Windows `mkdir({ recursive: true })` reports the first directory it made as `\\?\C:\...` (or
 * `\\?\UNC\server\share\...`), which never equals the path we passed in. Drop the prefix so
 * the two can be compared.
 */
export function withoutNamespacePrefix(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

/**
 * `mkdir -p`, and for every directory it had to create, a sync of the directory that now holds its name,
 * so that a ledger directory created by the first append is still there after a power cut.
 */
export async function ensureDirectory(dir: string): Promise<void> {
  const created = await mkdir(dir, { recursive: true });
  if (created === undefined) return; // it existed: nothing new to make durable
  // The paths are only known at run time. The hint keeps a bundler (Next.js Turbopack) from tracing a whole app
  // into its output because of them; it is a comment, so nothing else changes.
  const first = resolve(/* turbopackIgnore: true */ withoutNamespacePrefix(created));
  let current = resolve(/* turbopackIgnore: true */ dir);
  for (;;) {
    const parent = dirname(current);
    await syncDirectory(parent);
    // `relative` is "" for the same directory, and compares case-insensitively where the file system does.
    if (relative(current, first) === "" || parent === current) return;
    current = parent;
  }
}
