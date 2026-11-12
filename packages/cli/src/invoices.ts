import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type KnownSystemPrompt,
  knownSystemPrompt,
  type LedgerEntry,
  sha256Hex,
} from "@probarion/core";
import type { LedgerStore } from "@probarion/sdk";
import { UsageError } from "./errors.js";

/**
 * One invoice text that `verify --invoice` or `--invoices` read, for A8. `text` goes to A8 and nowhere else: not
 * to the network, not into a snapshot, not into the report. The report shows `file` and `sha256` only.
 */
export interface InvoiceFile {
  /** The path as the reader gave it (`--invoices <dir>` adds `/<name>`), for the report. */
  file: string;
  /** The sha256 of the file's bytes: the invoice_hash of the decision this is the invoice of (ICR-3b). */
  sha256: string;
  text: string;
}

/** An invoice file and the ledger entries whose invoice_hash is its sha256 (by position, as check e names them). */
export interface InvoiceMatch {
  file: string;
  sha256: string;
  /** Every ledger entry with this invoice_hash. */
  seqs: number[];
  /**
   * Of those, the attested decisions (evidence, not rules-only): the ones this file is the invoice of. Check e runs
   * A8 on each of them when it passes; it stops at its first broken seq, so when it fails A8 may not reach them.
   */
  attestedSeqs: number[];
}

/** `--invoices <dir>` reads the files of the folder whose name ends in .txt, not its subfolders. */
const INVOICE_FILE = /\.txt$/i;

/**
 * The text of one invoice or system prompt file, which must be UTF-8: A8 hashes the text, so it must re-encode to
 * exactly the bytes that were read. A BOM stays in the text, as the SDK's `hashInvoice` keeps it. Unreadable or not
 * UTF-8 text is a usage error (exit 64), before any network read; `hint` says what to pass instead.
 */
async function readText(
  path: string,
  label: string,
  file: string,
  hint = "pass the extracted invoice text, the text the model was shown",
): Promise<InvoiceFile> {
  let bytes: Uint8Array;
  try {
    if (!(await stat(path)).isFile()) throw new Error("not a file");
    bytes = new Uint8Array(await readFile(path));
  } catch {
    throw new UsageError(`${label} is not a readable file`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new UsageError(`${label} is not UTF-8 text: ${hint}`);
  }
  return { file, sha256: sha256Hex(bytes), text };
}

/**
 * Every invoice file `--invoice` and `--invoices` name, each once, in the order given; a folder's files by name.
 * A missing or unreadable file or folder, a folder with no .txt file, and a file that is not UTF-8 text are usage
 * errors (exit 64).
 */
export async function readInvoiceFiles(
  cwd: string,
  files: readonly string[],
  dirs: readonly string[],
): Promise<InvoiceFile[]> {
  const out: InvoiceFile[] = [];
  const seen = new Set<string>();
  const add = async (path: string, label: string, file: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push(await readText(path, label, file));
  };
  for (const given of files) {
    if (given.trim() === "") throw new UsageError("--invoice needs a file");
    await add(resolve(cwd, given), `--invoice ${given}`, given);
  }
  for (const given of dirs) {
    if (given.trim() === "") throw new UsageError("--invoices needs a directory");
    const dir = resolve(cwd, given);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      throw new UsageError(`--invoices ${given} is not a readable directory`);
    }
    // A symbolic link counts as the file it points to; one to a folder is skipped like a subfolder, and a broken
    // one is read, so that it is a usage error rather than a file left out without a word.
    const names: string[] = [];
    for (const e of entries) {
      if (!INVOICE_FILE.test(e.name)) continue;
      if (e.isFile() || (e.isSymbolicLink() && !(await isFolder(join(dir, e.name))))) {
        names.push(e.name);
      }
    }
    names.sort();
    if (names.length === 0) throw new UsageError(`--invoices ${given} holds no .txt file`);
    // Shown as given plus "/<name>", the same on every platform.
    const prefix = given.replace(/[\\/]+$/, "");
    for (const name of names) {
      await add(resolve(dir, name), `--invoices ${given}: ${name}`, `${prefix}/${name}`);
    }
  }
  return out;
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The system prompts `--system-prompt` names, for A8's allow-list, each by the file as given. A8 accepts the
 * standard prompt (`PROPOSAL_SYSTEM_PROMPT`) without them; these extend the list, never replace it. Each file must be
 * the prompt's exact text, so a missing, unreadable, empty or not UTF-8 file is a usage error (exit 64).
 */
export async function readSystemPrompts(
  cwd: string,
  files: readonly string[],
): Promise<KnownSystemPrompt[]> {
  const out: KnownSystemPrompt[] = [];
  for (const given of files) {
    if (given.trim() === "") throw new UsageError("--system-prompt needs a file");
    const label = `--system-prompt ${given}`;
    const prompt = await readText(
      resolve(cwd, given),
      label,
      given,
      "pass the exact text of the prompt",
    );
    if (prompt.text === "") throw new UsageError(`${label} is empty`);
    out.push(knownSystemPrompt(given, prompt.text));
  }
  return out;
}

/** The texts by sha256, as `runChecks` and the SDK's `verify` take `invoiceTexts`. Equal bytes give one entry. */
export function invoiceTexts(files: readonly InvoiceFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.sha256, f.text]));
}

/** Each file with the ledger entries whose invoice_hash is its sha256, and which of them are attested decisions. */
export function matchInvoices(
  files: readonly InvoiceFile[],
  ledger: readonly LedgerEntry[],
): InvoiceMatch[] {
  return files.map((f) => {
    const seqs: number[] = [];
    const attestedSeqs: number[] = [];
    ledger.forEach((entry, i) => {
      const body = entry?.body;
      if (body?.invoice_hash !== f.sha256) return;
      seqs.push(i);
      // As check e counts them: evidence, and not decided by the rules alone.
      const attested =
        body.evidence !== null && body.evidence !== undefined && body.decided_by !== "rules-only";
      if (attested) attestedSeqs.push(i);
    });
    return { file: f.file, sha256: f.sha256, seqs, attestedSeqs };
  });
}

/**
 * A read-only view of `store` that keeps the entries of its last `all()`: the ledger the SDK verified, so that the
 * invoice files are matched against those entries, not a second read of the file.
 */
export function recordingLedger(store: LedgerStore): {
  ledger: LedgerStore;
  read: () => readonly LedgerEntry[];
} {
  let entries: readonly LedgerEntry[] = [];
  return {
    ledger: {
      head: () => store.head(),
      append: (body, sign, opts) => store.append(body, sign, opts),
      all: async () => {
        const all = await store.all();
        entries = all;
        return all;
      },
    },
    read: () => entries,
  };
}
