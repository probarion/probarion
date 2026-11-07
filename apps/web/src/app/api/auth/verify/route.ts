import { cookies } from "next/headers";
import { burnChallenge, CHALLENGE_COOKIE, openChallenge } from "@/lib/auth/challenge";
import {
  clearedCookieOptions,
  cookieOptions,
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "@/lib/auth/session";
import { authUnavailable } from "@/lib/auth/unavailable";
import {
  type Nep413Verifier,
  nearApiVerifier,
  rpcLoginProvider,
  verifyLogin,
} from "@/lib/auth/verify";
import { subkey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { assertSameOrigin, clientIp, json, problem, rateLimitOr429 } from "@/lib/http";
import { log } from "@/lib/log";
import { verifiedRpc, WrongChainError } from "@/lib/near/chain";
import { requestNetwork } from "@/lib/network";
import { LIMITS } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** Without a valid challenge `verifyLogin` answers before it uses a verifier: there is no key to look up. */
const noVerifier: Nep413Verifier = async () => {
  throw new Error("no challenge, so no key is looked up");
};

/** A login is about 250 bytes of JSON; anything near this size is not one. */
const MAX_BODY_BYTES = 2048;

type LoginBody = { tooLarge: true } | { tooLarge: false; value: unknown };

/**
 * The request body as JSON, counting real bytes as they arrive: the read stops (and the stream is cancelled)
 * the moment more than MAX_BODY_BYTES have been seen, so a chunked body with no Content-Length is never
 * buffered whole. A body that is empty or not JSON gives `value: null` (the caller says invalid_input). A read
 * that fails half way (the client went away) throws.
 */
async function readLoginBody(req: Request): Promise<LoginBody> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await req.body?.cancel().catch(() => {});
    return { tooLarge: true };
  }
  if (req.body === null) return { tooLarge: false, value: null };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  try {
    return { tooLarge: false, value: JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) };
  } catch {
    return { tooLarge: false, value: null };
  }
}

/** Step 2 of sign-in: the wallet's NEP-413 signature over the challenge. */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  try {
    return await verify(req, requestId);
  } catch (error) {
    // The database, the key derivation, the RPC client's settings or a cut-off body: 503 `unavailable` with
    // no detail, never an unhandled 500. Nothing has been signed in (the session cookie is set last).
    return authUnavailable("auth.verify_failed", error, requestId);
  }
}

async function verify(req: Request, requestId: string | undefined): Promise<Response> {
  const db = serviceDb();
  const limited = await rateLimitOr429(
    db,
    `auth:verify:${clientIp(req.headers)}`,
    LIMITS.authVerify,
  );
  if (limited) return limited;

  // The network of the address this sign-in is opened at (W-NET-R3): its challenge, its chain, its session.
  const network = await requestNetwork();
  const jar = await cookies();
  const challenge = await openChallenge(
    await subkey("challenge"),
    jar.get(CHALLENGE_COOKIE)?.value,
    network,
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
      return authUnavailable("auth.nonce_burn_failed", error, requestId);
    }
    if (!first) {
      log.warn("auth.rejected", { reason: "challenge_replayed", request_id: requestId });
      return problem(401, "challenge_missing_or_expired");
    }
  }

  const body = await readLoginBody(req);
  if (body.tooLarge) {
    log.warn("auth.rejected", { reason: "payload_too_large", request_id: requestId });
    return problem(413, "payload_too_large");
  }
  // A session is lasting state, and it rests on one key lookup. Before one can be minted the network's RPC list is checked
  // URL by URL (the client fails over from URL to URL, so one URL on the other chain is enough to refuse), and the key is
  // read through a client built only from the URLs that have answered with this network's chain: never getRpc, which holds
  // every URL, checked or not. A setting that points a URL at the other chain's nodes is refused here, whatever the URL
  // looks like. With no valid challenge nothing can be minted, so no node is asked. A node that cannot be reached, with no
  // URL right, is the usual 503 `unavailable` (the POST handler).
  let verifier: Nep413Verifier = noVerifier;
  if (challenge) {
    try {
      verifier = nearApiVerifier(
        rpcLoginProvider(await verifiedRpc(network, getEnv().networks[network])),
      );
    } catch (error) {
      if (error instanceof WrongChainError) return problem(503, "wrong_chain");
      throw error;
    }
  }
  const result = await verifyLogin(body.value, challenge, verifier);
  if (!result.ok) {
    log.warn("auth.rejected", { reason: result.reason, request_id: requestId });
    // "verifier_unavailable" (no node could say whether the key is on the account) is the same 503 as every
    // other infrastructure failure; the reason above is in the log.
    return result.reason === "verifier_unavailable"
      ? problem(503, "unavailable")
      : problem(401, result.reason);
  }
  jar.set(
    SESSION_COOKIE,
    await createSessionToken(await subkey("session"), result.accountId, network),
    cookieOptions(SESSION_TTL_MS),
  );
  log.info("auth.signed_in", { account: result.accountId, network, request_id: requestId });
  return json({ accountId: result.accountId });
}
