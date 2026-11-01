import { inspect } from "node:util";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../src/hash.js";
import { bytesToHex, hexToBytes, utf8 } from "../src/hex.js";
import {
  createEd25519Signer,
  ED25519_PREFIX,
  formatPublicKey,
  formatSignature,
  generateKeyPair,
  KeyFormatError,
  parsePublicKey,
  parseSecretKey,
  parseSignature,
  publicKeyFromSecret,
  verifyEd25519,
} from "../src/keys.js";
import { nodeSign, nodeVerify } from "./helpers/node-ed25519.js";

// RFC 8032 §7.1 TEST 1 (empty message).
const RFC_SEED = hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const RFC_PUB = hexToBytes("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
const RFC_SIG = hexToBytes(
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
);

// The order of the Ed25519 base point group; a signature's S must be below it.
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

/** The same signature with S replaced by S + L: a different encoding of the same scalar. */
function malleate(sig: Uint8Array): Uint8Array {
  const out = sig.slice();
  let s = 0n;
  for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(out[32 + i] ?? 0);
  s += L;
  for (let i = 0; i < 32; i++) {
    out[32 + i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return out;
}

describe("NEAR ed25519 keys", () => {
  it("derives NEAR-format keys from a seed (RFC 8032 vector)", () => {
    const pair = generateKeyPair(RFC_SEED);
    expect(pair.publicKey).toBe(`ed25519:${bs58.encode(RFC_PUB)}`);
    expect(publicKeyFromSecret(pair.secretKey)).toBe(pair.publicKey);
    expect(parseSecretKey(pair.secretKey).seed).toEqual(RFC_SEED);
  });

  it("verifies the RFC 8032 signature", () => {
    expect(
      verifyEd25519(formatSignature(RFC_SIG), new Uint8Array(0), formatPublicKey(RFC_PUB)),
    ).toBe(true);
    expect(
      verifyEd25519(formatSignature(RFC_SIG), new Uint8Array([1]), formatPublicKey(RFC_PUB)),
    ).toBe(false);
  });

  it("signs ledger body hashes with the ledger key", async () => {
    const pair = generateKeyPair(RFC_SEED);
    const sign = createEd25519Signer(pair.secretKey);
    const message = new Uint8Array(32).fill(7);
    const { sig, signer } = await sign(message);
    expect(signer).toBe(pair.publicKey);
    expect(verifyEd25519(sig, message, signer)).toBe(true);
  });

  it("rejects malformed keys and a secret whose public half does not match", () => {
    expect(() => parsePublicKey("secp256k1:abc")).toThrow(KeyFormatError);
    expect(() => parsePublicKey("ed25519:0OIl")).toThrow(KeyFormatError);
    expect(() => parsePublicKey(`ed25519:${bs58.encode(new Uint8Array(31))}`)).toThrow(
      KeyFormatError,
    );
    const wrong = new Uint8Array(64);
    wrong.set(RFC_SEED, 0);
    expect(() => parseSecretKey(`ed25519:${bs58.encode(wrong)}`)).toThrow(KeyFormatError);
    expect(verifyEd25519("ed25519:bad", new Uint8Array(0), formatPublicKey(RFC_PUB))).toBe(false);
  });

  it("generates distinct random keys when no seed is given", () => {
    expect(generateKeyPair().publicKey).not.toBe(generateKeyPair().publicKey);
  });
});

describe("text format is NEAR's (what set_ledger_key and near-api-js take)", () => {
  // A public key as it appears in NEAR docs and RPC responses.
  const NEAR_SAMPLE = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

  it("parses and formats a NEAR public key without changing it", () => {
    expect(ED25519_PREFIX).toBe("ed25519:");
    const raw = parsePublicKey(NEAR_SAMPLE);
    expect(raw).toHaveLength(32);
    expect(formatPublicKey(raw)).toBe(NEAR_SAMPLE);
    // The 32 zero bytes, as the contract tests and the mirror types write them.
    expect(parsePublicKey(`ed25519:${"1".repeat(32)}`)).toEqual(new Uint8Array(32));
  });

  it("writes a secret key as base58 of seed || public key, and a signature as base58 of 64 bytes", () => {
    const pair = generateKeyPair(RFC_SEED);
    const full = new Uint8Array(64);
    full.set(RFC_SEED, 0);
    full.set(RFC_PUB, 32);
    expect(pair.secretKey).toBe(`ed25519:${bs58.encode(full)}`);
    expect(formatSignature(RFC_SIG)).toBe(`ed25519:${bs58.encode(RFC_SIG)}`);
    expect(parseSignature(formatSignature(RFC_SIG))).toEqual(RFC_SIG);
  });

  it("accepts a bare 32-byte seed as a secret key and signs identically", async () => {
    const bare = `ed25519:${bs58.encode(RFC_SEED)}`;
    expect(publicKeyFromSecret(bare)).toBe(generateKeyPair(RFC_SEED).publicKey);
    const message = sha256Bytes(utf8("bare seed"));
    const a = await createEd25519Signer(bare)(message);
    const b = await createEd25519Signer(generateKeyPair(RFC_SEED).secretKey)(message);
    expect(a).toEqual(b);
  });

  it("rejects wrong lengths, wrong prefixes and values that are not strings", () => {
    expect(() => parseSignature(`ed25519:${bs58.encode(new Uint8Array(63))}`)).toThrow(
      KeyFormatError,
    );
    expect(() => parseSignature(bs58.encode(RFC_SIG))).toThrow(KeyFormatError);
    expect(() => formatSignature(new Uint8Array(65))).toThrow(KeyFormatError);
    expect(() => formatPublicKey(new Uint8Array(33))).toThrow(KeyFormatError);
    expect(() => generateKeyPair(new Uint8Array(31))).toThrow(KeyFormatError);
    expect(() => parsePublicKey(undefined as unknown as string)).toThrow(KeyFormatError);
    expect(() => parseSecretKey(42 as unknown as string)).toThrow(KeyFormatError);
    expect(() => parseSignature(null as unknown as string)).toThrow(KeyFormatError);
  });
});

describe("signing is plain Ed25519 over the raw 32 bytes (checked against node:crypto)", () => {
  const seed = sha256Bytes(utf8("probarion/test-fixture/node-cross-check"));
  const pair = generateKeyPair(seed);
  const message = sha256Bytes(utf8("a ledger body hash"));

  it("produces exactly the signature node:crypto produces, and node:crypto verifies it", async () => {
    const { sig } = await createEd25519Signer(pair.secretKey)(message);
    const raw = parseSignature(sig);
    expect(bytesToHex(raw)).toBe(bytesToHex(nodeSign(seed, message)));
    expect(nodeVerify(raw, message, parsePublicKey(pair.publicKey))).toBe(true);
  });

  it("signs deterministically", async () => {
    const sign = createEd25519Signer(pair.secretKey);
    expect(await sign(message)).toEqual(await sign(message));
  });

  it("verifies a signature made by node:crypto", () => {
    const sig = formatSignature(nodeSign(seed, message));
    expect(verifyEd25519(sig, message, pair.publicKey)).toBe(true);
  });

  it("refuses to sign anything that is not a 32-byte hash", async () => {
    const sign = createEd25519Signer(pair.secretKey);
    await expect(sign(new Uint8Array(31))).rejects.toThrow(KeyFormatError);
    await expect(sign(new Uint8Array(0))).rejects.toThrow(KeyFormatError);
    await expect(sign(new Uint8Array(64))).rejects.toThrow(KeyFormatError);
  });
});

describe("verification is strict", () => {
  const pair = generateKeyPair(RFC_SEED);
  const message = new Uint8Array(0);
  const sig = formatSignature(RFC_SIG);

  it("rejects a wrong key, a wrong message and a flipped signature bit", () => {
    expect(verifyEd25519(sig, message, pair.publicKey)).toBe(true);
    expect(verifyEd25519(sig, message, generateKeyPair(sha256Bytes(utf8("other"))).publicKey)).toBe(
      false,
    );
    expect(verifyEd25519(sig, new Uint8Array(1), pair.publicKey)).toBe(false);
    const flipped = RFC_SIG.slice();
    flipped[10] = (flipped[10] ?? 0) ^ 1;
    expect(verifyEd25519(formatSignature(flipped), message, pair.publicKey)).toBe(false);
  });

  it("rejects the S + L encoding of a valid signature", () => {
    const mall = malleate(RFC_SIG);
    expect(bytesToHex(mall)).not.toBe(bytesToHex(RFC_SIG));
    expect(verifyEd25519(formatSignature(mall), message, pair.publicKey)).toBe(false);
  });

  it("returns false, never throws, for malformed input", () => {
    expect(verifyEd25519("", message, pair.publicKey)).toBe(false);
    expect(verifyEd25519(sig, message, "ed25519:")).toBe(false);
    expect(verifyEd25519(sig, message, "not a key")).toBe(false);
    expect(verifyEd25519(undefined as unknown as string, message, pair.publicKey)).toBe(false);
    expect(verifyEd25519(sig, message, undefined as unknown as string)).toBe(false);
    expect(
      verifyEd25519(`ed25519:${bs58.encode(new Uint8Array(64))}`, message, pair.publicKey),
    ).toBe(false);
  });
});

describe("secret keys stay out of logs and serialisation", () => {
  const pair = generateKeyPair(RFC_SEED);
  const secret = pair.secretKey;
  const seedB58 = bs58.encode(RFC_SEED);
  const seedHex = bytesToHex(RFC_SEED);

  function leaks(text: string): boolean {
    return text.includes(secret) || text.includes(seedB58) || text.includes(seedHex);
  }

  it("keeps secretKey out of JSON.stringify, console.log, spread and Object.keys", () => {
    expect(JSON.stringify(pair)).toBe(JSON.stringify({ publicKey: pair.publicKey }));
    expect(leaks(JSON.stringify(pair))).toBe(false);
    expect(leaks(inspect(pair, { depth: 5 }))).toBe(false);
    expect(leaks(JSON.stringify({ ...pair }))).toBe(false);
    expect(Object.keys(pair)).toEqual(["publicKey"]);
    expect(leaks(`${JSON.stringify([pair, { nested: pair }])}`)).toBe(false);
  });

  it("still hands the secret out on an explicit read, and it cannot be overwritten", () => {
    expect(pair.secretKey).toBe(secret);
    expect(parseSecretKey(pair.secretKey).seed).toEqual(RFC_SEED);
    expect(() => {
      (pair as { secretKey: string }).secretKey = "ed25519:other";
    }).toThrow(TypeError);
    expect(pair.secretKey).toBe(secret);
  });

  it("does not echo a rejected secret key in the error", () => {
    const mismatched = new Uint8Array(64);
    mismatched.set(RFC_SEED, 0);
    const wrongHalf = `ed25519:${bs58.encode(mismatched)}`;
    const wrongLength = `ed25519:${bs58.encode(new Uint8Array(40).fill(9))}`;
    for (const candidate of [wrongHalf, wrongLength, "ed25519:0OIl", secret.slice(0, -2)]) {
      let thrown: unknown = null;
      try {
        parseSecretKey(candidate);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(KeyFormatError);
      const text = `${(thrown as Error).message} ${String((thrown as Error).stack)}`;
      expect(text).not.toContain(candidate);
      expect(text).not.toContain(bs58.encode(mismatched));
      expect(leaks(text)).toBe(false);
    }
  });

  it("gives the signer closure nothing to serialise", () => {
    const sign = createEd25519Signer(secret);
    expect(JSON.stringify(sign)).toBeUndefined();
    expect(Object.keys(sign)).toEqual([]);
    expect(leaks(inspect(sign, { showHidden: true, depth: 5 }))).toBe(false);
  });
});
