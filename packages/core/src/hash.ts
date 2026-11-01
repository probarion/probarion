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

/** Containers nested deeper than this are refused; ledger bodies are a handful of levels deep. */
const MAX_CANONICAL_DEPTH = 256;

/**
 * Rejects every value that would not survive a JSON round trip unchanged. `ancestors` holds the
 * containers on the current path only, so a node referenced twice (a DAG) is fine and a cycle is not.
 */
function assertJsonSafe(value: unknown, path: string, depth: number, ancestors: Set<object>): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number at ${path}`);
      return;
    case "object": {
      if (depth >= MAX_CANONICAL_DEPTH) {
        throw new CanonicalJsonError(`nesting deeper than ${MAX_CANONICAL_DEPTH} at ${path}`);
      }
      if (ancestors.has(value)) throw new CanonicalJsonError(`circular reference at ${path}`);
      ancestors.add(value);
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (!(i in value) || value[i] === undefined) {
            throw new CanonicalJsonError(`undefined array element at ${path}[${i}]`);
          }
          assertJsonSafe(value[i], `${path}[${i}]`, depth + 1, ancestors);
        }
      } else {
        const proto: unknown = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
          throw new CanonicalJsonError(`non-plain object at ${path}`);
        }
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (child === undefined) {
            throw new CanonicalJsonError(`undefined value at ${path}.${key}`);
          }
          assertJsonSafe(child, `${path}.${key}`, depth + 1, ancestors);
        }
      }
      ancestors.delete(value);
      return;
    }
    default:
      throw new CanonicalJsonError(`${typeof value} is not JSON at ${path}`);
  }
}

/**
 * RFC 8785 canonical JSON. Every failure is a `CanonicalJsonError`: unsupported values, cycles,
 * excessive nesting, lone surrogates and anything the serialiser itself throws (original kept as `cause`).
 */
export function canonicalJson(value: unknown): string {
  try {
    assertJsonSafe(value, "$", 0, new Set());
    const out = canonicalize(value);
    if (out === undefined) throw new CanonicalJsonError("value is not serialisable");
    return out;
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new CanonicalJsonError(`cannot canonicalise: ${reason}`, { cause: error });
  }
}
