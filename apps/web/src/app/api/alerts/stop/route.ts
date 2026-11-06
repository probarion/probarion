import { stopByToken } from "@/lib/alerts/links";
import { parseStopParams } from "@/lib/alerts/stop";
import { appOrigin } from "@/lib/config";
import { subkey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import { DbError } from "@/lib/db/port";
import { json, problem } from "@/lib/http";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Stops one subscription: the one-click unsubscribe of an alert email (RFC 8058: the mail client POSTs here, the address
 * is in the email's List-Unsubscribe header) and the button on /alerts/stop (which also sends \`from=page\`, and is sent
 * back to the page). The keyed token in the query is the whole credential, so there is no session, no origin check and no
 * rate limit to turn an unsubscribe away; a token that is not the one for its id is a 400 before any database call. The
 * answer is the same whether or not the subscription existed or was already off. A POST only: opening the link does nothing.
 */
export async function POST(req: Request) {
  const link = parseStopParams(new URL(req.url).searchParams);
  if (link === null) return problem(400, "invalid_link");
  const fromPage = (await req.formData().catch(() => null))?.get("from") === "page";
  const page = (extra: string) =>
    Response.redirect(`${appOrigin()}/alerts/stop?s=${link.id}&t=${link.token}${extra}`, 303);
  try {
    if (!(await stopByToken(serviceDb(), await subkey("alerts"), link.id, link.token))) {
      return problem(400, "invalid_link");
    }
    return fromPage ? page("&done=1") : json({ ok: true });
  } catch (error) {
    log.warn("alerts.stop_failed", { error: error instanceof DbError ? error.code : "failed" });
    return fromPage ? page("&failed=1") : problem(503, "unavailable");
  }
}
