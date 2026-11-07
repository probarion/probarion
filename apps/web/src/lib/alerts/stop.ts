import { getSodium, keyedHashHex } from "@/lib/crypto/sodium";

// The stop link of an alert email (RFC 8058 one-click as well): `?s=<subscription id>&t=<token>`, where the token is a
// keyed hash of the id under the `alerts` subkey. Whoever holds the email can stop that one subscription and nothing else,
// without signing in, and nobody can make a link for an id without the key. A new KEY_ENCRYPTION_SECRET changes the
// subkey, so the links in earlier emails stop working (the console's Remove button does not depend on it).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;

export const stopToken = (key: Uint8Array, subscriptionId: string): Promise<string> =>
  keyedHashHex(key, `alert-stop:${subscriptionId}`);

/** True only for the token of this id under this key. The comparison is constant time (sodium.memcmp). */
export async function verifyStopToken(
  key: Uint8Array,
  subscriptionId: string,
  token: string,
): Promise<boolean> {
  if (!UUID.test(subscriptionId) || !TOKEN.test(token)) return false;
  const s = await getSodium();
  const want = s.from_hex(await stopToken(key, subscriptionId));
  return s.memcmp(want, s.from_hex(token));
}

export interface StopLinks {
  /** The page a person opens: it shows a button, and the button stops the alerts. */
  page: string;
  /** What a mail client POSTs to for one-click unsubscribe. */
  oneClick: string;
}

export async function stopLinks(
  origin: string,
  key: Uint8Array,
  subscriptionId: string,
): Promise<StopLinks> {
  const query = `s=${subscriptionId}&t=${await stopToken(key, subscriptionId)}`;
  return { page: `${origin}/alerts/stop?${query}`, oneClick: `${origin}/api/alerts/stop?${query}` };
}

/** The id and the token from a query, or null when either is missing or not the shape a real link has. */
export function parseStopParams(
  q: URLSearchParams | Record<string, string | string[] | undefined>,
): { id: string; token: string } | null {
  const get = (name: string) => {
    const v = q instanceof URLSearchParams ? q.get(name) : q[name];
    return typeof v === "string" ? v : null;
  };
  const id = get("s");
  const token = get("t");
  return id !== null && token !== null && UUID.test(id) && TOKEN.test(token) ? { id, token } : null;
}
