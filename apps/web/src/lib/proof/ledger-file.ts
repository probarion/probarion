import type { LedgerEntry } from "@probarion/core";
import type { LedgerOk } from "./service";

/**
 * The ledger as `probarion verify --ledger ledger.jsonl` reads it: one entry per line, each `JSON.stringify(entry)`,
 * the same line the SDK's FileLedgerStore writes.
 */
export function ledgerFileText(entries: readonly LedgerEntry[]): string {
  return entries.map((e) => `${JSON.stringify(e)}\n`).join("");
}

/**
 * The ledger.jsonl download, named exactly as the page's commands use it. A browser does not reuse it (each click asks
 * again); a member's view of a private vault is never stored by anyone.
 */
export function ledgerResponse(r: LedgerOk): Response {
  return new Response(ledgerFileText(r.entries), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": 'attachment; filename="ledger.jsonl"',
      "cache-control":
        r.audience === "public" ? "private, max-age=0, must-revalidate" : "private, no-store",
    },
  });
}
