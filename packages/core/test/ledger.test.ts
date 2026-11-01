import { inspect } from "node:util";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { CanonicalJsonError, sha256Bytes, sha256Hex } from "../src/hash.js";
import { bytesToHex, concatBytes, hexToBytes, u64be, utf8 } from "../src/hex.js";
import {
  createEd25519Signer,
  formatPublicKey,
  formatSignature,
  generateKeyPair,
  KeyFormatError,
  type LedgerSigner,
  parsePublicKey,
  parseSignature,
} from "../src/keys.js";
import {
  buildEntry,
  computeBodyHash,
  computeLink,
  computeNonce,
  LedgerFormatError,
  NONCE_DOMAIN,
  type NonceContext,
  nextBodyFields,
  verifyEntrySignature,
  ZERO_LINK,
} from "../src/ledger.js";
import type { LedgerEntry, LedgerEntryBody } from "../src/types.js";
import { nodeSign, nodeVerify } from "./helpers/node-ed25519.js";

const KEY = generateKeyPair(sha256Bytes(utf8("probarion/test-fixture/ledger-test-key")));
const OTHER = generateKeyPair(sha256Bytes(utf8("probarion/test-fixture/other-key")));
const VAULT = "acme.vaults.probarion.testnet";

function body(seq: number, prevLink: string): LedgerEntryBody {
  return {
    v: 1,
    vault: VAULT,
    seq,
    prev_link: prevLink,
    kind: "decision",
    at: "2026-11-05T10:00:00.000Z",
    request_id: `req-${seq}`,
    mandate_id: 1,
    invoice_hash: sha256Hex(`invoice-${seq}`),
    amount: "25000000",
    proposal: null,
    evidence: null,
    rules: [{ id: "mandate.none", outcome: "pass", detail: "mandate 1 selected by purpose_hash" }],
    verdict: "allow",
    decided_by: "rules-only",
    contract: null,
    settlement: null,
    refs: null,
  };
}

/** Every optional object filled in, so nested key order and every field are exercised. */
function fullBody(seq: number, prevLink: string): LedgerEntryBody {
  const address = `0x${"12".repeat(20)}`;
  return {
    ...body(seq, prevLink),
    proposal: {
      action: "pay",
      mandate_id: 1,
      amount: "25000000",
      payee_hint: { near_account: "acme.near", chain: "base", address, name: "Acme Büro 東京" },
      reasoning: "Matches PO-17 for the agreed amount.",
      confidence: 0.93,
    },
    evidence: {
      provider: "near-ai-cloud",
      model: "deepseek-ai/DeepSeek-V3.1",
      chat_id: "chatcmpl-7f3a",
      nonce: sha256Hex("nonce"),
      request_sha256: sha256Hex("request"),
      response_sha256: sha256Hex("response"),
      signature: {
        text: "model:request:response",
        signature: `0x${"ab".repeat(65)}`,
        signing_address: address,
        signing_algo: "ecdsa",
      },
      report: {
        signing_address: address,
        signing_algo: "ecdsa",
        request_nonce: sha256Hex("nonce"),
        report_data: "00".repeat(64),
        intel_quote: "04".repeat(16),
        nvidia_payload: null,
        event_log: [{ imr: 3, digest: "ff", content: "x" }],
      },
      fetched_at: "2026-11-05T09:59:59.000Z",
    },
    rules: [
      { id: "mandate.none", outcome: "pass", detail: "mandate 1 selected by purpose_hash" },
      { id: "invoice.duplicate", outcome: "pass", detail: "first time this invoice is seen" },
    ],
    decided_by: "model+rules",
    contract: { code: null, tx_hash: "H7n2", spend_id: 7, status: "paid" },
    settlement: { chain: "base", tx_hash: `0x${"cd".repeat(32)}`, burn_tx_hash: "B4rn" },
    refs: { decision_body_hash: sha256Hex("decision"), anchor_seq: 2 },
  };
}

/** Rebuilds a JSON value with every object's keys inserted in reverse order; arrays keep theirs. */
function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeyOrder(child)]),
    );
  }
  return value;
}

/** Same, with keys inserted alphabetically (which is not the order the fixtures are written in). */
function sortKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeyOrder);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sortKeyOrder(child)]),
    );
  }
  return value;
}

async function chain(length: number, key = KEY, fixture = body): Promise<LedgerEntry[]> {
  const sign = createEd25519Signer(key.secretKey);
  const entries: LedgerEntry[] = [];
  for (let i = 0; i < length; i++) {
    const next = nextBodyFields(entries[i - 1] ?? null);
    entries.push(await buildEntry(fixture(next.seq, next.prev_link), sign));
  }
  return entries;
}

/**
 * What the verifier does with one entry (Task 7 checks a and b), written out from the exported
 * primitives. Returns the first thing wrong, or null.
 */
