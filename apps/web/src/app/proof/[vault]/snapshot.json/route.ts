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
 * The snapshot the proof page checked, for `npx probarion verify --offline <file>` (interfaces §11). Same access
 * rules and the same 60 s result as the page. An id that is not a NEAR account is a 404 before any database or RPC
 * call, so only a validated id ever reaches the file name.
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
