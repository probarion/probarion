import type { Db } from "@/lib/db/port";
import { verifyStopToken } from "./stop";

// What the public alert pages do with a link code or a stop token. Nothing here reads a session: the code (an email's
// confirmation link) or the keyed token (its stop link) is the whole credential, and a value with a bad shape is refused
// before any database call.

/** A link code is the 32 hex characters `alert_subscription_create` makes. */
export const isLinkCode = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{32}$/.test(v);

/** The vault a confirmation link is for, or null. It uses nothing up: a page can show it any number of times. */
export async function peekEmailLink(db: Db, code: unknown): Promise<string | null> {
  if (!isLinkCode(code)) return null;
  const r = await db.rpc<{ vault_id: string } | null>("alert_link_peek", {
    channel: "email",
    link_code: code,
  });
  return r?.vault_id ?? null;
}

/** Confirms the address the code is for, once; answers its vault, or null when the code is used, expired or unknown. */
export async function confirmEmailLink(db: Db, code: unknown): Promise<string | null> {
  if (!isLinkCode(code)) return null;
  const r = await db.rpc<{ vault_id: string } | null>("alert_subscription_verify", {
    channel: "email",
    link_code: code,
  });
  return r?.vault_id ?? null;
}

/** Stops a subscription when the token is the one for its id. False (and no database call) when it is not. */
export async function stopByToken(
  db: Db,
  key: Uint8Array,
  id: string,
  token: string,
): Promise<boolean> {
  if (!(await verifyStopToken(key, id, token))) return false;
  await db.rpc("alert_subscription_stop", { id });
  return true;
}
