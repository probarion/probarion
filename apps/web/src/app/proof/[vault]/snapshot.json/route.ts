import { isNearAccountId } from "@probarion/core";
import { serviceDb } from "@/lib/db/clients";
import { clientIp, problem, rateLimitOr429 } from "@/lib/http";
import { proofDeps } from "@/lib/proof/deps";
import { loadProof } from "@/lib/proof/service";
import { snapshotResponse } from "@/lib/proof/snapshot-file";
import { LIMITS } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * A snapshot of the vault (its ledger and chain data), for `npx probarion verify --offline <file>` (interfaces §11).
 * Same access rules as the page. While the page's result is in this instance's 60 s cache, it is the very snapshot the
 * page checked; after that, or on another instance, it is a freshly gathered one. The page says so: the verifier
 * prints the snapshot's taken_at, and its result matches the page unless the vault changed in between. An id that is
 * not a NEAR account is a 404 before any database or RPC call, so only a validated id reaches the file name.
 */
export async function GET(req: Request, { params }: { params: Promise<{ vault: string }> }) {
  const { vault } = await params;
  if (!isNearAccountId(vault)) return problem(404, "not_found");
  const limited = await rateLimitOr429(
    serviceDb(),
    `snapshot:${clientIp(req.headers)}`,
    LIMITS.snapshot,
  );
  if (limited) return limited;
  const r = await loadProof(await proofDeps(), vault);
  if (r.status === "not_found") return problem(404, "not_found");
  if (r.status === "error") return problem(503, "unavailable");
  return snapshotResponse(r);
}
