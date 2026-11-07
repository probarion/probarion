import "server-only";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Network } from "@/lib/config";
import { subkey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import { type MemberRole, type MemberTenant, memberRole } from "@/lib/db/tenants";
import { problem } from "@/lib/http";
import { isNearAccountId } from "@/lib/near/validate";
import { originFor, requestNetwork, wrongNetworkSentence } from "@/lib/network";
import { loginPath } from "./redirect";
import { readSessionToken, SESSION_COOKIE, type Session } from "./session";

/**
 * The signed session of this request, or null. A session belongs to one network (W-NET-R3): one that was minted on the
 * other network's address counts as signed out here, whatever its cookie says.
 */
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await readSessionToken(await subkey("session"), token);
  if (session === null) return null;
  return session.network === (await requestNetwork()) ? session : null;
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
 * the account), never from a request body, query string or a field the caller sends. The account is the
 * session's, or, for the extension's routes, the verified token's (lib/ext/auth.ts). Null when the id is not a
 * NEAR account (it never reaches the database), the account is no member, or the role is not allowed. A vault
 * that does not exist and a vault the account is no member of look the same.
 */
export async function membership(
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

/** A vault of the other network, opened at this network's address (W-NET-R4). */
export interface VaultElsewhere {
  vaultId: string;
  /** The network the vault is registered on. */
  vaultNetwork: Network;
  /** The network of this request. */
  requestNetwork: Network;
  /** `<origin of the vault's network>/console/<vault>`, or null when this site does not serve that network. */
  href: string | null;
}

/**
 * Pages: 404 (not 403) for non-members, so vault ids are not confirmed to strangers.
 *
 * A member who opens a vault that is registered on the other network gets `elsewhere` set and nothing else to go on:
 * the page returns `<VaultOnOtherNetwork {...elsewhere} />` in place of itself, before it reads the chain or anything
 * else. The vault's network is `member.network`; a page that is not `elsewhere` is on the request's network, so its
 * clients, constants and wallet are that network's.
 */
export async function requireMember(
  vaultId: string,
  roles?: MemberRole[],
): Promise<{ session: Session; member: MemberTenant; elsewhere: VaultElsewhere | null }> {
  const session = await requireSession();
  const member = await membership(vaultId, session.accountId, roles);
  if (!member) notFound();
  const here = await requestNetwork();
  if (member.network === here) return { session, member, elsewhere: null };
  const origin = originFor(member.network);
  return {
    session,
    member,
    elsewhere: {
      vaultId: member.vault_id,
      vaultNetwork: member.network,
      requestNetwork: here,
      href: origin === null ? null : `${origin}/console/${encodeURIComponent(member.vault_id)}`,
    },
  };
}

/**
 * Route handlers: JSON errors instead of redirects. 401 without a session; 403 when the account is not a
 * member of the vault (or not in `roles`). A vault that does not exist gets the same 403, so ids are not confirmed.
 * 409 `wrong_network` for a member whose vault is registered on the other network: this runs first in every route and
 * action, so nothing is read from a chain, written or signed for such a vault.
 */
export async function memberForApi(
  vaultId: string,
  roles?: MemberRole[],
): Promise<{ session: Session; member: MemberTenant } | Response> {
  const session = await getSession();
  if (!session) return problem(401, "unauthenticated");
  const member = await membership(vaultId, session.accountId, roles);
  if (!member) return problem(403, "forbidden");
  if (member.network !== (await requestNetwork())) {
    return problem(409, "wrong_network", wrongNetworkSentence(member.network));
  }
  return { session, member };
}
