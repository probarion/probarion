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
 * A snapshot of the vault (its ledger and chain data), for `probarion verify --offline <file>` (interfaces §11), with
 * the page's access rules. It is this route's own snapshot: one it gathered up to 60 s ago, or a fresh one. It is not
 * guaranteed to be the page's. In the production build the page and this route run in separate runtimes with separate
 * caches, and instances differ too, so the page asks the visitor to compare the taken_at the verifier prints with its
 * own. An id that is not a NEAR account is a 404 before any database or RPC call, so only a validated id reaches the
 * file name.
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
