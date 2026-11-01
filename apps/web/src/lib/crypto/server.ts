import "server-only";
import { getEnv } from "@/lib/env";
import { deriveSubkey, parseMasterKey, type SubkeyPurpose } from "./sodium";

let master: Uint8Array | null = null;
const cache = new Map<SubkeyPurpose, Promise<Uint8Array>>();

/** Throws (naming the variable, never its value) when KEY_ENCRYPTION_SECRET is missing or not 32 bytes of base64. */
export function masterKey(): Uint8Array {
  master ??= parseMasterKey(getEnv().KEY_ENCRYPTION_SECRET);
  return master;
}

/**
 * The KDF subkey for one purpose (decision D4), derived once per process. Sessions use "session", sign-in
 * challenges "challenge"; a token sealed under one never verifies under the other.
 *
 * A failed derivation is dropped from the cache, so one transient failure (the sodium module not ready yet)
 * does not leave every later call holding the same rejected promise.
 */
export function subkey(purpose: SubkeyPurpose): Promise<Uint8Array> {
  let k = cache.get(purpose);
  if (!k) {
    try {
      k = deriveSubkey(masterKey(), purpose);
    } catch (error) {
      return Promise.reject(error);
    }
    cache.set(purpose, k);
    k.catch(() => {
      if (cache.get(purpose) === k) cache.delete(purpose);
    });
  }
  return k;
}