function reverify(
  entry: LedgerEntry,
  expected: { seq: number; prev_link: string; signer: string },
): string | null {
  if (entry.signer !== expected.signer) return "signer";
  if (!verifyEntrySignature(entry)) return "signature";
  if (entry.body.seq !== expected.seq) return "seq";
  if (entry.body.prev_link !== expected.prev_link) return "prev_link";
  if (computeBodyHash(entry.body) !== entry.body_hash) return "body_hash";
  if (computeLink(entry.body.prev_link, entry.body_hash, entry.sig) !== entry.link) return "link";
  return null;
}

describe("ledger hashing and signing", () => {
  it("hashes the canonical JSON of the body", () => {
    const b = body(0, ZERO_LINK);
    expect(computeBodyHash({ ...b, amount: "25000001" })).not.toBe(computeBodyHash(b));
    expect(computeBodyHash(b)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of key insertion order, in the body and in every nested object", async () => {
    const b = fullBody(0, ZERO_LINK);
    const reversed = reverseKeyOrder(b) as LedgerEntryBody;
    const sorted = sortKeyOrder(b) as LedgerEntryBody;

    // The rebuilt objects really do differ in insertion order, at the top and below.
    expect(Object.keys(reversed)).toEqual(Object.keys(b).reverse());
    expect(Object.keys(reversed)).not.toEqual(Object.keys(b));
    expect(Object.keys(sorted)).toEqual(Object.keys(b).sort());
    expect(Object.keys(sorted)).not.toEqual(Object.keys(b));
    expect(Object.keys(reversed.rules[0] ?? {})).toEqual(["detail", "outcome", "id"]);
    expect(Object.keys(reversed.proposal?.payee_hint ?? {})).toEqual(
      Object.keys(b.proposal?.payee_hint ?? {}).reverse(),
    );
    expect(Object.keys(reversed.evidence?.report ?? {})).toEqual(
      Object.keys(b.evidence?.report ?? {}).reverse(),
    );
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(b));
    expect(JSON.stringify(sorted)).not.toBe(JSON.stringify(b));

    // ...and still hash, link and sign identically.
    expect(computeBodyHash(reversed)).toBe(computeBodyHash(b));
    expect(computeBodyHash(sorted)).toBe(computeBodyHash(b));
    const sign = createEd25519Signer(KEY.secretKey);
    const entry = await buildEntry(b, sign);
    for (const variant of [reversed, sorted]) {
      const other = await buildEntry(variant, sign);
      expect(other.body_hash).toBe(entry.body_hash);
      expect(other.sig).toBe(entry.sig);
      expect(other.link).toBe(entry.link);
      expect(other.signer).toBe(entry.signer);
    }
  });

  it("links prev_link, body_hash and the raw signature", async () => {
    const entry = await buildEntry(body(0, ZERO_LINK), createEd25519Signer(KEY.secretKey));
    const manual = bytesToHex(
      sha256Bytes(
        concatBytes(hexToBytes(ZERO_LINK), hexToBytes(entry.body_hash), parseSignature(entry.sig)),
      ),
    );
    expect(entry.link).toBe(manual);
    expect(computeLink(entry.body.prev_link, entry.body_hash, entry.sig)).toBe(entry.link);
    expect(entry.signer).toBe(KEY.publicKey);
  });

  it("verifies signatures and detects a swapped signer or hash", async () => {
    const entry = await buildEntry(body(0, ZERO_LINK), createEd25519Signer(KEY.secretKey));
    expect(verifyEntrySignature(entry)).toBe(true);
    expect(verifyEntrySignature({ ...entry, signer: OTHER.publicKey })).toBe(false);
    expect(verifyEntrySignature({ ...entry, body_hash: sha256Hex("other") })).toBe(false);
  });

  it("chains entries through nextBodyFields", async () => {
    const sign = createEd25519Signer(KEY.secretKey);
    const first = await buildEntry(body(0, ZERO_LINK), sign);
    const next = nextBodyFields(first);
    expect(next).toEqual({ seq: 1, prev_link: first.link });
    expect(nextBodyFields(null)).toEqual({ seq: 0, prev_link: ZERO_LINK });
    const second = await buildEntry(body(next.seq, next.prev_link), sign);
    expect(second.body.prev_link).toBe(first.link);
  });

  it("refuses bodies with a bad seq or prev_link", async () => {
    const sign = createEd25519Signer(KEY.secretKey);
    await expect(buildEntry(body(-1, ZERO_LINK), sign)).rejects.toThrow(LedgerFormatError);
    await expect(buildEntry(body(0, sha256Hex("x")), sign)).rejects.toThrow(LedgerFormatError);
    await expect(buildEntry(body(1, "XYZ"), sign)).rejects.toThrow(LedgerFormatError);
    await expect(buildEntry(body(1.5, ZERO_LINK), sign)).rejects.toThrow(LedgerFormatError);
    await expect(buildEntry(body(Number.NaN, ZERO_LINK), sign)).rejects.toThrow(LedgerFormatError);
    await expect(buildEntry(body(2 ** 53, ZERO_LINK), sign)).rejects.toThrow(LedgerFormatError);
    await expect(buildEntry(body(1, sha256Hex("x").toUpperCase()), sign)).rejects.toThrow(
      LedgerFormatError,
    );
  });

  it("lets only the entry with seq 0 carry the all-zero prev_link", async () => {
    const sign = createEd25519Signer(KEY.secretKey);
    // seq 0 must start from zero, and nothing after it may restart the chain from zero.
    await expect(buildEntry(body(0, ZERO_LINK), sign)).resolves.toBeDefined();
    await expect(buildEntry(body(1, ZERO_LINK), sign)).rejects.toThrow(
      /only the entry with seq 0 may have the all-zero prev_link/,
    );
    await expect(buildEntry(body(1, ZERO_LINK), sign)).rejects.toThrow(LedgerFormatError);
    await expect(buildEntry(body(7, ZERO_LINK), sign)).rejects.toThrow(LedgerFormatError);
    await expect(buildEntry(body(0, sha256Hex("x")), sign)).rejects.toThrow(
      /entry with seq 0 must have the all-zero prev_link/,
    );
  });

  it("surfaces a body that cannot be canonicalised as a CanonicalJsonError", async () => {
    const sign = createEd25519Signer(KEY.secretKey);
    const broken = { ...body(0, ZERO_LINK), amount: undefined } as unknown as LedgerEntryBody;
    await expect(buildEntry(broken, sign)).rejects.toThrow(CanonicalJsonError);
  });

  it("rejects malformed inputs to computeLink", () => {
    const hash = sha256Hex("body");
    const sig = formatSignature(new Uint8Array(64).fill(1));
    expect(() => computeLink("ab", hash, sig)).toThrow(LedgerFormatError);
    expect(() => computeLink(ZERO_LINK, hash.toUpperCase(), sig)).toThrow(LedgerFormatError);
    // A malformed signature is a ledger-format problem, not a leaked key-parsing error.
    for (const badSig of [
      "ed25519:short",
      "ed25519:0OIl",
      "secp256k1:abc",
      "",
      `ed25519:${bs58.encode(new Uint8Array(63))}`,
      undefined as unknown as string,
    ]) {
      expect(() => computeLink(ZERO_LINK, hash, badSig)).toThrow(LedgerFormatError);
      expect(() => computeLink(ZERO_LINK, hash, badSig)).not.toThrow(KeyFormatError);
    }
    expect(computeLink(ZERO_LINK, hash, sig)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Independent vectors: body text written by hand with sorted keys, hashed, signed and linked with
// node:crypto alone (the key is the sha256 of the fixture label). They pin the exact bytes the
// verifier re-derives.
describe("golden ledger entries", () => {
  const GOLDEN_PUBLIC_KEY = "ed25519:51oytgJ2gvvRbwSKy2k4MGMsnDQuPqZfMUJoe7G8iMyA";
  const GOLDEN = [
    {
      body_hash: "a53902575c3cf0079e6da282647cdea11581cd8df36b86d2ce72a56cddfe84ec",
      sig: "ed25519:4z75p5QkWfHyvBwA6mb97xEzPuT7GN87EzezyfetdhY3CqKxwQBJZMbzHAnZKkUMUXMwXgqxm7w2zDM7ikTdBzSA",
      link: "13326b57ed70fc32a94ee4a7e7ab6d39f1d4152b9f5db54617ed51b1cafd82db",
    },
    {
      body_hash: "709a5aeab5059e8797f735224435dde5e569163a125af9e91a5235edbd011041",
      sig: "ed25519:5qh3Hcf65w4Cm8T9v9hSvkJ86FJKsiXVa7QAmhDAoYnDiTSXseiZNtQg7uGXAsTwQCMP3KJEPjHVHYgvgUKxEoxU",
      link: "3d2a579160635188cac793b21c38c6bf27abc9821bd3ca505d7a9fdb6d08950a",
    },
  ];

  it("builds the two golden entries byte for byte", async () => {
    expect(KEY.publicKey).toBe(GOLDEN_PUBLIC_KEY);
    const entries = await chain(2);
    for (const [i, entry] of entries.entries()) {
      expect(entry.body_hash).toBe(GOLDEN[i]?.body_hash);
      expect(entry.sig).toBe(GOLDEN[i]?.sig);
      expect(entry.link).toBe(GOLDEN[i]?.link);
      expect(entry.signer).toBe(GOLDEN_PUBLIC_KEY);
      expect(verifyEntrySignature(entry)).toBe(true);
    }
    expect(entries[1]?.body.prev_link).toBe(GOLDEN[0]?.link);
  });
});

describe("what a signature covers (interfaces §6)", () => {
  it("is plain Ed25519 over the 32 raw bytes of body_hash, not over its hex text", async () => {
    const [entry] = await chain(1);
    if (entry === undefined) throw new Error("no entry");
    const raw = parseSignature(entry.sig);
    const publicKey = parsePublicKey(entry.signer);
    expect(nodeVerify(raw, hexToBytes(entry.body_hash), publicKey)).toBe(true);
    expect(nodeVerify(raw, utf8(entry.body_hash), publicKey)).toBe(false);
    // and node:crypto, signing the same 32 bytes with the same seed, gives the same signature
    const seed = sha256Bytes(utf8("probarion/test-fixture/ledger-test-key"));
    expect(bytesToHex(nodeSign(seed, hexToBytes(entry.body_hash)))).toBe(bytesToHex(raw));
  });

  it("changes the signed hash when any single leaf, key or array element of the body changes", async () => {
    type Path = (string | number)[];
    type Node = Record<string | number, unknown>;
    const original = fullBody(3, sha256Hex("previous link"));
    const originalHash = computeBodyHash(original);
    const entry = await buildEntry(original, createEd25519Signer(KEY.secretKey));
    const signedBytes = hexToBytes(originalHash);

    const leaves = (value: unknown, path: Path = []): Path[] => {
      if (Array.isArray(value)) return value.flatMap((c, i) => leaves(c, [...path, i]));
      if (value !== null && typeof value === "object") {
        return Object.entries(value).flatMap(([k, c]) => leaves(c, [...path, k]));
      }
      return [path];
    };
    const containers = (value: unknown, path: Path = []): [Path, Node][] => {
      if (value === null || typeof value !== "object") return [];
      const own: [Path, Node][] = [[path, value as Node]];
      return own.concat(
        Object.entries(value).flatMap(([k, c]) =>
          containers(c, [...path, Array.isArray(value) ? Number(k) : k]),
        ),
      );
    };
    const edit = (mutate: (root: Node) => void): LedgerEntryBody => {
      const copy = structuredClone(original) as unknown as Node;
      mutate(copy);
      return copy as unknown as LedgerEntryBody;
    };
    const at = (root: Node, path: Path): Node => {
      let node = root;
      for (const key of path) node = node[key] as Node;
      return node;
    };
    const forgedHashIsRejected = (tampered: LedgerEntryBody): boolean => {
      const hash = computeBodyHash(tampered);
      // the signature made over the original hash does not fit the tampered body's hash
      return (
        hash !== originalHash &&
        !nodeVerify(parseSignature(entry.sig), hexToBytes(hash), parsePublicKey(entry.signer))
      );
    };

    const leafPaths = leaves(original);
    expect(leafPaths.length).toBeGreaterThan(50);
    for (const path of leafPaths) {
      const parent = path.slice(0, -1);
      const key = path[path.length - 1] as string | number;
      const tampered = edit((root) => {
        const node = at(root, parent);
        const old = node[key];
        node[key] =
          typeof old === "string"
            ? `${old}x`
            : typeof old === "number"
              ? old + 1
              : typeof old === "boolean"
                ? !old
                : "x";
      });
      expect(forgedHashIsRejected(tampered), `leaf ${path.join(".")}`).toBe(true);
    }

    // removing a key, adding a key, and truncating or extending an array all change the hash too
    for (const [path, node] of containers(original)) {
      if (Array.isArray(node)) {
        expect(
          forgedHashIsRejected(
            edit((root) => {
              (at(root, path) as unknown as unknown[]).pop();
            }),
          ),
          `pop ${path.join(".")}`,
        ).toBe(true);
        expect(
          forgedHashIsRejected(
            edit((root) => {
              (at(root, path) as unknown as unknown[]).push("extra");
            }),
          ),
          `push ${path.join(".")}`,
        ).toBe(true);
      } else {
        for (const key of Object.keys(node)) {
          expect(
            forgedHashIsRejected(
              edit((root) => {
                delete at(root, path)[key];
              }),
            ),
            `delete ${[...path, key].join(".")}`,
          ).toBe(true);
        }
        expect(
          forgedHashIsRejected(
            edit((root) => {
              at(root, path).extra = 1;
            }),
          ),
          `add under ${path.join(".")}`,
        ).toBe(true);
      }
    }
    expect(nodeVerify(parseSignature(entry.sig), signedBytes, parsePublicKey(entry.signer))).toBe(
      true,
    );
  });

  it("covers prev_link, body_hash and the signature through link, which feeds the next entry", async () => {
    const [first, second] = await chain(2);
    if (first === undefined || second === undefined) throw new Error("chain too short");
    // flipping any bit of the first entry's sig, hash or prev_link yields a different link
    const flippedSig = parseSignature(first.sig).slice();
    flippedSig[0] = (flippedSig[0] ?? 0) ^ 1;
    expect(
      computeLink(first.body.prev_link, first.body_hash, formatSignature(flippedSig)),
    ).not.toBe(first.link);
    expect(computeLink(first.body.prev_link, sha256Hex("x"), first.sig)).not.toBe(first.link);
    expect(computeLink(sha256Hex("x"), first.body_hash, first.sig)).not.toBe(first.link);
    expect(second.body.prev_link).toBe(first.link);
  });
});

describe("tampering is caught by the checks the verifier composes", () => {
  it("accepts an honest chain", async () => {
    const entries = await chain(4);
    for (const [i, entry] of entries.entries()) {
      const prev = entries[i - 1];
      expect(
        reverify(entry, { seq: i, prev_link: prev?.link ?? ZERO_LINK, signer: KEY.publicKey }),
      ).toBeNull();
    }
  });

  it("rejects a tampered body (body_hash no longer recomputes)", async () => {
    const [entry] = await chain(1);
    if (entry === undefined) throw new Error("no entry");
    const tampered: LedgerEntry = { ...entry, body: { ...entry.body, amount: "99000000" } };
    // The signature is over body_hash alone and still verifies: the body must be re-hashed.
    expect(verifyEntrySignature(tampered)).toBe(true);
    expect(computeBodyHash(tampered.body)).not.toBe(tampered.body_hash);
    expect(reverify(tampered, { seq: 0, prev_link: ZERO_LINK, signer: KEY.publicKey })).toBe(
      "body_hash",
    );
  });

  it("rejects a tampered body whose hash was recomputed but not re-signed", async () => {
    const [entry] = await chain(1);
    if (entry === undefined) throw new Error("no entry");
    const tamperedBody = { ...entry.body, verdict: "refuse" as const };
    const tampered: LedgerEntry = {
      ...entry,
      body: tamperedBody,
      body_hash: computeBodyHash(tamperedBody),
    };
    expect(reverify(tampered, { seq: 0, prev_link: ZERO_LINK, signer: KEY.publicKey })).toBe(
      "signature",
    );
  });

  it("rejects a wrong signer key, even when the forged entry is internally consistent", async () => {
    const forged = (await chain(1, OTHER))[0];
    if (forged === undefined) throw new Error("no entry");
    // A forger's own key makes hash, signature and link all agree...
    expect(verifyEntrySignature(forged)).toBe(true);
    expect(computeLink(forged.body.prev_link, forged.body_hash, forged.sig)).toBe(forged.link);
    // ...so only comparing the signer with the vault's ledger key exposes it.
    expect(reverify(forged, { seq: 0, prev_link: ZERO_LINK, signer: KEY.publicKey })).toBe(
      "signer",
    );
    expect(reverify(forged, { seq: 0, prev_link: ZERO_LINK, signer: OTHER.publicKey })).toBeNull();
    // Claiming the right signer on a signature made by the wrong key fails the signature check.
    expect(
      reverify(
        { ...forged, signer: KEY.publicKey },
        { seq: 0, prev_link: ZERO_LINK, signer: KEY.publicKey },
      ),
    ).toBe("signature");
  });

  it("rejects a wrong previous link", async () => {
    const entries = await chain(2);
    const first = entries[0];
    const second = entries[1];
    if (first === undefined || second === undefined) throw new Error("chain too short");
    const sign = createEd25519Signer(KEY.secretKey);
    const detached = await buildEntry(body(1, sha256Hex("not the previous link")), sign);
    expect(reverify(detached, { seq: 1, prev_link: first.link, signer: KEY.publicKey })).toBe(
      "prev_link",
    );
    // Splicing an entry out leaves the next one pointing at a link that is no longer there.
    const [, , third] = await chain(3);
    if (third === undefined) throw new Error("chain too short");
    expect(reverify(third, { seq: 2, prev_link: second.link, signer: KEY.publicKey })).toBeNull();
    expect(reverify(third, { seq: 1, prev_link: first.link, signer: KEY.publicKey })).toBe("seq");
  });

  it("rejects a wrong seq and a replayed entry", async () => {
    const entries = await chain(3);
    const [, second, third] = entries;
    if (second === undefined || third === undefined) throw new Error("chain too short");
    const sign = createEd25519Signer(KEY.secretKey);
    const skipped = await buildEntry(body(5, second.link), sign);
    expect(reverify(skipped, { seq: 2, prev_link: second.link, signer: KEY.publicKey })).toBe(
      "seq",
    );
    // Replaying entry 1 where entry 2 belongs.
    expect(reverify(second, { seq: 2, prev_link: second.link, signer: KEY.publicKey })).toBe("seq");
    expect(
      reverify(third, { seq: 1, prev_link: entries[0]?.link ?? ZERO_LINK, signer: KEY.publicKey }),
    ).toBe("seq");
  });

  it("rejects a forged link, a swapped signature and a swapped body_hash", async () => {
    const entries = await chain(2);
    const [first, second] = entries;
    if (first === undefined || second === undefined) throw new Error("chain too short");
    const expected = { seq: 1, prev_link: first.link, signer: KEY.publicKey };
    expect(reverify({ ...second, link: sha256Hex("forged") }, expected)).toBe("link");
    expect(reverify({ ...second, sig: first.sig }, expected)).toBe("signature");
    expect(reverify({ ...second, body_hash: first.body_hash }, expected)).toBe("signature");
    expect(reverify({ ...second, sig: formatSignature(new Uint8Array(64)) }, expected)).toBe(
      "signature",
    );
    expect(reverify(second, expected)).toBeNull();
  });

  it("rejects an entry 'signed' by the identity key, which non-strict verification accepts for any hash", async () => {
    const [entry] = await chain(1);
    if (entry === undefined) throw new Error("no entry");
    const identityKey = new Uint8Array(32);
    identityKey[0] = 1;
    const identitySig = new Uint8Array(64);
    identitySig[0] = 1;
    const forged: LedgerEntry = {
      ...entry,
      signer: formatPublicKey(identityKey),
      sig: formatSignature(identitySig),
    };
    expect(verifyEntrySignature(forged)).toBe(false);
  });

  it("treats a hash or signature that is not well formed as a failed signature", async () => {
    const [entry] = await chain(1);
    if (entry === undefined) throw new Error("no entry");
    expect(verifyEntrySignature({ ...entry, body_hash: entry.body_hash.toUpperCase() })).toBe(
      false,
    );
    expect(verifyEntrySignature({ ...entry, body_hash: "abc" })).toBe(false);
    expect(verifyEntrySignature({ ...entry, sig: "ed25519:xyz" })).toBe(false);
    expect(verifyEntrySignature({ ...entry, signer: "nonsense" })).toBe(false);
    expect(verifyEntrySignature({} as unknown as LedgerEntry)).toBe(false);
  });
});

describe("buildEntry does not trust the signer", () => {
  const body0 = body(0, ZERO_LINK);

  it("refuses a signature made by a different key than the one claimed", async () => {
    const liar: LedgerSigner = async (hash) => {
      const real = await createEd25519Signer(OTHER.secretKey)(hash);
      return { sig: real.sig, signer: KEY.publicKey };
    };
    await expect(buildEntry(body0, liar)).rejects.toThrow(LedgerFormatError);
  });

  it("refuses a signature over some other message", async () => {
    const wrongMessage: LedgerSigner = async () =>
      createEd25519Signer(KEY.secretKey)(sha256Bytes(utf8("something else")));
    await expect(buildEntry(body0, wrongMessage)).rejects.toThrow(LedgerFormatError);
  });

  it("refuses garbage from the signer", async () => {
    const garbage: LedgerSigner = async () => ({ sig: "ed25519:nope", signer: KEY.publicKey });
    await expect(buildEntry(body0, garbage)).rejects.toThrow(LedgerFormatError);
    const noSigner: LedgerSigner = async () => ({
      sig: formatSignature(new Uint8Array(64)),
      signer: "",
    });
    await expect(buildEntry(body0, noSigner)).rejects.toThrow(LedgerFormatError);
  });

  it("passes the signer exactly the 32 raw bytes of the body hash", async () => {
    let seen: Uint8Array | null = null;
    const real = createEd25519Signer(KEY.secretKey);
    const entry = await buildEntry(body0, async (hash) => {
      seen = hash;
      return real(hash);
    });
    expect(seen).not.toBeNull();
    expect(bytesToHex(seen ?? new Uint8Array(0))).toBe(entry.body_hash);
  });
});

describe("nothing secret ends up in an entry", () => {
  it("has exactly the five public fields and no key material", async () => {
    const [entry] = await chain(1);
    if (entry === undefined) throw new Error("no entry");
    expect(Object.keys(entry).sort()).toEqual(["body", "body_hash", "link", "sig", "signer"]);
    const seed = sha256Bytes(utf8("probarion/test-fixture/ledger-test-key"));
    const dump = `${JSON.stringify(entry)} ${inspect(entry, { depth: 10 })}`;
    expect(dump).not.toContain(KEY.secretKey);
    expect(dump).not.toContain(bytesToHex(seed));
    expect(JSON.stringify(KEY)).not.toContain(KEY.secretKey);
  });

  it("does not echo a secret key when building an entry with a bad one", () => {
    const bad = `${KEY.secretKey.slice(0, -3)}111`;
    let report = "";
    try {
      createEd25519Signer(bad);
    } catch (error) {
      report = `${(error as Error).message}${(error as Error).stack}`;
    }
    expect(report).not.toBe("");
    expect(report).not.toContain(bad);
  });
});

describe("computeNonce (interfaces §6, ICR-1: bound to the vault)", () => {
  const prev = sha256Hex("prev");
  const invoice = sha256Hex("invoice");
  const OTHER_VAULT = "other.vaults.probarion.testnet";
  // 29 characters but 30 UTF-8 bytes, so a character count and a byte count give different prefixes.
  const MULTIBYTE_VAULT = "café.vaults.probarion.testnet";
  const base: NonceContext = {
    vault: VAULT,
    prev_link: prev,
    invoice_hash: invoice,
    mandate_id: 3,
    seq: 7,
  };

  const u32 = (value: number): Uint8Array => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, false);
    return out;
  };
  /** The preimage spelled out: the vault is a 4-byte big-endian byte length, then its UTF-8 bytes. */
  const preimage = (c: NonceContext, lengthPrefix: number | "none" = utf8(c.vault).length) =>
    concatBytes(
      utf8(NONCE_DOMAIN),
      hexToBytes(c.prev_link),
      c.invoice_hash === null ? new Uint8Array(32) : hexToBytes(c.invoice_hash),
      u64be(c.mandate_id ?? 0),
      u64be(c.seq),
      ...(lengthPrefix === "none" ? [] : [u32(lengthPrefix)]),
      utf8(c.vault),
    );

  it("hashes domain || prev_link || invoice_hash || u64be(mandate_id) || u64be(seq) || u32be(len) || utf8(vault)", () => {
    expect(computeNonce(base)).toBe(sha256Hex(preimage(base)));
    expect(NONCE_DOMAIN).toBe("probarion/v1");
  });

  it("matches known answers computed with node:crypto", () => {
    expect(computeNonce(base)).toBe(
      "b64c84fa7a4bee55329de1a57b261233b37d9babe53e623f0ba6f038e44866cf",
    );
    expect(computeNonce({ ...base, invoice_hash: null, mandate_id: null, seq: 0 })).toBe(
      "8fa624943f4d61be5152b82050f53108f32c662adfe89074b78750da91dd74bb",
    );
  });

  it("uses 32 zero bytes and mandate 0 for nulls", () => {
    const nulls: NonceContext = { ...base, invoice_hash: null, mandate_id: null, seq: 0 };
    expect(bytesToHex(preimage(nulls).slice(12 + 32, 12 + 32 + 32))).toBe("00".repeat(32));
    expect(computeNonce(nulls)).toBe(sha256Hex(preimage(nulls)));
  });

  it("changes with every input, the vault included, and is 64 lowercase hex", () => {
    const nonce = computeNonce(base);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(computeNonce({ ...base, seq: 8 })).not.toBe(nonce);
    expect(computeNonce({ ...base, mandate_id: 4 })).not.toBe(nonce);
    expect(computeNonce({ ...base, invoice_hash: sha256Hex("other") })).not.toBe(nonce);
    expect(computeNonce({ ...base, prev_link: ZERO_LINK })).not.toBe(nonce);
    expect(computeNonce({ ...base, vault: OTHER_VAULT })).not.toBe(nonce);
  });

  it("gives two vaults different nonces for an identical first decision", () => {
    // Every vault starts at prev_link = ZERO_LINK, seq = 0, and mandate ids restart at 1, so only the
    // vault tells two first decisions of the same invoice apart. Without it, NEAR AI evidence from
    // one vault's public seq-0 decision would pass A5 and A6 in another vault.
    const first = nextBodyFields(null);
    expect(first).toEqual({ seq: 0, prev_link: ZERO_LINK });
    const inA = computeNonce({ ...first, vault: VAULT, invoice_hash: invoice, mandate_id: 1 });
    const inB = computeNonce({
      ...first,
      vault: OTHER_VAULT,
      invoice_hash: invoice,
      mandate_id: 1,
    });
    expect(inA).not.toBe(inB);
    expect(inA).toBe("83db481ed36a1b10c6f83b4332f7b25ae1e576f021883c1a2a6e81817635cc57");
    expect(inB).toBe("5ab46f598b5e9c78621534ec97c0230dc88c4014a20355182d51108f8bc7e832");
  });

  it("binds the vault at every seq, not only at seq 0", () => {
    for (const seq of [0, 1, 2, 50]) {
      const withSeq = { ...base, seq };
      expect(computeNonce({ ...withSeq, vault: VAULT })).not.toBe(
        computeNonce({ ...withSeq, vault: OTHER_VAULT }),
      );
    }
  });

  it("length-prefixes the vault with its UTF-8 byte length", () => {
    const ctx: NonceContext = {
      ...base,
      prev_link: ZERO_LINK,
      mandate_id: 1,
      seq: 0,
      vault: MULTIBYTE_VAULT,
    };
    expect(MULTIBYTE_VAULT).toHaveLength(29);
    expect(utf8(MULTIBYTE_VAULT)).toHaveLength(30);
    const nonce = computeNonce(ctx);
    expect(nonce).toBe("0ca58c92f977093d08f0b03d8acd42a4e618b79ca2deb8ac36c31afa1aa1e9bb");
    expect(nonce).toBe(sha256Hex(preimage(ctx, 30)));
    // a character count (29) in the prefix, or no prefix at all, is a different nonce
    expect(nonce).not.toBe(sha256Hex(preimage(ctx, 29)));
    expect(sha256Hex(preimage(ctx, 29))).toBe(
      "843e37bc25391a2026ff2e62de6e2f9ee8757a1a4effeaa909416ca1a27fea46",
    );
    expect(nonce).not.toBe(sha256Hex(preimage(ctx, "none")));
  });

  it("changes with the length of the vault id", () => {
    const zero: NonceContext = { ...base, prev_link: ZERO_LINK, mandate_id: 1, seq: 0 };
    const short = computeNonce({ ...zero, vault: "a" });
    const long = computeNonce({ ...zero, vault: "aa" });
    expect(short).not.toBe(long);
    expect(short).toBe("6fae0c8f1c0d92a592d3e6ade912b25242ebe9c8f7c0b8b69d2b9d82ab01b712");
    expect(long).toBe("09c5f4ad8cb2ae88bca5065c71f0a4979f7499602e2daf08f3b13b1e3077da20");
  });

  it("never repeats along a chain, even for the same invoice and mandate", async () => {
    // The brief defines no nonce registry: uniqueness comes from the position, because prev_link and
    // seq are part of the preimage and every entry's link is new.
    const entries = await chain(8);
    const nonces = new Set<string>();
    let head: LedgerEntry | null = null;
    for (let i = 0; i < 8; i++) {
      const next = nextBodyFields(head);
      nonces.add(computeNonce({ ...next, vault: VAULT, invoice_hash: invoice, mandate_id: 1 }));
      head = entries[i] ?? null;
    }
    expect(nonces.size).toBe(8);
  });

  it("accepts astral characters in the vault id", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const ctx = { ...base, vault: `${emoji}.near` };
    expect(computeNonce(ctx)).toBe(sha256Hex(preimage(ctx)));
  });

  it("rejects malformed inputs with a LedgerFormatError", () => {
    const ok = { ...base, mandate_id: 1, seq: 1 };
    expect(() => computeNonce({ ...ok, prev_link: "abc" })).toThrow(LedgerFormatError);
    expect(() => computeNonce({ ...ok, prev_link: prev.toUpperCase() })).toThrow(LedgerFormatError);
    expect(() => computeNonce({ ...ok, invoice_hash: "abc" })).toThrow(LedgerFormatError);
    expect(() => computeNonce({ ...ok, seq: -1 })).toThrow(LedgerFormatError);
    expect(() => computeNonce({ ...ok, seq: 1.5 })).toThrow(LedgerFormatError);
    expect(() => computeNonce({ ...ok, seq: Number.NaN })).toThrow(LedgerFormatError);
    expect(() => computeNonce({ ...ok, mandate_id: -1 })).toThrow(LedgerFormatError);
    expect(() => computeNonce({ ...ok, mandate_id: 2 ** 53 })).toThrow(LedgerFormatError);
    expect(() => computeNonce({ ...ok, vault: "" })).toThrow(LedgerFormatError);
    expect(() => computeNonce({ ...ok, vault: undefined as unknown as string })).toThrow(
      LedgerFormatError,
    );
    // a lone surrogate would encode as U+FFFD, the same bytes as a real replacement character
    const lone = String.fromCharCode(0xd800);
    expect(() => computeNonce({ ...ok, vault: `a${lone}b` })).toThrow(LedgerFormatError);
  });
});

describe("what the ledger hands to the vault's anchor method (contracts/vault/src/anchors.rs)", () => {
  it("makes every entry link a valid anchor root: 64 lowercase hex", async () => {
    const entries = await chain(5);
    for (const entry of entries) expect(entry.link).toMatch(/^[0-9a-f]{64}$/);
    // root = link of entry[count - 1], so anchoring entry n covers count n + 1 and the links differ
    expect(new Set(entries.map((e) => e.link)).size).toBe(entries.length);
    expect(entries.every((e) => e.link !== ZERO_LINK)).toBe(true);
  });
});
