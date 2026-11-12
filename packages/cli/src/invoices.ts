import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type LedgerEntry, sha256Hex } from "@probarion/core";
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
  /** Of those, the attested decisions (evidence, not rules-only): the ones A8 checks against this file. */
  a8Seqs: number[];
}

/** `--invoices <dir>` reads the files of the folder whose name ends in .txt, not its subfolders. */
const INVOICE_FILE = /\.txt$/i;

/**
 * The text of one invoice file, which must be UTF-8: A8 hashes the text, so it must re-encode to exactly the bytes
 * that were read. A BOM stays in the text, as the SDK's `hashInvoice` keeps it. Unreadable or not UTF-8 text is a
 * usage error (exit 64), before any network read.
 */
async function readInvoice(path: string, label: string, file: string): Promise<InvoiceFile> {
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
    throw new UsageError(
      `${label} is not UTF-8 text: pass the extracted invoice text, the text the model was shown`,
    );
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
    out.push(await readInvoice(path, label, file));
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
    const names = entries
      .filter((e) => e.isFile() && INVOICE_FILE.test(e.name))
      .map((e) => e.name)
      .sort();
    if (names.length === 0) throw new UsageError(`--invoices ${given} holds no .txt file`);
    // Shown as given plus "/<name>", the same on every platform.
    const prefix = given.replace(/[\\/]+$/, "");
    for (const name of names) {
      await add(resolve(dir, name), `--invoices ${given}: ${name}`, `${prefix}/${name}`);
    }
  }
  return out;
}

/** The texts by sha256, as `runChecks` and the SDK's `verify` take `invoiceTexts`. Equal bytes give one entry. */
export function invoiceTexts(files: readonly InvoiceFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.sha256, f.text]));
}

/** Each file with the ledger entries whose invoice_hash is its sha256, and which of them A8 checks. */
export function matchInvoices(
  files: readonly InvoiceFile[],
  ledger: readonly LedgerEntry[],
): InvoiceMatch[] {
  return files.map((f) => {
    const seqs: number[] = [];
    const a8Seqs: number[] = [];
    ledger.forEach((entry, i) => {
      const body = entry?.body;
      if (body?.invoice_hash !== f.sha256) return;
      seqs.push(i);
      const attested =
        body.kind === "decision" &&
        body.evidence !== null &&
        body.evidence !== undefined &&
        body.decided_by !== "rules-only";
      if (attested) a8Seqs.push(i);
    });
    return { file: f.file, sha256: f.sha256, seqs, a8Seqs };
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
