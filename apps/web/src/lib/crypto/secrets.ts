import {
  DecryptError,
  deriveSubkey,
  open,
  type Sealed,
  sameKey,
  seal,
  tenantInvoiceKey,
} from "./sodium";

export const KEY_VERSION = 1;

export interface SealedSecret extends Sealed {
  key_version: number;
}

export interface StoredSecret {
  secret_ciphertext: string;
  secret_nonce: string;
}

export async function sealAgentSecret(master: Uint8Array, secret: string): Promise<SealedSecret> {
  const key = await deriveSubkey(master, "agent_keys");
  return { ...(await seal(key, secret)), key_version: KEY_VERSION };
}

export async function openAgentSecret(master: Uint8Array, row: StoredSecret): Promise<string> {
  const key = await deriveSubkey(master, "agent_keys");
  const bytes = await open(key, { ciphertext: row.secret_ciphertext, nonce: row.secret_nonce });
  try {
    // Fatal, so damaged text is a failure and never a string with replacement characters.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DecryptError();
  }
}

export async function sealInvoice(
  master: Uint8Array,
  tenantId: string,
  content: Uint8Array,
): Promise<Sealed> {
  return seal(await tenantInvoiceKey(master, tenantId), content);
}

export async function openInvoice(
  master: Uint8Array,
  tenantId: string,
  sealed: Sealed,
): Promise<Uint8Array> {
  return open(await tenantInvoiceKey(master, tenantId), sealed);
}

/**
 * A "rotation" to the very same master would re-seal every row under the key that was just retired.
 * After a key leak that looks like a successful rotation while the leaked key still opens everything,
 * so it is refused, before anything is decrypted. The message carries no key material.
 */
async function refuseSameMaster(oldMaster: Uint8Array, newMaster: Uint8Array): Promise<void> {
  if (await sameKey(oldMaster, newMaster)) {
    throw new Error("old and new master keys are identical: rotation needs a different key");
  }
}

/** Rotation (spec §11): decrypt with the old master, encrypt with the new one, bump key_version. */
export async function reencryptAgentSecret(
  oldMaster: Uint8Array,
  newMaster: Uint8Array,
  row: StoredSecret & { key_version: number },
): Promise<SealedSecret> {
  // A version that is not a positive safe integer would make "+ 1" meaningless; refuse before decrypting.
  const v = row.key_version;
  if (!Number.isSafeInteger(v) || v < 1 || v >= Number.MAX_SAFE_INTEGER) {
    throw new Error("key_version must be a positive integer below 2^53 - 1");
  }
  await refuseSameMaster(oldMaster, newMaster);
  const secret = await openAgentSecret(oldMaster, row);
  const key = await deriveSubkey(newMaster, "agent_keys");
  return { ...(await seal(key, secret)), key_version: v + 1 };
}

export async function reencryptInvoice(
  oldMaster: Uint8Array,
  newMaster: Uint8Array,
  tenantId: string,
  sealed: Sealed,
): Promise<Sealed> {
  await refuseSameMaster(oldMaster, newMaster);
  return sealInvoice(newMaster, tenantId, await openInvoice(oldMaster, tenantId, sealed));
}
