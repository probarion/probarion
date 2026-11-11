import { isNearAccountId } from "@probarion/core";
import { serviceDb } from "@/lib/db/clients";
import { clientIp, problem, rateLimitOr429 } from "@/lib/http";
import { log } from "@/lib/log";
import { requestNetwork } from "@/lib/network";
import { cachedDecisionRows } from "@/lib/proof/decision-cache";
import type { DecisionRow } from "@/lib/proof/decisions";
import { proofDeps } from "@/lib/proof/deps";
import { paymentsCsvResponse } from "@/lib/proof/payments-csv";
import { loadProof } from "@/lib/proof/service";
import { LIMITS } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The vault's payments as a CSV file, one row per decision of its ledger, newest first, joined to its payment entry
 * and to its spend's status on chain (lib/proof/payments-csv.ts), saved as <vault>-payments-<capture time>.csv. It
 * loads the proof as snapshot.json does, with the same loader, access rules (public, or a member of the vault, on the
 * network of this address), id validation and rate limit (`LIMITS.snapshot`, with its own bucket key, as ledger.jsonl
 * has), and builds its rows with the function that builds the page's Decisions cards (cachedDecisionRows). The
 * snapshot is this route's own, as snapshot.json's is: it can be older or newer than the page's, since the page and
 * this route run in separate runtimes with separate caches, so on a vault that acted in between the file can hold more
 * rows, or other statuses, than the cards on screen. Its taken_at is in the file name and in the Chain read column, to
 * compare with the page's "snapshot taken" line. An id that is not a NEAR account is a 404 before any database or RPC
 * call. A limiter or load that throws is a 503, as a failed load is, and so are decision rows that cannot be built.
 */
export async function GET(req: Request, { params }: { params: Promise<{ vault: string }> }) {
  const { vault } = await params;
  if (!isNearAccountId(vault)) return problem(404, "not_found");
  let r: Awaited<ReturnType<typeof loadProof>>;
  try {
    const limited = await rateLimitOr429(
      serviceDb(),
      `payments:${clientIp(req.headers)}`,
      LIMITS.snapshot,
    );
    if (limited) return limited;
    r = await loadProof(await proofDeps(await requestNetwork()), vault);
  } catch (error) {
    log.warn("proof.unavailable", {
      vault,
      reason: "database",
      error: error instanceof Error ? error.message : String(error),
    });
    return problem(503, "unavailable");
  }
  if (r.status === "not_found") return problem(404, "not_found");
  if (r.status === "error") return problem(503, "unavailable");
  let rows: DecisionRow[];
  try {
    rows = await cachedDecisionRows(r.snapshot, r.network);
  } catch (error) {
    log.warn("proof.decisions_unavailable", {
      vault,
      error: error instanceof Error ? error.message : String(error),
    });
    return problem(503, "unavailable");
  }
  return paymentsCsvResponse(r, rows);
}
