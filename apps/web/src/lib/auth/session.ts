import { macToken, readMacToken } from "@/lib/crypto/sodium";
import { isNearAccountId } from "@/lib/near/validate";

export const SESSION_COOKIE = "pb_session";
export const SESSION_TTL_MS = 12 * 3600_000;

export interface Session {
  accountId: string;
  exp: number;
}

/** The payload of the session cookie. `typ` keeps a challenge cookie from ever being read as a session. */
interface SessionPayload {
  typ: "session";
  v: 1;
  a: string;
  exp: number;
}

/** `key` is the "session" subkey. The payload names the account and nothing else: tenant and role come from the database. */
export function createSessionToken(
  key: Uint8Array,
  accountId: string,
  now: number = Date.now(),
): Promise<string> {
  if (!isNearAccountId(accountId)) return Promise.reject(new Error("not a NEAR account id"));
  const payload: SessionPayload = { typ: "session", v: 1, a: accountId, exp: now + SESSION_TTL_MS };
  return macToken(key, payload);
}

/** Null for anything that is not a live session we issued under `key`: wrong key, type, version, account or age. */
export async function readSessionToken(
  key: Uint8Array,
  token: string,
  now: number = Date.now(),
): Promise<Session | null> {
  const p = await readMacToken<Partial<Record<keyof SessionPayload, unknown>>>(key, token);
  if (p === null || typeof p !== "object") return null;
  if (p.typ !== "session" || p.v !== 1) return null;
  if (typeof p.a !== "string" || !isNearAccountId(p.a)) return null;
  // A session dies at its expiry instant, and a missing or non-numeric exp fails closed.
  if (typeof p.exp !== "number" || !Number.isFinite(p.exp) || !(p.exp > now)) return null;
  return { accountId: p.a, exp: p.exp };
}

export function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

/**
 * Options that delete a cookie set with `cookieOptions`: the same name-scoping attributes (Path) and the
 * same flags, a lifetime of zero and an expiry in the past (for clients that ignore Max-Age).
 */
export function clearedCookieOptions() {
  return { ...cookieOptions(0), expires: new Date(0) };
}
