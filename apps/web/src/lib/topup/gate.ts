import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { problem, rateLimitOr429 } from "@/lib/http";
import { log } from "@/lib/log";
import { LIMITS } from "@/lib/ratelimit";
import { ONLY_ON_MAINNET } from "./copy";

/**
 * What every top-up route needs before it talks to 1Click, in one place so a new route cannot forget it:
 * this deployment runs on mainnet (1Click and NEAR Intents exist there only) and holds the partner JWT.
 * The JWT is returned for the route to use and never reaches a response.
 */
export function mainnetGate(): { jwt: string } | Response {
  const env = getEnv();
  if (env.NEAR_NETWORK !== "mainnet") return problem(409, "mainnet_only", `${ONLY_ON_MAINNET}.`);
  if (!env.ONECLICK_JWT) return problem(503, "not_configured");
  return { jwt: env.ONECLICK_JWT };
}

const BUCKETS = {
  quote: (account: string) => [`topup:${account}`, LIMITS.topupQuote] as const,
  status: (account: string) => [`topup-status:${account}`, LIMITS.topupStatus] as const,
  submit: (account: string) => [`topup-submit:${account}`, LIMITS.topupSubmit] as const,
};

/**
 * One hit on this route's rate limit for the signed-in account, or the response to send instead: 429 when it
 * is used up, 503 when the limiter cannot be reached (a route that cannot count does not run).
 */
export async function topupLimited(
  kind: keyof typeof BUCKETS,
  account: string,
): Promise<Response | null> {
  const [bucket, limit] = BUCKETS[kind](account);
  try {
    return await rateLimitOr429(serviceDb(), bucket, limit);
  } catch (error) {
    log.error("topup.limiter_failed", { kind, error });
    return problem(503, "unavailable", "Try again in a minute.");
  }
}
