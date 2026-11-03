// Test doubles for the NEP-413 sign-in. The hash is written out here, independently of near-api-js,
// from NEPs/nep-0413.md: sha256(u32le(2^31 + 413) || borsh(Payload)), so a mistake in the library's
// serialisation (or in how we call it) shows up as a failed signature.
import { createHash } from "node:crypto";
import { KeyPair } from "near-api-js";

export function nep413Hash(
  message: string,
  nonce: Uint8Array,
  recipient: string,
  callbackUrl: string | null = null,
): Uint8Array {
  const enc = new TextEncoder();
  const str = (s: string) => {
    const b = enc.encode(s);
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, b.length, true);
    out.set(b, 4);
    return out;
  };
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, 2147484061, true);
  const callback =
    callbackUrl === null
      ? new Uint8Array([0])
      : Buffer.concat([new Uint8Array([1]), str(callbackUrl)]);
  const all = Buffer.concat([tag, str(message), nonce, str(recipient), callback]);
  return new Uint8Array(createHash("sha256").update(all).digest());
}

export interface Signed {
  publicKey: string;
  /** Standard padded base64 of the 64 signature bytes, as the browser sends it. */
  signature: string;
  keyPair: KeyPair;
}

/** Signs the NEP-413 payload with `keyPair` (a fresh ed25519 key unless one is given). */
export function signNep413(p: {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  keyPair?: KeyPair;
}): Signed {
  const keyPair = p.keyPair ?? KeyPair.fromRandom("ed25519");
  const sig = keyPair.sign(nep413Hash(p.message, p.nonce, p.recipient));
  return {
    publicKey: keyPair.getPublicKey().toString(),
    signature: Buffer.from(sig.signature).toString("base64"),
    keyPair,
  };
}

/** What `view_access_key` answers for a full-access key. */
export const FULL_ACCESS_KEY = {
  nonce: 0,
  permission: "FullAccess",
  block_height: 1,
  block_hash: "h",
};

/** What `view_access_key` answers for a function-call key. */
export const FUNCTION_CALL_KEY = {
  nonce: 0,
  permission: {
    FunctionCall: {
      allowance: "1000000000000000000000000",
      receiver_id: "x.near",
      method_names: [],
    },
  },
  block_height: 1,
  block_hash: "h",
};
