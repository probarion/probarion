import type { Snapshot } from "@probarion/core";
import type { ProofOk } from "./service";

/** The snapshot as `probarion verify --snapshot` writes it: two-space JSON and a final newline. */
export function snapshotFileText(snapshot: Snapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** The download's file name. `vault` is a validated NEAR account id, so it needs no quoting. */
export function snapshotFileName(vault: string): string {
  return `probarion-${vault}-snapshot.json`;
}

/**
 * The snapshot.json download, for `probarion verify --offline <file>` (see ./cli.ts for how the site writes it). A public vault's file may be cached for
 * the same 60 s the page's result is; a member's view of a private vault is never stored by anyone.
 */
export function snapshotResponse(r: ProofOk): Response {
  return new Response(snapshotFileText(r.snapshot), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${snapshotFileName(r.vault)}"`,
      "cache-control": r.audience === "public" ? "public, max-age=60" : "private, no-store",
    },
  });
}
