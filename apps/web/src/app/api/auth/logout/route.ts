import { cookies } from "next/headers";
import { CHALLENGE_COOKIE } from "@/lib/auth/challenge";
import { clearedCookieOptions, SESSION_COOKIE } from "@/lib/auth/session";
import { assertSameOrigin, json } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Ends the browser's session. The cookie is cleared with the attributes it was set with. A session token is
 * stateless, so a copy someone kept still verifies until its own expiry (12 hours); membership is re-read from
 * the database on every request, so removing an account from a vault takes effect at once.
 */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", clearedCookieOptions());
  jar.set(CHALLENGE_COOKIE, "", clearedCookieOptions());
  return json({ ok: true });
}
