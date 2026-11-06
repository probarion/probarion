import "server-only";
import { getSession, memberForApi } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import type { MemberRole, MemberTenant } from "@/lib/db/tenants";

/**
 * What a server action answers when the caller may not run it. A server action has no HTTP status
 * of its own, so the status travels in the result: 401 without a session, 403 for a non-member
 * (or a member without the role), 409 for a vault on the other network, the same answers `memberForApi` gives a route.
 */
export type DeniedStatus = 401 | 403 | 409;

export interface ActionDenied {
  error: string;
  status: DeniedStatus;
}

const SIGNED_OUT: ActionDenied = { error: "Your session ended. Sign in again.", status: 401 };
const FORBIDDEN: ActionDenied = { error: "You cannot change this vault.", status: 403 };
const WRONG_NETWORK_FALLBACK =
  "This vault is on the other network. Open it at that network's address.";

export function isDenied(value: unknown): value is ActionDenied {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    ((value as ActionDenied).status === 401 ||
      (value as ActionDenied).status === 403 ||
      (value as ActionDenied).status === 409)
  );
}

/**
 * For the actions that come before a vault exists (create, register). There is no membership to
 * check yet: registerVault itself refuses anyone but the on-chain owner.
 */
export async function sessionForAction(): Promise<Session | ActionDenied> {
  return (await getSession()) ?? SIGNED_OUT;
}

/**
 * Every vault action goes through here. The tenant and the role come only from the membership row
 * for (vault, signed-in account), through `memberForApi`, never from the form.
 */
export async function memberForAction(
  vault: string,
  roles?: MemberRole[],
): Promise<{ session: Session; member: MemberTenant } | ActionDenied> {
  const r = await memberForApi(vault, roles);
  if (r instanceof Response) {
    if (r.status === 401) return SIGNED_OUT;
    if (r.status === 409) return { error: await wrongNetworkSentence(r), status: 409 };
    return FORBIDDEN;
  }
  return r;
}

/** The one plain sentence `memberForApi` put in its 409 answer ("This vault is on NEAR mainnet. Open it at the mainnet address."). */
async function wrongNetworkSentence(r: Response): Promise<string> {
  try {
    const body: unknown = await r.json();
    const detail = (body as { detail?: unknown } | null)?.detail;
    return typeof detail === "string" && detail !== "" ? detail : WRONG_NETWORK_FALLBACK;
  } catch {
    return WRONG_NETWORK_FALLBACK;
  }
}
