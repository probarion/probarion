import { open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LedgerEntry, LedgerEntryBody } from "@probarion/core";
import { envValue } from "./env.js";
import { LedgerError } from "./errors.js";
import { buildNextEntry, type LedgerAppendBody } from "./ledger-store-chain.js";
import { DEFAULT_LOCK_TIMEOUT_MS, displayPath, withFileLock } from "./ledger-store-lock.js";
import { Mutex } from "./mutex.js";

export { composeBody, type LedgerAppendBody } from "./ledger-store-chain.js";

export interface LedgerStore {
  head(): Promise<LedgerEntry | null>;
  append(
    body: Omit<LedgerEntryBody, "seq" | "prev_link">,
    sign: (bodyHash: Uint8Array) => Promise<{ sig: string; signer: string }>,
  ): Promise<LedgerEntry>;
  all(): Promise<LedgerEntry[]>;
}

/** Appends are serialized, validated against the head (seq, prev_link, vault) and signed by `sign`. */
export class InMemoryLedgerStore implements LedgerStore {
  private readonly entries: LedgerEntry[];
  private readonly lock = new Mutex();

  constructor(initial: readonly LedgerEntry[] = []) {
    this.entries = initial.map((entry) => structuredClone(entry));
  }

  async head(): Promise<LedgerEntry | null> {
    const last = this.entries.at(-1);
    return last === undefined ? null : structuredClone(last);
  }

  append(
    body: LedgerAppendBody,
    sign: (bodyHash: Uint8Array) => Promise<{ sig: string; signer: string }>,
  ): Promise<LedgerEntry> {
    return this.lock.run(async () => {
      const entry = await buildNextEntry(
        this.entries.at(-1) ?? null,
        body,
        sign,
        "the in-memory ledger",
      );
      this.entries.push(entry);
      return structuredClone(entry);
    });
  }

  async all(): Promise<LedgerEntry[]> {
    return this.entries.map((entry) => structuredClone(entry));
  }
}

const DEFAULT_LEDGER_FILE = ".probarion/ledger.jsonl";

/**
 * The ledger path from the environment: `PROBARION_LEDGER_PATH`, where an empty or blank value counts as
 * unset (R12; `.env.example` ships `PROBARION_LEDGER_PATH=`), else `fallback`.
 */
export function ledgerPathFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  fallback: string = DEFAULT_LEDGER_FILE,
): string {
  return envValue(env, "PROBARION_LEDGER_PATH") ?? fallback;
}

export interface FileLedgerStoreOptions {
  /** How long an append (or a read that meets a half-written tail) waits for another writer. Default 10 s. */
  lockTimeoutMs?: number;
}

interface LoadedLedger {
  entries: LedgerEntry[];
  /** Line number (1-based) of the last entry, null for an empty ledger. */
  headLine: number | null;
  exists: boolean;
  /** Size of the file as read; a failed append truncates back to it. */
  byteLength: number;
  /** False when the last line lacks its "\n" (the next append supplies it). True for an empty file. */
  endsWithNewline: boolean;
  /** Line number of a torn last line (no trailing newline, not valid JSON); null when there is none. */
  torn: number | null;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

const NEWLINE = 0x0a;

/**
 * JSONL ledger: one entry per line, each line a complete `JSON.stringify(entry)` plus "\n".
 *
 * - Append is one `write` to an O_APPEND handle followed by `fsync` before the call returns, under an
 *   exclusive lock file (`<path>.lock`, see `ledger-store-lock.ts`), so two processes never interleave
 *   bytes or both extend the same head. A failed write or flush truncates the file back to its size
 *   before the attempt.
 * - A crash can still leave a half line. A last line without its newline that is not valid JSON is a torn
 *   write: `all()`, `head()` and `append()` refuse it with an error naming the line. Nothing is dropped,
 *   skipped or repaired; the operator inspects the file. A last line that is valid JSON but lacks its
 *   newline is a whole entry and is read; the next append writes the newline first.
 * - A line that is not valid JSON, not UTF-8, or not a JSON object is a `LedgerError` naming the line.
 * - `all()` does not check the chain (that is the verifier's job); `append()` does, against the head.
 * - A missing file is an empty ledger. Local file systems only.
 */
export class FileLedgerStore implements LedgerStore {
  readonly path: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly mutex = new Mutex();

