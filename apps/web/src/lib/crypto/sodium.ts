import { createHash } from "node:crypto";
import sodium from "libsodium-wrappers";

export type SubkeyPurpose = "agent_keys" | "invoices" | "session" | "telegram" | "visitor";

/** Decision D4. Changing an id invalidates every value derived from it. */
const SUBKEY_IDS: Record<SubkeyPurpose, number> = {
  agent_keys: 1,
  invoices: 2,
  session: 3,
  telegram: 4,
  visitor: 5,
};
const KDF_CONTEXT = "PROBARIO"; // exactly crypto_kdf_CONTEXTBYTES (8)
const KEY_BYTES = 32; // the libsodium size for secretbox, auth, kdf and keyed hashing here
const MAC_BYTES = 32; // crypto_auth_BYTES (HMAC-SHA-512-256)

export interface Sealed {
  ciphertext: string;
  nonce: string;
}

/** Carries no detail on purpose: a failed decrypt must not say which part was wrong, nor echo any input. */
export class DecryptError extends Error {
  constructor() {
    super("decrypt_failed");
    this.name = "DecryptError";
  }
}

let ready: Promise<void> | null = null;

/** libsodium functions must be read from the default export after `ready` (README of 0.8.x). */
export async function getSodium(): Promise<typeof sodium> {
  ready ??= sodium.ready;
  await ready;
  return sodium;
}

type Base64Encoding = "base64" | "base64url";

function encode(bytes: Uint8Array, encoding: Base64Encoding): string {
  return Buffer.from(bytes).toString(encoding);
}

/**
 * Canonical decode (R7). Node's decoder is lenient: it skips whitespace and stray characters, accepts
 * either alphabet and ignores the unused trailing bits of the last character, so many different strings
 * map to the same bytes. For authenticated data that makes a value malleable. Re-encoding the decoded
 * bytes and requiring the very same string leaves exactly one accepted spelling: `encode` standard
 * padded base64 ("base64", libsodium's ORIGINAL variant) or unpadded url-safe base64 ("base64url").
 * Returns null for anything else, including a value that is not a string.
 */
function decodeCanonical(value: unknown, encoding: Base64Encoding): Uint8Array | null {
  if (typeof value !== "string") return null;
  const bytes = new Uint8Array(Buffer.from(value, encoding));
  return encode(bytes, encoding) === value ? bytes : null;
}

/** Every key in this module is a 32-byte subkey or master; any other length is a bug, so fail closed. */
function requireKey(key: unknown, what = "key"): asserts key is Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new Error(`${what} must be ${KEY_BYTES} bytes`);
  }
}

/** The message names the variable and the rule, never the value. */
export function parseMasterKey(b64: string): Uint8Array {
  const bytes = decodeCanonical(b64, "base64");
  if (bytes === null || bytes.length !== KEY_BYTES) {
    throw new Error("KEY_ENCRYPTION_SECRET must be 32 bytes encoded as base64");
  }
  return bytes;
}

export async function deriveSubkey(
  master: Uint8Array,
  purpose: SubkeyPurpose,
): Promise<Uint8Array> {
  requireKey(master, "master key");
  if (!Object.hasOwn(SUBKEY_IDS, purpose)) throw new Error("unknown subkey purpose");
  const s = await getSodium();
  return s.crypto_kdf_derive_from_key(KEY_BYTES, SUBKEY_IDS[purpose], KDF_CONTEXT, master);
}

export async function seal(key: Uint8Array, plaintext: Uint8Array | string): Promise<Sealed> {
  requireKey(key);
  const s = await getSodium();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const msg = typeof plaintext === "string" ? s.from_string(plaintext) : plaintext;
  const ct = s.crypto_secretbox_easy(msg, nonce, key);
  return { ciphertext: encode(ct, "base64"), nonce: encode(nonce, "base64") };
}

/** Throws `DecryptError` for anything that is not exactly what `seal` produced under this key. */
export async function open(key: Uint8Array, sealed: Sealed): Promise<Uint8Array> {
  requireKey(key);
  const s = await getSodium();
  const nonce = decodeCanonical(sealed?.nonce, "base64");
  const ciphertext = decodeCanonical(sealed?.ciphertext, "base64");
  if (
    nonce === null ||
    ciphertext === null ||
    nonce.length !== s.crypto_secretbox_NONCEBYTES ||
    ciphertext.length < s.crypto_secretbox_MACBYTES
  ) {
    throw new DecryptError();
  }
  try {
    return s.crypto_secretbox_open_easy(ciphertext, nonce, key);
  } catch {
    throw new DecryptError();
  }
}

/** Spec §9: "Invoices are encrypted at rest with a per-tenant key." */
export async function tenantInvoiceKey(master: Uint8Array, tenantId: string): Promise<Uint8Array> {
  // An empty id would give every caller that forgot to pass one the same key.
  if (typeof tenantId !== "string" || tenantId === "") throw new Error("tenantId is required");
  const s = await getSodium();
  const sub = await deriveSubkey(master, "invoices");
  return s.crypto_generichash(KEY_BYTES, s.from_string(`invoice:${tenantId}`), sub);
}

export async function keyedHashHex(key: Uint8Array, message: string): Promise<string> {
  requireKey(key);
  const s = await getSodium();
  return s.to_hex(s.crypto_generichash(KEY_BYTES, s.from_string(message), key));
}

export async function macToken(key: Uint8Array, payload: object): Promise<string> {
  requireKey(key);
  const s = await getSodium();
  const body = encode(s.from_string(JSON.stringify(payload)), "base64url");
  const tag = s.crypto_auth(s.from_string(body), key);
  return `${body}.${encode(tag, "base64url")}`;
}

/** Null for every kind of bad token (shape, encoding, length, tag, JSON); a wrong-length key throws. */
export async function readMacToken<T>(key: Uint8Array, token: string): Promise<T | null> {
  requireKey(key);
  if (typeof token !== "string") return null;
  const s = await getSodium();
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, tag] = parts as [string, string];
  // R7: the tag must be the one canonical spelling of its bytes, or a token stays valid while its text changes.
  const received = decodeCanonical(tag, "base64url");
  if (received === null || received.length !== MAC_BYTES) return null;
  const expected = s.crypto_auth(s.from_string(body), key);
  if (!s.memcmp(expected, received)) return null; // constant time
  // Authenticated, so parsing is safe; the body is held to the same canonical rule.
  const json = decodeCanonical(body, "base64url");
  if (json === null) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)) as T;
  } catch {
    return null;
  }
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}
