import { serviceDb } from "@/lib/db/clients";
import { extAuth } from "@/lib/ext/auth";
import { revokeToken } from "@/lib/ext/store";
import { problem } from "@/lib/http";
import { log, newRequestId, REQUEST_ID_HEADER } from "@/lib/log";
import { tagRequest } from "@/lib/observe";

export const dynamic = "force-dynamic";

/** The extension's Disconnect: the calling token ends now. */
export async function POST(req: Request) {
  const requestId = req.headers.get(REQUEST_ID_HEADER) ?? newRequestId();
  try {
    const db = serviceDb();
    const auth = await extAuth(req, db);
    if (auth instanceof Response) return auth;
    tagRequest(requestId, "extension", auth.network);
    await revokeToken(db, auth.token.account_id, auth.network, auth.token.id);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) {
    log.error("ext.revoke_failed", { request_id: requestId, error });
    return problem(503, "unavailable", "Try again in a moment.");
  }
}
