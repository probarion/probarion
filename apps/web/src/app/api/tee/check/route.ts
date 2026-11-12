import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { json, problem, rateLimitOr429 } from "@/lib/http";
import { log } from "@/lib/log";
import { LIMITS } from "@/lib/ratelimit";
import { checkTee, teeCheckModels } from "@/lib/tee/check";
import { isTeeNonce } from "@/lib/tee/recheck";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The check answers within TEE_CHECK_BUDGET_MS (24 s): this leaves room for the rate limit and the answer.
export const maxDuration = 30;

/**
 * The proof page's live TEE check: `?nonce=<64 lowercase hex>`, drawn by the visitor's browser, in; the checks and
 * the few values the browser re-checks out (lib/tee/check.ts). Public, no session. Its one database write is the rate
 * limit's: one bucket for all visitors together, whose row holds only the bucket name, the window's start time and a
 * count (rate_limits), so nothing about a visitor is stored. The nonce and the answer are not logged.
 */
export async function GET(req: Request): Promise<Response> {
  const nonces = new URL(req.url).searchParams.getAll("nonce");
  const nonce = nonces.length === 1 ? nonces[0] : undefined;
  if (!isTeeNonce(nonce)) {
    return problem(400, "invalid_input", "Send one nonce: 64 lowercase hex characters.");
  }
  let models: readonly string[];
  try {
    const limited = await rateLimitOr429(serviceDb(), "tee:check", LIMITS.teeCheck);
    if (limited) return limited;
    models = teeCheckModels(getEnv().NEARAI_MODEL);
  } catch (error) {
    // A route that cannot count does not run.
    log.error("tee.limiter_failed", { error });
    return problem(503, "unavailable", "Try again in a minute.");
  }
  return json(await checkTee(nonce, models));
}
