import { cookies } from "next/headers";
import { burnChallenge, CHALLENGE_COOKIE, openChallenge } from "@/lib/auth/challenge";
import {
  clearedCookieOptions,
  cookieOptions,
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "@/lib/auth/session";
import { nearApiVerifier, rpcLoginProvider, verifyLogin } from "@/lib/auth/verify";
import { subkey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import { assertSameOrigin, clientIp, json, problem, rateLimitOr429 } from "@/lib/http";
import { log } from "@/lib/log";
import { getRpc } from "@/lib/near/server";
import { LIMITS } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** A login is about 250 bytes of JSON; anything near this size is not one. */
const MAX_BODY_BYTES = 2048;

/** The parsed body, or null for anything that is too large, empty or not JSON (the caller says invalid_input). */
async function readLoginBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Step 2 of sign-in: the wallet's NEP-413 signature over the challenge. */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const db = serviceDb();
  const limited = await rateLimitOr429(
    db,
    `auth:verify:${clientIp(req.headers)}`,
    LIMITS.authVerify,
  );
  if (limited) return limited;

  const jar = await cookies();
  const challenge = await openChallenge(
    await subkey("challenge"),
    jar.get(CHALLENGE_COOKIE)?.value,
  );
  // Single use, success or not: the browser's copy goes at once (same attributes it was set with) ...
  jar.set(CHALLENGE_COOKIE, "", clearedCookieOptions());
  if (challenge) {
    // ... and R8: the server's own record goes before the signature is looked at, so a copy of the cookie
    // that an attacker kept is no use. A failure to record it is a failure to sign in.
    let first: boolean;
    try {
      first = await burnChallenge(db, challenge.nonce);
    } catch (error) {
      log.error("auth.nonce_burn_failed", {
        error: error instanceof Error ? error.message : "unknown",
        request_id: requestId,
      });
      return problem(503, "unavailable");
    }
    if (!first) {
      log.warn("auth.rejected", { reason: "challenge_replayed", request_id: requestId });
      return problem(401, "challenge_missing_or_expired");
    }
  }

  const body = await readLoginBody(req);
  const result = await verifyLogin(body, challenge, nearApiVerifier(rpcLoginProvider(getRpc())));
  if (!result.ok) {
    log.warn("auth.rejected", { reason: result.reason, request_id: requestId });
    return problem(result.reason === "verifier_unavailable" ? 503 : 401, result.reason);
  }
  jar.set(
    SESSION_COOKIE,
    await createSessionToken(await subkey("session"), result.accountId),
    cookieOptions(SESSION_TTL_MS),
  );
  log.info("auth.signed_in", { account: result.accountId, request_id: requestId });
  return json({ accountId: result.accountId });
}
