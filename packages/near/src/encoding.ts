// Internal helpers (S0, integrator-owned; not re-exported by index.ts): strict parsers for the encodings NEAR
// uses (base58 hashes, decimal u64/u128 strings, padded base64), hashing, and a Borsh writer. Every parser
// returns null for anything but the canonical spelling, so two different strings never stand for one value.
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";

export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
const U32_MAX = 0xffff_ffff;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------- bytes ----------

/** sha256 of the concatenation of `parts`. */
export function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  const hash = nobleSha256.create();
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------- hex ----------

const HEX_DIGITS_RE = /^[0-9a-fA-F]*$/;

/** Lowercase hex, no prefix. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Hex digits in either case, with an optional `0x` prefix and an even length; null for anything else. */
export function hexToBytes(text: unknown): Uint8Array | null {
  if (typeof text !== "string") return null;
  const digits = text.startsWith("0x") ? text.slice(2) : text;
  if (digits.length % 2 !== 0 || !HEX_DIGITS_RE.test(digits)) return null;
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ---------- base58 ----------

/** Every 32-byte value is 32 to 44 base58 characters; the bound only caps the cost of decoding. */
const BASE58_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function encodeBase58(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

/**
 * A NEAR `CryptoHash` (a block, chunk, transaction or receipt hash, a Merkle node): base58 (Bitcoin alphabet) that
 * decodes to exactly 32 bytes and is the canonical spelling of those bytes (`encodeBase58(decoded) === text`), so
 * a decoder that accepts other spellings cannot let two strings name one hash. A hash with an extra leading `1`
 * (one more zero byte) decodes to 33 bytes and is refused. Null for anything else.
 */
export function decodeBase58Hash(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || !BASE58_HASH_RE.test(text)) return null;
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(text);
  } catch {
    return null;
  }
  if (decoded.length !== 32 || bs58.encode(decoded) !== text) return null;
  return decoded;
}

export function isBase58Hash(value: unknown): value is string {
  return decodeBase58Hash(value) !== null;
}

// ---------- integers ----------

const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

function parseUnsigned(text: unknown, max: bigint, maxDigits: number): bigint | null {
  // A JSON number is refused: above 2^53 it has already lost digits by the time it is read.
  if (typeof text !== "string" || text.length > maxDigits || !DECIMAL_RE.test(text)) return null;
  const value = BigInt(text);
  return value <= max ? value : null;
}

/** A NEAR `U128` JSON value (balances, `tokens_burnt`, NEP-141 amounts): a canonical decimal string up to 2^128 - 1. */
export function parseU128(text: unknown): bigint | null {
  return parseUnsigned(text, U128_MAX, 39);
}

/** A `U64` JSON string (`timestamp_nanosec`, nonces): a canonical decimal string up to 2^64 - 1. */
export function parseU64(text: unknown): bigint | null {
  return parseUnsigned(text, U64_MAX, 20);
}

/** A count, height or gas figure that JSON carries as a number: a non-negative safe integer, else null. */
export function parseSafeCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value === 0 ? 0 : value; // -0 reads as 0
}

// ---------- base64 ----------

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** btoa and String.fromCharCode take one string; chunks keep the argument list short for large inputs. */
const CHUNK = 0x8000;

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Padded standard base64 (RFC 4648 section 4), as NEAR prints `SuccessValue` and `FunctionCall.args`. The empty
 * string is zero bytes. Whitespace, the URL-safe alphabet, missing padding and non-zero trailing bits (`QR==` for
 * `QQ==`) are refused: the text must be what `encodeBase64` gives for the bytes. Null for anything else.
 */
export function decodeBase64(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || text.length % 4 !== 0 || !BASE64_RE.test(text)) return null;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return encodeBase64(out) === text ? out : null;
}

// ---------- account ids ----------

/**
 * The NEAR AccountId grammar (near-account-id), as @probarion/core's formats.ts has it: 2 to 64 characters,
 * lowercase `[a-z0-9]` parts separated by `.`, `_` or `-`, with no leading, trailing or doubled separator. A 64-hex
 * implicit account (and a `0x` EVM implicit account) is a single part, so it fits as well.
 */
const NEAR_ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isAccountId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.length <= 64 &&
    NEAR_ACCOUNT_ID_RE.test(value)
  );
}

// ---------- Borsh ----------

/**
 * A Borsh serializer for the few types NEAR hashes: little-endian unsigned integers, fixed byte arrays,
 * `Vec<u8>` and `String` (u32 length, then the bytes). Each method checks its range and throws RangeError, so a
 * value that does not fit is never truncated into a different one. Methods chain.
 */
export class BorshWriter {
  private readonly parts: Uint8Array[] = [];

  u8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`u8 out of range: ${value}`);
    }
    this.parts.push(Uint8Array.of(value));
    return this;
  }

  u32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
      throw new RangeError(`u32 out of range: ${value}`);
    }
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    this.parts.push(out);
    return this;
  }

  u64(value: bigint): this {
    if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
      throw new RangeError(`u64 out of range: ${String(value)}`);
    }
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, value, true);
    this.parts.push(out);
    return this;
  }

  u128(value: bigint): this {
    if (typeof value !== "bigint" || value < 0n || value > U128_MAX) {
      throw new RangeError(`u128 out of range: ${String(value)}`);
    }
    const out = new Uint8Array(16);
    const view = new DataView(out.buffer);
    view.setBigUint64(0, value & U64_MAX, true);
    view.setBigUint64(8, value >> 64n, true);
    this.parts.push(out);
    return this;
  }

  /** A fixed-size array (`[u8; N]`, a `CryptoHash`): the bytes with no length prefix. */
  fixed(bytes: Uint8Array): this {
    this.parts.push(bytes.slice());
    return this;
  }

  /** `Vec<u8>`: u32 length, then the bytes. */
  bytes(bytes: Uint8Array): this {
    this.u32(bytes.length);
    return this.fixed(bytes);
  }

  /** `String`: u32 length of the UTF-8 bytes, then the bytes. */
  string(text: string): this {
    return this.bytes(utf8(text));
  }

  toBytes(): Uint8Array {
    return concatBytes(...this.parts);
  }
}
