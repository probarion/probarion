import { AUTH_RECIPIENT, type Network } from "@/lib/config";
import { decodeCanonical, macToken, readMacToken } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { takeToken } from "@/lib/ratelimit";
import { isNetwork } from "@/lib/site/network";

export const CHALLENGE_COOKIE = "pb_chal";
export const CHALLENGE_TTL_MS = 5 * 60_000;
/**
 * R8: how long a spent nonce stays burned. It must outlast the challenge itself (5 minutes), or a nonce could
 * come back to life while its cookie was still valid.
 */
export const NONCE_BURN_WINDOW_SECONDS = 600;

const NONCE_BYTES = 32;

export interface Challenge {
  message: string;
  recipient: string;
  nonce: string; // base64 of 32 bytes
}

/**
 * The payload of the challenge cookie. `typ` keeps it from ever being read as a session (and the reverse). Version 2
 * binds the challenge to the network of the address it was issued at (`net`): it opens there and nowhere else.
 */
interface ChallengePayload {
  typ: "challenge";
  v: 2;
  n: string;
  net: Network;
  exp: number;
}

/** Deterministic from the nonce, so the server never trusts a client-sent message. */
export function challengeMessage(nonceHex: string): string {
  return `Sign in to Probarion\n\nThis proves you control this NEAR account. It does not move funds or add keys.\n\nNonce: ${nonceHex}`;
}

/**
 * `key` is the "challenge" subkey, never the session one. The cookie is MAC'd, not encrypted: the nonce is
 * public by design (the browser gets it in the response body too). `network` is the request's.
 */
export async function issueChallenge(
  key: Uint8Array,
  network: Network,
  now: number = Date.now(),
  rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): Promise<{ challenge: Challenge; cookie: string }> {
  const nonce = rand(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new Error(`the nonce must be ${NONCE_BYTES} bytes`);
  const nonceB64 = Buffer.from(nonce).toString("base64");
  const payload: ChallengePayload = {
    typ: "challenge",
    v: 2,
    n: nonceB64,
    net: network,
    exp: now + CHALLENGE_TTL_MS,
  };
  return {
    challenge: {
      message: challengeMessage(Buffer.from(nonce).toString("hex")),
      recipient: AUTH_RECIPIENT,
      nonce: nonceB64,
    },
    cookie: await macToken(key, payload),
  };
}

/**
 * Null for anything that is not a live challenge we issued under `key` on `network`: wrong key, type, version, network,
 * spelling, age. A challenge issued at one network's address does not open at the other's.
 */
export async function openChallenge(
  key: Uint8Array,
  cookie: string | undefined,
  network: Network,
  now: number = Date.now(),
): Promise<{ nonce: Uint8Array; message: string } | null> {
  if (!cookie) return null;
  const c = await readMacToken<Partial<Record<keyof ChallengePayload, unknown>>>(key, cookie);
  if (c === null || typeof c !== "object") return null;
  if (c.typ !== "challenge" || c.v !== 2) return null;
  if (!isNetwork(c.net) || c.net !== network) return null;
  // Not `exp >= now`: a challenge dies at its expiry instant, and a missing or non-numeric exp fails closed.
  if (typeof c.exp !== "number" || !Number.isFinite(c.exp) || !(c.exp > now)) return null;
  // R7: the nonce is authenticated data, so it is decoded in its one canonical spelling, never with a bare Buffer.from.
  const nonce = decodeCanonical(c.n, "base64");
  if (nonce === null || nonce.length !== NONCE_BYTES) return null;
  return { nonce, message: challengeMessage(Buffer.from(nonce).toString("hex")) };
}

/**
 * R8, single use: burn the nonce on the server, before the signature is looked at. The cookie is only a copy
 * the browser holds; a captured cookie plus a captured signature would otherwise sign in again until the
 * challenge expired. `takeToken(…, 1, 600)` is allowed once per nonce and refused on every replay, atomically
 * (one upsert in the database), so two parallel submissions cannot both pass.
 *
 * True when this call is the first use of the nonce. A database error propagates: no burn, no sign-in.
 */
export async function burnChallenge(db: Db, nonce: Uint8Array): Promise<boolean> {
  const bucket = `auth:nonce:${Buffer.from(nonce).toString("hex")}`;
  const d = await takeToken(db, bucket, 1, NONCE_BURN_WINDOW_SECONDS);
  return d.allowed;
}
