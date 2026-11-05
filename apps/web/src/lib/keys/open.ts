import "server-only";
import { DecryptError } from "@/lib/crypto/sodium";
import { DbError } from "@/lib/db/port";
import { KeyMismatchError } from "./service";

// How the two money paths (the Payables pipeline and the owner's Confirm) open a sealed key. One classification, so
// both answer the same key failure the same way.

/** Why a key could not be used. None of them is ever answered with another key. */
export type KeyProblem = "inactive" | "decrypt_failed" | "key_mismatch";

export type OpenedKey = { key: { publicKey: string; secret: string } } | { problem: KeyProblem };

/** The key, or why it cannot be used: null is `inactive`; a decrypt failure and a key mismatch say so. */
export async function openKey(
  load: () => Promise<{ publicKey: string; secret: string } | null>,
): Promise<OpenedKey> {
  try {
    const key = await load();
    return key ? { key } : { problem: "inactive" };
  } catch (e) {
    if (e instanceof DecryptError) return { problem: "decrypt_failed" };
    if (e instanceof KeyMismatchError) return { problem: "key_mismatch" };
    // A mandate bound to a key this console cannot hold (not an ed25519 key): no secret exists for it.
    if (e instanceof DbError && e.code === "invalid_input") return { problem: "inactive" };
    throw e;
  }
}
