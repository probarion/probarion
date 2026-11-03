import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";
import bs58 from "bs58";
import { bytesEqual } from "./hex.js";

// Key and signature strings use NEAR's own text format, so the ledger key can be handed to
// `set_ledger_key` / near-api-js unchanged: `ed25519:<base58>` with 32 raw bytes for a public key,
// 64 for a signature and 64 (seed || public key) for a secret key.
export const ED25519_PREFIX = "ed25519:";

const BODY_HASH_LENGTH = 32;

export class KeyFormatError extends Error {
  override name = "KeyFormatError";
}

// Error messages name the kind of value and its length, never its content: a secret key must not
// end up in a log line through a rejected input.
function decodePrefixed(value: string, lengths: readonly number[], what: string): Uint8Array {
  if (typeof value !== "string" || !value.startsWith(ED25519_PREFIX)) {
    throw new KeyFormatError(`${what} must start with "${ED25519_PREFIX}"`);
  }
  let raw: Uint8Array;
  try {
    raw = bs58.decode(value.slice(ED25519_PREFIX.length));
  } catch {
    throw new KeyFormatError(`${what} is not valid base58`);
  }
  if (!lengths.includes(raw.length)) {
    throw new KeyFormatError(
      `${what} must decode to ${lengths.join(" or ")} bytes, got ${raw.length}`,
    );
  }
  return raw;
}

export function parsePublicKey(publicKey: string): Uint8Array {
  return decodePrefixed(publicKey, [32], "public key");
}

export function formatPublicKey(raw: Uint8Array): string {
  if (raw.length !== 32) throw new KeyFormatError("public key must be 32 bytes");
  return `${ED25519_PREFIX}${bs58.encode(raw)}`;
}

export function parseSignature(sig: string): Uint8Array {
  return decodePrefixed(sig, [64], "signature");
}

export function formatSignature(raw: Uint8Array): string {
  if (raw.length !== 64) throw new KeyFormatError("signature must be 64 bytes");
  return `${ED25519_PREFIX}${bs58.encode(raw)}`;
}

/** NEAR secret keys are base58 of 64 bytes (seed || public key); a bare 32-byte seed is accepted too. */
export function parseSecretKey(secretKey: string): { seed: Uint8Array; publicKey: Uint8Array } {
  const raw = decodePrefixed(secretKey, [32, 64], "secret key");
  const seed = raw.slice(0, 32);
  const publicKey = ed25519.getPublicKey(seed);
  if (raw.length === 64 && !bytesEqual(raw.slice(32), publicKey)) {
    throw new KeyFormatError("secret key's public half does not match its seed");
  }
  return { seed, publicKey };
}

export function publicKeyFromSecret(secretKey: string): string {
  return formatPublicKey(parseSecretKey(secretKey).publicKey);
}

export interface Ed25519KeyPair {
  publicKey: string;
  secretKey: string;
}

/**
 * `secretKey` is a non-enumerable property: it is read with `pair.secretKey` as usual, but
 * `JSON.stringify(pair)`, `console.log(pair)`, `{ ...pair }` and `Object.keys(pair)` only see the
 * public key. Writing a secret key anywhere takes an explicit `pair.secretKey`.
 */
export function generateKeyPair(seed: Uint8Array = randomBytes(32)): Ed25519KeyPair {
  if (seed.length !== 32) throw new KeyFormatError("seed must be 32 bytes");
  const publicKey = ed25519.getPublicKey(seed);
  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(publicKey, 32);
  const pair = { publicKey: formatPublicKey(publicKey) } as Ed25519KeyPair;
  Object.defineProperty(pair, "secretKey", {
    value: `${ED25519_PREFIX}${bs58.encode(full)}`,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return pair;
}

export type LedgerSigner = (bodyHash: Uint8Array) => Promise<{ sig: string; signer: string }>;

/**
 * Signs the 32 raw bytes of a ledger body hash and nothing else. The seed lives only in this
 * closure; the returned function has no properties and serialises to nothing.
 */
export function createEd25519Signer(secretKey: string): LedgerSigner {
  const { seed, publicKey } = parseSecretKey(secretKey);
  const signer = formatPublicKey(publicKey);
  return async (bodyHash) => {
    if (bodyHash.length !== BODY_HASH_LENGTH) {
      throw new KeyFormatError(`the ledger signer signs ${BODY_HASH_LENGTH}-byte body hashes only`);
    }
    return { sig: formatSignature(ed25519.sign(bodyHash, seed)), signer };
  };
}

/** Strict RFC 8032 verification (`zip215: false`): non-canonical encodings are refused, not accepted. */
export function verifyEd25519(sig: string, message: Uint8Array, publicKey: string): boolean {
  try {
    return ed25519.verify(parseSignature(sig), message, parsePublicKey(publicKey), {
      zip215: false,
    });
  } catch {
    return false;
  }
}
