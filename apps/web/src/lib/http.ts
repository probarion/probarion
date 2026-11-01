import type { Db } from "@/lib/db/port";
import { takeToken } from "@/lib/ratelimit";

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
// Hex groups and colons, optionally ending in a dotted quad (::ffff:203.0.113.7). 45 is the longest textual IPv6.
const IPV6 = /^[0-9a-fA-F:]*:[0-9a-fA-F:.]*$/;

function asIp(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v || v.length > 45) return null;
  return IPV4.test(v) || IPV6.test(v) ? v.toLowerCase() : null;
}

/**
 * The caller's IP, used inside rate-limit bucket keys (at most 200 characters). Only an IP-shaped value is accepted, so a
 * forged header cannot inject bucket syntax or an oversized key; anything else falls back to the shared "0.0.0.0" bucket.
 */
export function clientIp(h: Headers): string {
  return asIp(h.get("x-forwarded-for")?.split(",")[0]) ?? asIp(h.get("x-real-ip")) ?? "0.0.0.0";
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function problem(
  status: number,
  code: string,
  detail?: string,
  headers: HeadersInit = {},
): Response {
  return json(detail === undefined ? { error: code } : { error: code, detail }, status, headers);
}

/** CSRF guard for JSON/multipart route handlers (Server Actions have their own origin check). */
export function assertSameOrigin(req: Request): Response | null {
  const origin = req.headers.get("origin");
  // Behind a proxy chain the forwarded host can be a comma list; the first hop is the one the client asked for.
  const hostHeader =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const host = (hostHeader.split(",")[0] ?? "").trim().toLowerCase();
  if (!origin) return problem(403, "bad_origin");
  try {
    if (new URL(origin).host !== host) return problem(403, "bad_origin");
  } catch {
    return problem(403, "bad_origin");
  }
  return null;
}

export async function rateLimitOr429(
  db: Db,
  bucket: string,
  [max, windowSeconds]: readonly [number, number],
): Promise<Response | null> {
  const d = await takeToken(db, bucket, max, windowSeconds);
  if (d.allowed) return null;
  // The reset time comes from the database clock; a skewed or unparseable value must still give a usable header.
  const resetMs = new Date(d.reset_at).getTime();
  const retry = Number.isFinite(resetMs)
    ? Math.max(1, Math.ceil((resetMs - Date.now()) / 1000))
    : windowSeconds;
  return problem(429, "rate_limited", `Try again in ${retry} s`, { "Retry-After": String(retry) });
}
