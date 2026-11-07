import { serviceDb } from "@/lib/db/clients";
import type { Db } from "@/lib/db/port";
import { exchangePairCode } from "@/lib/ext/store";
import { cleanLabel, codeHash, newToken, readPairCode } from "@/lib/ext/token";
import { clientIp, json, problem, rateLimitOr429 } from "@/lib/http";
import { log, newRequestId, REQUEST_ID_HEADER } from "@/lib/log";
import { requestNetwork } from "@/lib/network";
import { tagRequest } from "@/lib/observe";
import { LIMITS } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** `{ code, label }` is a few dozen bytes: anything over 1 KiB is not a pairing request. */
const MAX_BODY_BYTES = 1024;

const field = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;

/**
 * The pairing-code fallback (spec §4.2): `{ code, label }` for a token of the account that showed the code, on this
 * address's network. One answer for an unknown, used or expired code. Limited per address and in total, per network.
 */
export async function POST(req: Request) {
  const requestId = req.headers.get(REQUEST_ID_HEADER) ?? newRequestId();
  let db: Db;
  try {
    db = serviceDb();
  } catch (error) {
    log.error("ext.pair_failed", { request_id: requestId, error });
    return problem(503, "unavailable", "Try again in a moment.");
  }
  try {
    const network = await requestNetwork();
    tagRequest(requestId, "extension", network);
    const limited =
      (await rateLimitOr429(
        db,
        `ext:pair:${network}:${clientIp(req.headers)}`,
        LIMITS.extPairPerIp,
      )) ?? (await rateLimitOr429(db, `ext:pair:${network}`, LIMITS.extPairGlobal));
    if (limited) return limited;
    const length = req.headers.get("content-length");
    if (length === null || !/^[0-9]{1,6}$/.test(length.trim()) || Number(length) > MAX_BODY_BYTES) {
      await req.body?.cancel().catch(() => {});
      return problem(400, "invalid_input", "Send { code, label } as JSON, 1 KiB at most.");
    }
    const body: unknown = await req.json().catch(() => null);
    const code = readPairCode(field(body, "code"));
    if (code === null) {
      return problem(400, "bad_code_format", "A code is 8 letters and digits, like K7QM-4XRA.");
    }
    const t = newToken();
    const r = await exchangePairCode(db, {
      codeSha256: codeHash(code),
      network,
      sha256: t.sha256,
      hint: t.hint,
      label: cleanLabel(field(body, "label")),
    });
    if (!r.ok) {
      return problem(
        401,
        "bad_code",
        "This code is wrong, used or expired. Show a new one on the Browser extension page.",
      );
    }
    log.info("ext.paired", {
      request_id: requestId,
      account: r.account_id,
      network: r.network,
      connection: r.id,
    });
    return json({
      token: t.token,
      account: r.account_id,
      network: r.network,
      expires_at: r.expires_at,
    });
  } catch (error) {
    log.error("ext.pair_failed", { request_id: requestId, error });
    return problem(503, "unavailable", "Try again in a moment.");
  }
}
