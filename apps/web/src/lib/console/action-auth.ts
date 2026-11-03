import "server-only";
import { getSession, memberForApi } from "@/lib/auth/guard";
import type { Session } from "@/lib/auth/session";
import type { MemberRole, MemberTenant } from "@/lib/db/tenants";

/**
 * What a server action answers when the caller may not run it. A server action has no HTTP status
 * of its own, so the status travels in the result: 401 without a session, 403 for a non-member
 * (or a member without the role), the same answers `memberForApi` gives a route.
 */
export interface ActionDenied {
  error: string;
  status: 401 | 403;
}

const SIGNED_OUT: ActionDenied = { error: "Your session ended. Sign in again.", status: 401 };
const FORBIDDEN: ActionDenied = { error: "You cannot change this vault.", status: 403 };

export function isDenied(value: unknown): value is ActionDenied {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    ((value as ActionDenied).status === 401 || (value as ActionDenied).status === 403)
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
  if (r instanceof Response) return r.status === 401 ? SIGNED_OUT : FORBIDDEN;
  return r;
}
