import type { MandateView } from "@probarion/core";
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth/guard";
import { makeCanaryProbarion } from "@/lib/canary/probarion";
import { runAttempt } from "@/lib/canary/service";
import { masterKey, subkey } from "@/lib/crypto/server";
import { keyedHashHex } from "@/lib/crypto/sodium";
import { serviceDb } from "@/lib/db/clients";
import type { Db } from "@/lib/db/port";
import { memberTenants } from "@/lib/db/tenants";
import { getEnv } from "@/lib/env";
import { assertSameOrigin, clientIp, json, problem, rateLimitOr429 } from "@/lib/http";
import { listKeys } from "@/lib/keys/service";
import { SupabaseLedgerStore } from "@/lib/ledger/store";
import { log, newRequestId } from "@/lib/log";
import { listAll } from "@/lib/near/reader";
import { getReader } from "@/lib/near/server";
import { LIMITS } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
// The Canary tenant's lease (CANARY_LIMITS.leaseSeconds, 90 s) outlasts this with a 30 s margin; route.test.ts checks it.
export const maxDuration = 60;

const VISITOR_COOKIE = "pb_canary";
/** What this route mints: 16 random bytes as base64url. Anything else is replaced. */
const VISITOR_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/** Every mandate of the vault, all pages (the SDK's pageAll refuses a node that loops or truncates). */
function vaultMandates(vault: string): Promise<MandateView[]> {
  return listAll((from, limit) => getReader().listMandates(vault, from, limit), 100, {
    contractId: vault,
    methodName: "list_mandates",
  });
}

const STATUS = {
  closed: 503,
  too_long: 400,
  empty: 400,
  budget: 429,
  busy: 409,
  not_ready: 503,
  failed: 502,
} as const;

/**
 * One attempt at the Canary challenge: `{ text }` in, an `AttemptResult` out. Public (no session), same-origin only, rate
 * limited per address and in total. The visitor is told apart by a keyed hash of an httpOnly cookie and of their IP, and
 * the text itself is never stored.
 */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const requestId = req.headers.get("x-request-id") ?? newRequestId();
  try {
    return await attempt(req, requestId);
  } catch (error) {
    // The database, the key derivation, a missing setting or an unreadable key: 503, never an unhandled 500.
    log.error("canary.route_failed", { request_id: requestId, error });
    return problem(503, "unavailable", `Try again (request ${requestId}).`);
  }
}

async function attempt(req: Request, requestId: string): Promise<Response> {
  const env = getEnv();
  if (!env.CANARY_VAULT_ID) return problem(503, "not_ready");
  // The gullible agent needs the model: without a key there would be nothing to fool.
  if (!env.NEARAI_API_KEY) return problem(503, "not_ready");
  const db = serviceDb();
  const found = await db.rpc<{
    tenant_id: string;
    vault_id: string;
    kind: string;
    proof_public: boolean;
  } | null>("tenant_by_vault", { vault_id: env.CANARY_VAULT_ID });
  if (found?.kind !== "canary") return problem(503, "not_ready");
  // The Canary's ledger must be private: the gullible model quotes what visitors type into signed, append-only entries,
  // and a public ledger would publish that for good (W-T17-R1). No model call and no chain call while it is public.
  if (found.proof_public) {
    log.error("canary.public_ledger", { request_id: requestId, tenant: found.tenant_id });
    return problem(503, "not_ready");
  }
  const tenant = { tenant_id: found.tenant_id, vault_id: found.vault_id };

  const visitorKey = await subkey("visitor");
  const ipHash = await keyedHashHex(visitorKey, `ip:${clientIp(req.headers)}`);
  const jar = await cookies();
  let visitor = jar.get(VISITOR_COOKIE)?.value;
  if (!visitor || !VISITOR_SHAPE.test(visitor)) {
    visitor = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    jar.set(VISITOR_COOKIE, visitor, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 86400,
    });
  }
  const visitorHash = await keyedHashHex(visitorKey, `cookie:${visitor}`);
  const limited =
    (await rateLimitOr429(db, `canary:model:ip:${ipHash}`, LIMITS.canaryModelVisitor)) ??
    (await rateLimitOr429(db, "canary:model:global", LIMITS.canaryModelGlobal));
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  if (typeof body?.text !== "string") return problem(400, "invalid_input");
  const isTeam = await isTeamMember(db);
  const store = new SupabaseLedgerStore(db, tenant.tenant_id);

  const r = await runAttempt(
    {
      db,
      mode: env.CANARY_MODE,
      now: () => new Date(),
      tenant,
      mandates: () => vaultMandates(tenant.vault_id),
      makeProbarion: ({ mandate, requestId: rid }) =>
        makeCanaryProbarion(db, masterKey(), tenant, mandate, rid),
      async agentAllowance(mandate) {
        // A key the chain does not show reads as an unlimited allowance (null): it must not turn raw mode ON.
        const k = await getReader().accessKey(tenant.vault_id, mandate.agent_pk);
        if (!k.exists) return 0n;
        return k.allowance === null ? null : BigInt(k.allowance);
      },
      async ledgerAllowance() {
        // The tenant's active LEDGER key pays for the anchor of every attempt. No such key reads as 0 (not ready).
        const key = (await listKeys(db, tenant.tenant_id)).find(
          (k) => k.purpose === "ledger" && k.status === "active",
        );
        if (!key) return 0n;
        const k = await getReader().accessKey(tenant.vault_id, key.public_key);
        if (!k.exists) return 0n;
        return k.allowance === null ? null : BigInt(k.allowance);
      },
      async ledgerSize() {
        const head = await store.head();
        return head === null ? 0 : head.body.seq + 1;
      },
      ledgerByHash: (hash) => store.getByHash(hash),
    },
    { text: body.text, visitorHash, ipHash, isTeam, requestId },
  );
  if (r.status === "done") return json(r);
  // Every 429 says when to come back: the seconds until the limit that was hit is over.
  if (r.reason === "budget") {
    return problem(429, "budget", undefined, { "Retry-After": String(r.retryAfterS ?? 60) });
  }
  return problem(STATUS[r.reason], r.reason);
}

/**
 * True for a signed-in member of a team vault: the team's own attempts are counted apart from the public's. Taken from
 * the session only; a failure here is a visitor counted as outside, never a refused attempt.
 */
async function isTeamMember(db: Db): Promise<boolean> {
  try {
    const session = await getSession();
    if (!session) return false;
    return (await memberTenants(db, session.accountId)).some((t) => t.kind === "team");
  } catch {
    return false;
  }
}
