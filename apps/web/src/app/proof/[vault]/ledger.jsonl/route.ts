import { isNearAccountId } from "@probarion/core";
import { serviceDb } from "@/lib/db/clients";
import { clientIp, problem, rateLimitOr429 } from "@/lib/http";
import { proofDeps } from "@/lib/proof/deps";
import { ledgerResponse } from "@/lib/proof/ledger-file";
import { loadLedger } from "@/lib/proof/service";
import { LIMITS } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The vault's signed ledger, served here at /proof/<vault>/ledger.jsonl and saved as probarion-<vault>-ledger.jsonl
 * (`ledgerFileName`), the file the proof page's commands pass as `--ledger`: a download that works in every shell,
 * instead of a recipe for cutting it out of snapshot.json. The same access rules, id validation and rate limit
 * (`LIMITS.snapshot`) as snapshot.json. It reads the database only, never the chain.
 */
export async function GET(req: Request, { params }: { params: Promise<{ vault: string }> }) {
  const { vault } = await params;
  if (!isNearAccountId(vault)) return problem(404, "not_found");
  const limited = await rateLimitOr429(
    serviceDb(),
    `ledger:${clientIp(req.headers)}`,
    LIMITS.snapshot,
  );
  if (limited) return limited;
  const r = await loadLedger(await proofDeps(), vault);
  if (r.status === "not_found") return problem(404, "not_found");
  if (r.status === "error") return problem(503, "unavailable");
  return ledgerResponse(r);
}
