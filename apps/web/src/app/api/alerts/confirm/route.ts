import { confirmEmailLink, isLinkCode } from "@/lib/alerts/links";
import { serviceDb } from "@/lib/db/clients";
import { DbError } from "@/lib/db/port";
import { clientIp, problem, rateLimitOr429 } from "@/lib/http";
import { log } from "@/lib/log";
import { softRequestOrigin } from "@/lib/network";
import { LIMITS } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/**
 * Back to the address the request came in on, which is its network's origin (never a host the visitor names): the person
 * confirmed on the network they opened the email's link on, and lands on that network's console. A setting the console
 * refuses does not stop the redirect: the origin then comes from the public map built into the pages, else from the
 * production address (`softRequestOrigin`).
 */
async function to(path: string): Promise<Response> {
  return Response.redirect(`${await softRequestOrigin()}${path}`, 303);
}

/**
 * The button on /alerts/confirm. A POST, never a GET: mail scanners open links, and opening one must not turn anything
 * on. The code is the credential (122 random bits, one use, 24 hours); a bad shape is refused before any database call. A
 * code that is used, expired or unknown goes back to the page, which says so in one sentence. On success the person lands
 * on the vault's alerts page.
 */
export async function POST(req: Request) {
  const code = (await req.formData().catch(() => null))?.get("code");
  if (!isLinkCode(code)) return await to("/alerts/confirm");
  try {
    const limited = await rateLimitOr429(
      serviceDb(),
      `alerts:link:${clientIp(req.headers)}`,
      LIMITS.alertLink,
    );
    if (limited) return limited;
    const vault = await confirmEmailLink(serviceDb(), code);
    return vault === null
      ? await to(`/alerts/confirm?code=${code}`)
      : await to(`/console/${vault}/alerts?verified=1`);
  } catch (error) {
    // No code in the log: it is the credential.
    log.warn("alerts.confirm_failed", { error: error instanceof DbError ? error.code : "failed" });
    return problem(503, "unavailable");
  }
}
