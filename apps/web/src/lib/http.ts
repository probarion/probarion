import type { Db } from "@/lib/db/port";
import { takeToken } from "@/lib/ratelimit";
import { requestHost } from "@/lib/site/network";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-fA-F]{1,4}$/;

/** Four octets, or null if `v` is not a dotted quad (each octet 0-255, at most three digits). */
function parseIpv4(v: string): number[] | null {
  const m = IPV4.exec(v);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** The 16-bit groups of one side of an IPv6 literal. A dotted quad is two groups, and only the address's last item. */
function ipv6Groups(part: string, allowQuad: boolean): number[] | null {
  if (part === "") return [];
  const items = part.split(":");
  const out: number[] = [];
  for (const [i, item] of items.entries()) {
    if (allowQuad && i === items.length - 1 && item.includes(".")) {
      const q = parseIpv4(item);
      if (!q) return null;
      out.push(q[0] * 256 + q[1], q[2] * 256 + q[3]);
    } else if (HEXTET.test(item)) {
      out.push(Number.parseInt(item, 16));
    } else {
      return null;
    }
  }
  return out;
}

/** The eight 16-bit groups of an IPv6 literal (with at most one "::"), or null if it is not one. */
function parseIpv6(v: string): number[] | null {
  const halves = v.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const all = ipv6Groups(v, true);
    return all?.length === 8 ? all : null;
  }
  const head = ipv6Groups(halves[0] ?? "", false);
  const tail = ipv6Groups(halves[1] ?? "", true);
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/**
 * One rate-limit identity for an address, or null if `raw` is not an IP address.
 * IPv4 is written in one canonical form. An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is that IPv4 client. Any other
 * IPv6 address is reduced to its /64 (`2001:db8:1:2::/64`): one customer holds a whole /64 at least, so a limiter keyed
 * on the full address would never fire against a single IPv6 attacker who rotates the low 64 bits.
 */
function asIp(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v || v.length > 45) return null;
  const v4 = parseIpv4(v);
  if (v4) return v4.join(".");
  if (!v.includes(":")) return null;
  const g = parseIpv6(v);
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [(g[6] ?? 0) >> 8, (g[6] ?? 0) & 255, (g[7] ?? 0) >> 8, (g[7] ?? 0) & 255].join(".");
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}

/**
 * The caller's IP, for rate-limit bucket keys (at most 200 characters): the first X-Forwarded-For hop, else
 * X-Real-IP. IPv6 comes back as its /64 (see asIp).
 *
 * Trusted only behind Vercel, which overwrites X-Forwarded-For with the real client address. Anywhere else the
 * header is whatever the caller sent. Either way only a well-formed address is accepted, so a forged header cannot
 * inject bucket syntax or an oversized key; anything else falls back to the shared "0.0.0.0" bucket.
 */
export function clientIp(h: Headers): string {
  return asIp(h.get("x-forwarded-for")?.split(",")[0]) ?? asIp(h.get("x-real-ip")) ?? "0.0.0.0";
}

/** A JSON response. `headers` may be a record, pairs or a Headers object; a caller's value overrides a default. */
export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const merged = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  const extra = new Headers(headers);
  extra.forEach((value, name) => {
    if (name !== "set-cookie") merged.set(name, value);
  });
  // Set-Cookie is the one header that cannot be folded into a single value: keep each cookie as its own line.
  for (const cookie of extra.getSetCookie()) merged.append("set-cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers: merged });
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
  // The same host the request's network is read from (requestHost): the two cannot disagree.
  const host = requestHost(req.headers, req.url);
  if (!origin || host === null) return problem(403, "bad_origin");
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
