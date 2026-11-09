import { isKnownOrigin } from "./origins";
import { isAccount, isNetwork, isTime, type Network, TOKEN_RE } from "./storage";

// The connect handshake (spec §5.4).
// 1. The popup opens <origin>/extension?nonce=….
// 2. The person signs in there with their wallet and presses Connect. The page posts
//    { type: "probarion:connect", v: 1, nonce, token, … } to its own window.
// 3. The content script (content.ts) checks where the message came from and hands it to the worker.
// 4. The worker checks the sender and the nonce (background.ts handleConnect).

export const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;

export interface ConnectMessage {
  nonce: string;
  token: string;
  account: string;
  network: Network;
  expires_at: string;
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 16 random bytes in base64url: 22 characters. */
export function newNonce(
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  return base64url(random(16));
}

export const connectUrl = (origin: string, nonce: string): string =>
  `${origin}/extension?nonce=${encodeURIComponent(nonce)}`;

/** The page's message when it has exactly the connect shape and a token that hasn't ended; otherwise null. */
export function readConnectMessage(data: unknown, now: number): ConnectMessage | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "probarion:connect" || d.v !== 1) return null;
  const { nonce, token, account, network, expires_at } = d;
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) return null;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  if (!isAccount(account) || !isNetwork(network) || !isTime(expires_at)) return null;
  if (Date.parse(expires_at) <= now) return null;
  return { nonce, token, account, network, expires_at };
}

/**
 * A read message in the shape the page posts it. The content script hands this to the worker, which reads it again
 * with readConnectMessage: both sides read one shape, and only the connect fields cross.
 */
export const asPageMessage = (m: ConnectMessage) => ({
  type: "probarion:connect" as const,
  v: 1 as const,
  nonce: m.nonce,
  token: m.token,
  account: m.account,
  network: m.network,
  expires_at: m.expires_at,
});

/** Whether a `message` event came from this very window, at its own address, and that address is Probarion's. */
export function fromOwnPage(
  event: { source: unknown; origin: string },
  win: { location: { origin: string } },
): boolean {
  return (
    event.source === win && event.origin === win.location.origin && isKnownOrigin(event.origin)
  );
}

/** Whether a runtime message's sender is Probarion's /extension page: a trusted origin, that origin's own URL. */
export function isConnectPage(sender: {
  origin?: string;
  url?: string;
}): sender is { origin: string; url: string } {
  if (!isKnownOrigin(sender.origin) || typeof sender.url !== "string") return false;
  try {
    const u = new URL(sender.url);
    return u.origin === sender.origin && u.pathname === "/extension";
  } catch {
    return false;
  }
}
