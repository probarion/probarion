import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type MandateView, sha256Hex } from "@probarion/core";
import { CASES, type EvalCase } from "./cases";
import {
  EVAL_AGENT_PK,
  EVAL_DAILY_BACKSTOP,
  EVAL_INTENTS_BALANCE,
  EVAL_NOW,
  EVAL_VAULT,
  evalMandates,
  PURPOSES,
  type PurposeId,
} from "./mandates";
import { evalPdf } from "./pdf";

// The committed dataset under eval/: the invoices, the purpose documents and cases.json, all generated from
// cases.ts and mandates.ts. `generate` writes them; `check` says which committed file differs from what the
// generator gives now. The runner reads the committed files, never the generator, so it runs on exactly the bytes
// a reader of the repository sees.

/** The repository root (this file is apps/web/src/lib/eval/dataset.ts). */
export const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** The bytes of a purpose document. */
export const purposeBytes = (id: PurposeId): Uint8Array => new TextEncoder().encode(PURPOSES[id]);

/** sha256 of a purpose document's exact bytes: the purpose_hash of its mandate. */
export const purposeHash = (id: PurposeId): string => sha256Hex(purposeBytes(id));

/** The eval's mandates as the chain would show them before any case. */
export const baseMandates = (): MandateView[] => evalMandates(purposeHash);

/** The bytes of a case's invoice file. */
export function renderInvoice(c: EvalCase): Uint8Array {
  return c.content.kind === "text"
    ? new TextEncoder().encode(c.content.text)
    : evalPdf(c.content.items);
}

export const invoicePath = (c: Pick<EvalCase, "file">): string => `eval/invoices/${c.file}`;
export const purposePath = (id: PurposeId): string => `eval/purpose/${id}.txt`;
export const CASES_JSON = "eval/cases.json";

/** cases.json: what each case is and expects, the fixed chain state, and the sha256 of each committed file. */
export function casesJson(cases: readonly EvalCase[] = CASES): string {
  const doc = {
    v: 1,
    note: "Generated from apps/web/src/lib/eval/cases.ts and mandates.ts by `pnpm --filter @probarion/web eval:generate`. Synthetic test data: no vendor, account or address here is real, and nothing is ever sent.",
    vault: EVAL_VAULT,
    now: EVAL_NOW.toISOString(),
    agent_pk: EVAL_AGENT_PK,
    daily_backstop: EVAL_DAILY_BACKSTOP,
    intents_balance: EVAL_INTENTS_BALANCE.toString(),
    purposes: (Object.keys(PURPOSES) as PurposeId[]).map((id) => ({
      id,
      file: purposePath(id),
      sha256: purposeHash(id),
    })),
    mandates: baseMandates(),
    cases: cases.map((c) => ({
      id: c.id,
      category: c.category,
      title: c.title,
      file: invoicePath(c),
      media_type: c.content.kind === "text" ? "text/plain" : "application/pdf",
      file_sha256: sha256Hex(renderInvoice(c)),
      purpose: c.purpose,
      expect: c.expect,
      attack: c.attack,
      prior: c.prior,
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Every dataset file, by its path from the repository root. */
export function datasetFiles(cases: readonly EvalCase[] = CASES): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const id of Object.keys(PURPOSES) as PurposeId[])
    files.set(purposePath(id), purposeBytes(id));
  for (const c of cases) files.set(invoicePath(c), renderInvoice(c));
  files.set(CASES_JSON, new TextEncoder().encode(casesJson(cases)));
  return files;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The paths whose committed bytes differ from `files` (or are missing), in order. */
export function driftedFiles(root: string, files: ReadonlyMap<string, Uint8Array>): string[] {
  const out: string[] = [];
  for (const [path, bytes] of files) {
    const at = join(root, path);
    if (!existsSync(at) || !sameBytes(new Uint8Array(readFileSync(at)), bytes)) out.push(path);
  }
  return out;
}

/** Writes `files` under `root`. */
export function writeFiles(root: string, files: ReadonlyMap<string, Uint8Array | string>): void {
  for (const [path, body] of files) {
    const at = join(root, path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, body);
  }
}
