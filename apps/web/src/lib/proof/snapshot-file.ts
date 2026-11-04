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
 * The snapshot.json download, for `probarion verify --offline <file>` (./cli.ts writes the command). A browser does
 * not reuse it: each click asks the route again (ruling W-T16-R3), so the file is the route's current snapshot. A
 * member's view of a private vault is never stored by anyone.
 */
export function snapshotResponse(r: ProofOk): Response {
  return new Response(snapshotFileText(r.snapshot), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${snapshotFileName(r.vault)}"`,
      "cache-control":
        r.audience === "public" ? "private, max-age=0, must-revalidate" : "private, no-store",
    },
  });
}
