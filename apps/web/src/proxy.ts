import { type NextRequest, NextResponse } from "next/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kept equal to SESSION_COOKIE in lib/auth/session.ts (that module imports sodium, which a proxy should not load). */
const SESSION_COOKIE_NAME = "pb_session";

function isConsolePath(pathname: string): boolean {
  return pathname === "/console" || pathname.startsWith("/console/");
}

/**
 * Next 16 proxy (formerly middleware): request ids for logs/ledger, and a cheap console redirect.
 *
 * The redirect only looks for the session cookie's presence. It is a courtesy that saves a signed-out visitor a
 * render, NOT a security boundary: it does not read the cookie, so a made-up value passes it. Every console page
 * and route checks the signed session and the vault membership itself (`requireMember`, `memberForApi`).
 */
export function proxy(req: NextRequest) {
  const incoming = req.headers.get("x-request-id");
  const requestId = incoming && UUID.test(incoming) ? incoming : crypto.randomUUID();

  if (isConsolePath(req.nextUrl.pathname) && !req.cookies.has(SESSION_COOKIE_NAME)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    // The path only (never the query or a full URL), so /login cannot be turned into an open redirect.
    url.search = `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
    const res = NextResponse.redirect(url);
    res.headers.set("x-request-id", requestId);
    return res;
  }

  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", requestId);
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
