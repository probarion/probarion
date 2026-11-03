// Ed25519 through node:crypto only, so tests can cross-check @noble against an independent
// implementation. Nothing here imports from ../../src.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function nodeSign(seed: Uint8Array, message: Uint8Array): Uint8Array {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return new Uint8Array(sign(null, message, key));
}

export function nodeVerify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  const key = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, publicKey]),
    format: "der",
    type: "spki",
  });
  return verify(null, message, key, signature);
}
