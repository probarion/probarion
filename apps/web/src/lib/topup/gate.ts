import type { Network } from "@/lib/config";
import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { problem, rateLimitOr429 } from "@/lib/http";
import { log } from "@/lib/log";
import { LIMITS } from "@/lib/ratelimit";
import { ONLY_ON_MAINNET } from "./copy";

/**
 * What every top-up route needs before it talks to 1Click, in one place so a new route cannot forget it:
 * the vault is on mainnet (1Click and NEAR Intents exist there only; `network` is the vault's own, which the guard
 * has already shown to be the request's) and this deployment holds the partner JWT. The JWT is returned for the route
 * to use and never reaches a response.
 */
export function mainnetGate(network: Network): { jwt: string } | Response {
  const env = getEnv();
  if (network !== "mainnet") return problem(409, "mainnet_only", `${ONLY_ON_MAINNET}.`);
  if (!env.ONECLICK_JWT) return problem(503, "not_configured");
  return { jwt: env.ONECLICK_JWT };
}

/** A bucket is one account on one network: the same account on the other network has its own. */
const BUCKETS = {
  quote: (network: Network, account: string) =>
    [`topup:${network}:${account}`, LIMITS.topupQuote] as const,
  status: (network: Network, account: string) =>
    [`topup-status:${network}:${account}`, LIMITS.topupStatus] as const,
  submit: (network: Network, account: string) =>
    [`topup-submit:${network}:${account}`, LIMITS.topupSubmit] as const,
};

/**
 * One hit on this route's rate limit for the signed-in account on `network` (the vault's own, which the guard has shown
 * to be the request's), or the response to send instead: 429 when it is used up, 503 when the limiter cannot be reached
 * (a route that cannot count does not run).
 */
export async function topupLimited(
  kind: keyof typeof BUCKETS,
  network: Network,
  account: string,
): Promise<Response | null> {
  const [bucket, limit] = BUCKETS[kind](network, account);
  try {
    return await rateLimitOr429(serviceDb(), bucket, limit);
  } catch (error) {
    log.error("topup.limiter_failed", { kind, error });
    return problem(503, "unavailable", "Try again in a minute.");
  }
}
