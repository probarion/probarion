import { cookies } from "next/headers";
import { CHALLENGE_COOKIE, CHALLENGE_TTL_MS, issueChallenge } from "@/lib/auth/challenge";
import { cookieOptions } from "@/lib/auth/session";
import { subkey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import { clientIp, json, rateLimitOr429 } from "@/lib/http";
import { LIMITS } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** Step 1 of sign-in: a fresh nonce, in the body for the wallet and in a MAC'd cookie for the server. */
export async function GET(req: Request) {
  const limited = await rateLimitOr429(
    serviceDb(),
    `auth:challenge:${clientIp(req.headers)}`,
    LIMITS.authChallenge,
  );
  if (limited) return limited;
  // The "challenge" subkey, not "session": a challenge cookie can never be read as a session.
  const { challenge, cookie } = await issueChallenge(await subkey("challenge"));
  (await cookies()).set(CHALLENGE_COOKIE, cookie, cookieOptions(CHALLENGE_TTL_MS));
  return json(challenge);
}
