import "server-only";
import { membership } from "@/lib/auth/guard";
import type { Network } from "@/lib/config";
import type { Db } from "@/lib/db/port";
import type { MemberRole, MemberTenant } from "@/lib/db/tenants";
import { problem } from "@/lib/http";
import { requestNetwork, wrongNetworkSentence } from "@/lib/network";
import { type ExtToken, useToken as liveToken } from "./store";
import { bearerToken, tokenHash } from "./token";

// The extension's API is authenticated by its token alone: an `Authorization: Bearer pbx_…` header, never a cookie. A
// browser never adds a bearer token on its own, so no other page can make these calls for someone (no CSRF). The routes
// send no CORS headers either, so no other page can read an answer. The extension itself is not bound by CORS on the
// origins it holds a host permission for. test/ext-structure.test.ts holds the routes to this.

const RECONNECT = "Connect the extension again: open Probarion, then Browser extension.";

/** The verified token of this request and the request's network, or a 401. */
export async function extAuth(
  req: Request,
  db: Db,
): Promise<{ token: ExtToken; network: Network } | Response> {
  const raw = bearerToken(req.headers);
  if (raw === null) return problem(401, "bad_token", RECONNECT);
  // The network of the address the call is made at: a token minted at the other network's address is not found here.
  const network = await requestNetwork();
  // The store's useToken, under another name: Biome reads a call to any `use…` function as a React hook call.
  const token = await liveToken(db, tokenHash(raw), network);
  if (token === null || token.network !== network) return problem(401, "bad_token", RECONNECT);
  return { token, network };
}

/** The token's account as a member of `vaultId`, re-read on every request; 403 or 409 otherwise. */
export async function extMember(
  token: ExtToken,
  vaultId: unknown,
  roles?: MemberRole[],
): Promise<MemberTenant | Response> {
  if (typeof vaultId !== "string") return problem(400, "invalid_input", "Name the vault.");
  const member = await membership(vaultId, token.account_id, roles);
  if (member === null) {
    return problem(
      403,
      "not_member",
      "You are not a member of this vault, or your role cannot do this.",
    );
  }
  if (member.network !== token.network) {
    return problem(409, "wrong_network", wrongNetworkSentence(member.network));
  }
  return member;
}
