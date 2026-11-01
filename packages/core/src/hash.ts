import { sha256 } from "@noble/hashes/sha2.js";
import canonicalize from "canonicalize";
import { bytesToHex, utf8 } from "./hex.js";
import type { Hex32 } from "./types.js";

export class CanonicalJsonError extends Error {
  override name = "CanonicalJsonError";
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return sha256(data);
}

export function sha256Hex(data: Uint8Array | string): Hex32 {
  return bytesToHex(sha256(typeof data === "string" ? utf8(data) : data));
}

/** Rejects every value that would not survive a JSON round trip unchanged. */
function assertJsonSafe(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number at ${path}`);
      return;
    case "object": {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (!(i in value) || value[i] === undefined) {
            throw new CanonicalJsonError(`undefined array element at ${path}[${i}]`);
          }
          assertJsonSafe(value[i], `${path}[${i}]`);
        }
        return;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError(`non-plain object at ${path}`);
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (child === undefined) throw new CanonicalJsonError(`undefined value at ${path}.${key}`);
        assertJsonSafe(child, `${path}.${key}`);
      }
      return;
    }
    default:
      throw new CanonicalJsonError(`${typeof value} is not JSON at ${path}`);
  }
}

/** RFC 8785 canonical JSON. Throws `CanonicalJsonError` instead of silently dropping values. */
export function canonicalJson(value: unknown): string {
  assertJsonSafe(value, "$");
  const out = canonicalize(value);
  if (out === undefined) throw new CanonicalJsonError("value is not serialisable");
  return out;
}
