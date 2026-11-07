import { randomBytes } from "node:crypto";
import { sha256Hex } from "@/lib/crypto/sodium";

// The browser extension's credentials (spec §4.2). A token is `pbx_` and 32 random bytes in base64url; a pairing code is
// 8 Crockford base32 characters (40 bits), shown as XXXX-XXXX. The database keeps only their sha256.

export const TOKEN_RE = /^pbx_[A-Za-z0-9_-]{43}$/;
const BEARER = /^Bearer (pbx_[A-Za-z0-9_-]{43})$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Crockford's base32: no I, L, O or U. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
/** Control and format characters, line and paragraph separators, and a surrogate that is not part of a pair: Postgres
 * refuses JSON that carries one, so a label holding it would fail the whole pairing. */
const UNSAFE_LABEL_CHAR = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

type Random = (size: number) => Uint8Array;

export function tokenHash(token: string): string {
  return sha256Hex(token);
}

/** A new token, its hash and the last four characters shown in "Connected browsers". */
export function newToken(rand: Random = randomBytes): {
  token: string;
  sha256: string;
  hint: string;
} {
  const token = `pbx_${Buffer.from(rand(32)).toString("base64url")}`;
  return { token, sha256: tokenHash(token), hint: token.slice(-4) };
}

/** The token of an `Authorization: Bearer pbx_…` header, or null for anything else. */
export function bearerToken(headers: Headers): string | null {
  return BEARER.exec(headers.get("authorization") ?? "")?.[1] ?? null;
}

export function newPairCode(rand: Random = randomBytes): string {
  let bits = 0n;
  for (const b of rand(5)) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 7; i >= 0; i--) out += CODE_ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

export function showCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A typed code in its stored form (upper case, no dash or space, O read as 0, I and L as 1), or null. */
export function readPairCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 20) return null;
  const s = raw.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return CODE.test(s) ? s : null;
}

export function codeHash(code: string): string {
  return sha256Hex(`pair:${code}`);
}

/** The browser's name in "Connected browsers": printable, one line, at most 64 characters; else "Chrome". */
export function cleanLabel(raw: unknown): string {
  if (typeof raw !== "string") return "Chrome";
  const one = raw.replace(UNSAFE_LABEL_CHAR, "").replace(/\s+/g, " ").trim();
  const cut = [...one].slice(0, 64).join("");
  return cut === "" ? "Chrome" : cut;
}

/** The extension's connect nonce from /extension?nonce=…, or null. */
export function readNonce(raw: unknown): string | null {
  return typeof raw === "string" && NONCE.test(raw) ? raw : null;
}