  /** An empty or blank `path` counts as unset (R12) and gives the default. */
  constructor(path: string = DEFAULT_LEDGER_FILE, options: FileLedgerStoreOptions = {}) {
    this.path = path.trim() === "" ? DEFAULT_LEDGER_FILE : path;
    this.lockPath = `${this.path}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  async all(): Promise<LedgerEntry[]> {
    const first = await this.load();
    if (first.torn === null) return first.entries;
    // A tail without its newline is either a crash or an append that is still being written, by another
    // process or by another store object in this one. Wait for any writer to finish, then look again.
    // If we cannot take the lock (a writer that never finishes, a read-only directory), report the tail.
    let locked = false;
    try {
      return await withFileLock(
        this.lockPath,
        async () => {
          locked = true;
          const second = await this.load();
          if (second.torn !== null) throw this.tornError(second.torn);
          return second.entries;
        },
        { timeoutMs: this.lockTimeoutMs },
      );
    } catch (error) {
      if (locked) throw error; // the second look failed on its own terms: report that
      throw this.tornError(first.torn); // never got the lock: all we know is the tail we saw
    }
  }

  async head(): Promise<LedgerEntry | null> {
    return (await this.all()).at(-1) ?? null;
  }

  append(
    body: LedgerAppendBody,
    sign: (bodyHash: Uint8Array) => Promise<{ sig: string; signer: string }>,
  ): Promise<LedgerEntry> {
    return this.mutex.run(() =>
      withFileLock(
        this.lockPath,
        async () => {
          const loaded = await this.load();
          if (loaded.torn !== null) throw this.tornError(loaded.torn);
          const shown = displayPath(this.path);
          const where = loaded.headLine === null ? shown : `${shown} line ${loaded.headLine}`;
          const entry = await buildNextEntry(loaded.entries.at(-1) ?? null, body, sign, where);
          await this.writeLine(loaded, JSON.stringify(entry));
          return entry;
        },
        { timeoutMs: this.lockTimeoutMs },
      ),
    );
  }

  private tornError(line: number): LedgerError {
    return new LedgerError(
      `${displayPath(this.path)}: line ${line} is a torn write: it has no trailing newline and is not valid JSON, ` +
        "which is what an interrupted append (or one still in progress) leaves behind. " +
        "Nothing was dropped or repaired and nothing will be appended. " +
        "If no writer is running, inspect the file and remove the partial last line by hand.",
    );
  }

  private async load(): Promise<LoadedLedger> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      if (isNotFound(error)) {
        return {
          entries: [],
          headLine: null,
          exists: false,
          byteLength: 0,
          endsWithNewline: true,
          torn: null,
        };
      }
      throw error;
    }
    return this.parse(bytes);
  }

  private parse(bytes: Buffer): LoadedLedger {
    const shown = displayPath(this.path);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const entries: LedgerEntry[] = [];
    let headLine: number | null = null;
    let torn: number | null = null;
    let lineNo = 0;
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(NEWLINE, start);
      const terminated = newline !== -1;
      const end = terminated ? newline : bytes.length;
      const raw = bytes.subarray(start, end);
      start = end + 1;
      lineNo += 1;

      let text: string;
      try {
        text = decoder.decode(raw);
      } catch {
        if (!terminated) {
          torn = lineNo;
          break;
        }
        throw new LedgerError(`${shown}: line ${lineNo} is not valid UTF-8`);
      }
      const trimmed = text.trim();
      if (trimmed === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        if (!terminated) {
          torn = lineNo;
          break;
        }
        throw new LedgerError(`${shown}: line ${lineNo} is not valid JSON`);
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new LedgerError(
          `${shown}: line ${lineNo} is not a JSON object (one ledger entry per line)`,
        );
      }
      entries.push(value as LedgerEntry);
      headLine = lineNo;
    }
    return {
      entries,
      headLine,
      exists: true,
      byteLength: bytes.length,
      endsWithNewline: bytes.length === 0 || bytes[bytes.length - 1] === NEWLINE,
      torn,
    };
  }

  /** Called under the lock, with the ledger as just read. Durable when it returns. */
  private async writeLine(loaded: LoadedLedger, line: string): Promise<void> {
    // One buffer, one write. A missing newline at the end of the file (a whole entry that lost only its
    // terminator) is supplied here, in the same write, so two entries never end up on one line.
    const data = Buffer.from(`${loaded.endsWithNewline ? "" : "\n"}${line}\n`, "utf8");
    const handle = await open(this.path, "a");
    let failure: { error: unknown } | null = null;
    try {
      await handle.writeFile(data);
      await handle.sync();
    } catch (error) {
      failure = { error };
    }
    await handle.close().catch(() => undefined);
    if (failure !== null) {
      await this.rollback(loaded.byteLength);
      throw failure.error;
    }
    if (!loaded.exists) await syncDirectory(dirname(this.path));
  }

  /** Best effort. If it fails too, the half line stays and the next read reports it as torn. */
  private async rollback(size: number): Promise<void> {
    try {
      const handle = await open(this.path, "r+");
      try {
        await handle.truncate(size);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // see above
    }
  }
}

/** Makes a newly created file's directory entry durable. Windows cannot open a directory: best effort. */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // not supported here
  }
}
