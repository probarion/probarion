import "server-only";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { subkey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import { type MemberRole, type MemberTenant, memberRole } from "@/lib/db/tenants";
import { problem } from "@/lib/http";
import { isNearAccountId } from "@/lib/near/validate";
import { loginPath } from "./redirect";
import { readSessionToken, SESSION_COOKIE, type Session } from "./session";

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return readSessionToken(await subkey("session"), token);
}

/**
 * A signed-in session, or a redirect to /login. The redirect carries where the visitor was going as
 * `?next=<path>`, the way the proxy's own redirect does: `next` if the caller gives one, else the path the
 * proxy forwarded in `x-pathname` (it overwrites any value the browser sent). Either way the path is checked
 * to be a same-origin path (`safeNextPath`), so this cannot be made an open redirect; anything else is /login.
 */
export async function requireSession(next?: string): Promise<Session> {
  const s = await getSession();
  if (!s) redirect(loginPath(next ?? (await headers()).get("x-pathname")));
  return s;
}

/**
 * Tenant isolation lives here. The Task 3 RPCs trust their arguments, so every console page and route finds
 * its tenant through this one lookup: the tenant and the role come from the database row for (this vault,
 * the session's account), never from a request body, query string or token field. Null when the id is not a
 * NEAR account (it never reaches the database), the account is no member, or the role is not allowed. A vault
 * that does not exist and a vault the account is no member of look the same.
 */
async function membership(
  vaultId: string,
  account: string,
  roles: MemberRole[] | undefined,
): Promise<MemberTenant | null> {
  if (!isNearAccountId(vaultId)) return null;
  const member = await memberRole(serviceDb(), vaultId, account);
  if (!member || member.vault_id !== vaultId) return null;
  if (roles && !roles.includes(member.role)) return null;
  return member;
}

/** Pages: 404 (not 403) for non-members, so vault ids are not confirmed to strangers. */
export async function requireMember(
  vaultId: string,
  roles?: MemberRole[],
): Promise<{ session: Session; member: MemberTenant }> {
  const session = await requireSession();
  const member = await membership(vaultId, session.accountId, roles);
  if (!member) notFound();
  return { session, member };
}

/**
 * Route handlers: JSON errors instead of redirects. 401 without a session; 403 when the account is not a
 * member of the vault (or not in `roles`). A vault that does not exist gets the same 403, so ids are not confirmed.
 */
export async function memberForApi(
  vaultId: string,
  roles?: MemberRole[],
): Promise<{ session: Session; member: MemberTenant } | Response> {
  const session = await getSession();
  if (!session) return problem(401, "unauthenticated");
  const member = await membership(vaultId, session.accountId, roles);
  if (!member) return problem(403, "forbidden");
  return { session, member };
}
