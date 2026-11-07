/**
 * Where a signed-out visitor is sent back to after signing in. The value ends up in a redirect, so it is
 * accepted only as a same-origin path: one slash, then URL-path characters. That rules out `//host`,
 * `/\host` (browsers read a backslash as a slash), `scheme:` URLs, whitespace and control characters (header
 * smuggling), `#` fragments and quotes or angle brackets. Anything else gives null, and the caller sends the
 * visitor to a plain /login.
 */
const SAFE_PATH = /^\/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;
const MAX_NEXT_LENGTH = 512;

export function safeNextPath(next: unknown): string | null {
  if (typeof next !== "string" || next.length > MAX_NEXT_LENGTH || !SAFE_PATH.test(next)) {
    return null;
  }
  // Belt and braces: the pattern already forbids what makes a relative URL leave the origin.
  try {
    if (new URL(next, "http://same-origin.invalid").origin !== "http://same-origin.invalid") {
      return null;
    }
  } catch {
    return null;
  }
  return next;
}

/** `/login?next=<encoded path>` for a safe path, else `/login`. The same shape the proxy redirects to. */
export function loginPath(next: unknown): string {
  const safe = safeNextPath(next);
  return safe === null ? "/login" : `/login?next=${encodeURIComponent(safe)}`;
}

/** The extension's connect page, with its nonce or without, exactly (lib/ext/token.ts reads the same nonce shape). */
const EXTENSION_NEXT = /^\/extension(?:\?nonce=[A-Za-z0-9_-]{22,64})?$/;

/** Where sign-in may return besides the console: `/extension` or `/extension?nonce=…`, else null. */
export function extensionNextPath(next: unknown): string | null {
  return typeof next === "string" && EXTENSION_NEXT.test(next) ? next : null;
}
