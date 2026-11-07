import type { Network } from "@/lib/config";
import type { Db } from "@/lib/db/port";

// The rows of migration 0013 as its service-role functions read and write them. `account` and `network` come from a
// signed session (the /extension page) or a verified token, never from a request body.

/** A live token, as ext_token_use answers it. */
export interface ExtToken {
  id: string;
  account_id: string;
  network: Network;
  expires_at: string;
}

/** One line of "Connected browsers": never the token or its hash. */
export interface ExtTokenItem {
  id: string;
  hint: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}

export interface NewToken {
  account: string;
  network: Network;
  sha256: string;
  hint: string;
  label: string;
}

export function mintToken(db: Db, t: NewToken): Promise<{ id: string; expires_at: string }> {
  return db.rpc("ext_token_mint", {
    account_id: t.account,
    network: t.network,
    token_sha256: t.sha256,
    hint: t.hint,
    label: t.label,
  });
}

/** The live token with this hash on this network (its use is recorded), or null. */
export function useToken(db: Db, sha256: string, network: Network): Promise<ExtToken | null> {
  return db.rpc<ExtToken | null>("ext_token_use", { token_sha256: sha256, network });
}

export function listTokens(db: Db, account: string, network: Network): Promise<ExtTokenItem[]> {
  return db.rpc<ExtTokenItem[]>("ext_token_list", { account_id: account, network });
}

export function revokeToken(
  db: Db,
  account: string,
  network: Network,
  id: string,
): Promise<{ revoked: boolean }> {
  return db.rpc("ext_token_revoke", { account_id: account, network, id });
}

export function createPairCode(
  db: Db,
  account: string,
  network: Network,
  codeSha256: string,
): Promise<{ expires_at: string }> {
  return db.rpc("ext_code_create", { account_id: account, network, code_sha256: codeSha256 });
}

export type Exchange =
  | { ok: true; id: string; account_id: string; network: Network; expires_at: string }
  | { ok: false };

export function exchangePairCode(
  db: Db,
  e: { codeSha256: string; network: Network; sha256: string; hint: string; label: string },
): Promise<Exchange> {
  return db.rpc<Exchange>("ext_code_exchange", {
    code_sha256: e.codeSha256,
    network: e.network,
    token_sha256: e.sha256,
    hint: e.hint,
    label: e.label,
  });
}
