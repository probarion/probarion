import { serviceDb } from "@/lib/db/clients";
import type { Db } from "@/lib/db/port";
import { extAuth } from "@/lib/ext/auth";
import { loadInbox } from "@/lib/ext/inbox";
import { json, problem, rateLimitOr429 } from "@/lib/http";
import { log, newRequestId, REQUEST_ID_HEADER } from "@/lib/log";
import { listAll } from "@/lib/near/reader";
import { getReader } from "@/lib/near/server";
import { softRequestOrigin } from "@/lib/network";
import { tagRequest } from "@/lib/observe";
import { LIMITS } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** What waits for the token's account on this network (spec §4.3), for the popup and the badge. */
export async function GET(req: Request) {
  const requestId = req.headers.get(REQUEST_ID_HEADER) ?? newRequestId();
  let db: Db;
  try {
    db = serviceDb();
  } catch (error) {
    log.error("ext.inbox_failed", { request_id: requestId, error });
    return problem(503, "unavailable", "Probarion could not read your vaults. Try again.");
  }
  try {
    const auth = await extAuth(req, db);
    if (auth instanceof Response) return auth;
    const { token, network } = auth;
    tagRequest(requestId, "extension", network);
    const limited = await rateLimitOr429(
      db,
      `ext:inbox:${network}:${token.account_id}`,
      LIMITS.extInbox,
    );
    if (limited) return limited;
    const reader = getReader(network);
    const inbox = await loadInbox(
      {
        db,
        origin: await softRequestOrigin(),
        now: new Date(),
        chain: {
          mandates: (v) =>
            listAll((from, limit) => reader.listMandates(v, from, limit), 100, {
              contractId: v,
              methodName: "list_mandates",
            }),
          spends: (v) =>
            listAll((from, limit) => reader.listSpends(v, from, limit), 100, {
              contractId: v,
              methodName: "list_spends",
            }),
        },
      },
      { account: token.account_id, network },
    );
    return json(inbox);
  } catch (error) {
    log.error("ext.inbox_failed", { request_id: requestId, error });
    return problem(503, "unavailable", "Probarion could not read your vaults. Try again.");
  }
}
