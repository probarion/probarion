// merkleRootFromPath against a test-only port of nearcore's merklize (core/primitives/src/merkle.rs): trees of 1 to
// 33 leaves, odd counts included (nearcore promotes the last node of an odd level without hashing it), every path
// rebuilds the root, and any one flipped direction or changed hash does not.
import { describe, expect, it } from "vitest";
import { decodeBase58Hash, encodeBase58, sha256 } from "../src/encoding.js";
import { NearFormatError } from "../src/errors.js";
import { MAX_PROOF_PATH, merkleRootFromPath } from "../src/outcome-proof.js";
import type { MerklePathItem, TrustedHead } from "../src/types.js";
import { readFixture } from "./helpers/fixtures.js";
import { mulberry32 } from "./helpers/prng.js";

/**
 * nearcore `merklize`, over item hashes (merklize hashes each item with hash_borsh first; these leaves are those
 * hashes). Kept line for line with the Rust so a reader can compare the two.
 */
function merklize(leaves: readonly Uint8Array[]): { root: Uint8Array; paths: MerklePathItem[][] } {
  if (leaves.length === 0) return { root: new Uint8Array(32), paths: [] };
  let len = 1;
  while (len < leaves.length) len *= 2;
  const hashes = leaves.slice();
  if (len === 1) return { root: hashes[0] as Uint8Array, paths: [[]] };
  let arrLen = leaves.length;
  const paths: MerklePathItem[][] = leaves.map((_, i) => {
    if (i % 2 === 0) {
      return i + 1 < arrLen
        ? [{ hash: encodeBase58(hashes[i + 1] as Uint8Array), direction: "Right" }]
        : [];
    }
    return [{ hash: encodeBase58(hashes[i - 1] as Uint8Array), direction: "Left" }];
  });
  let counter = 1;
  while (len > 1) {
    len /= 2;
    counter *= 2;
    for (let i = 0; i < len; i++) {
      let hash: Uint8Array;
      if (2 * i >= arrLen) continue;
      if (2 * i + 1 >= arrLen) hash = hashes[2 * i] as Uint8Array;
      else hash = sha256(hashes[2 * i] as Uint8Array, hashes[2 * i + 1] as Uint8Array);
      hashes[i] = hash;
      if (len > 1) {
        const item: MerklePathItem = {
          hash: encodeBase58(hash),
          direction: i % 2 === 0 ? "Left" : "Right",
        };
        const first = i % 2 === 0 ? (i + 1) * counter : (i - 1) * counter;
        for (let j = 0; j < counter; j++) {
          const index = first + j;
          if (index < leaves.length) (paths[index] as MerklePathItem[]).push(item);
        }
      }
    }
    arrLen = Math.floor((arrLen + 1) / 2);
  }
  return { root: hashes[0] as Uint8Array, paths };
}

function randomLeaves(next: () => number, count: number): Uint8Array[] {
  return Array.from({ length: count }, () => {
    const leaf = new Uint8Array(32);
    for (let i = 0; i < 32; i++) leaf[i] = Math.floor(next() * 256);
    return leaf;
  });
}

const flipped = (path: readonly MerklePathItem[], at: number): MerklePathItem[] =>
  path.map((item, i) =>
    i === at ? { ...item, direction: item.direction === "Left" ? "Right" : "Left" } : item,
  );

describe("merkleRootFromPath against nearcore merklize", () => {
  it("matches hand-built roots, including promoted odd nodes", () => {
    const [a, b, c, d, e] = randomLeaves(mulberry32(1), 5) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    expect(merklize([a]).root).toEqual(a);
    expect(merklize([a, b]).root).toEqual(sha256(a, b));
    expect(merklize([a, b, c]).root).toEqual(sha256(sha256(a, b), c));
    expect(merklize([a, b, c, d]).root).toEqual(sha256(sha256(a, b), sha256(c, d)));
    expect(merklize([a, b, c, d, e]).root).toEqual(sha256(sha256(sha256(a, b), sha256(c, d)), e));
    // The promoted leaf skips a level: its path is shorter than its neighbours'.
    expect(merklize([a, b, c]).paths.map((path) => path.length)).toEqual([2, 2, 1]);
    expect(merklize([a, b, c, d, e]).paths[4]).toHaveLength(1);
  });

  it("rebuilds the root from every path of trees with 1 to 33 leaves", () => {
    const next = mulberry32(33);
    for (let count = 1; count <= 33; count++) {
      const leaves = randomLeaves(next, count);
      const { root, paths } = merklize(leaves);
      const depth = Math.ceil(Math.log2(count));
      leaves.forEach((leaf, i) => {
        const path = paths[i] as MerklePathItem[];
        expect(path.length).toBeLessThanOrEqual(depth);
        expect(merkleRootFromPath(leaf, path), `${count} leaves, leaf ${i}`).toEqual(root);
      });
    }
  });

  it("gives another root when one direction is flipped, one hash changed, or the leaf is another", () => {
    const next = mulberry32(34);
    for (let count = 2; count <= 33; count++) {
      const leaves = randomLeaves(next, count);
      const { root, paths } = merklize(leaves);
      leaves.forEach((leaf, i) => {
        const path = paths[i] as MerklePathItem[];
        for (let at = 0; at < path.length; at++) {
          expect(merkleRootFromPath(leaf, flipped(path, at))).not.toEqual(root);
          const changed = path.map((item, k) =>
            k === at
              ? { ...item, hash: encodeBase58(sha256(decodeBase58Hash(item.hash) as Uint8Array)) }
              : item,
          );
          expect(merkleRootFromPath(leaf, changed)).not.toEqual(root);
        }
        const other = leaves[(i + 1) % count] as Uint8Array;
        expect(merkleRootFromPath(other, path)).not.toEqual(root);
      });
    }
  });

  it("returns the leaf for an empty path (a tree of one)", () => {
    const [leaf] = randomLeaves(mulberry32(2), 1) as [Uint8Array];
    expect(merkleRootFromPath(leaf, [])).toEqual(leaf);
  });
});

describe("merkleRootFromPath input checks", () => {
  const [leaf] = randomLeaves(mulberry32(3), 1) as [Uint8Array];
  const item: MerklePathItem = { hash: encodeBase58(leaf), direction: "Left" };

  it(`takes up to ${MAX_PROOF_PATH} items and refuses more`, () => {
    expect(() => merkleRootFromPath(leaf, Array(MAX_PROOF_PATH).fill(item))).not.toThrow();
    expect(() => merkleRootFromPath(leaf, Array(MAX_PROOF_PATH + 1).fill(item))).toThrow(
      NearFormatError,
    );
  });

  it("refuses a leaf that is not 32 bytes, a bad hash and a bad direction, naming the field", () => {
    expect(() => merkleRootFromPath(new Uint8Array(31), [])).toThrow(NearFormatError);
    expect(() => merkleRootFromPath("x" as never, [])).toThrow(NearFormatError);
    const what = (path: unknown): string | undefined => {
      try {
        merkleRootFromPath(leaf, path as MerklePathItem[]);
      } catch (error) {
        if (error instanceof NearFormatError) return error.what;
      }
      return undefined;
    };
    expect(what([{ ...item, hash: `1${item.hash}` }])).toBe("path[0].hash");
    expect(what([item, { ...item, direction: "left" }])).toBe("path[1].direction");
    expect(what([null])).toBe("path[0]");
    expect(what(new Array(1))).toBe("path[0]");
    expect(what("path")).toBe("path");
  });

  it("folds a recorded mainnet block_proof up to the recorded head", () => {
    const spend = readFixture<{
      head: Required<TrustedHead>;
      // biome-ignore lint/suspicious/noExplicitAny: raw RPC JSON
      proofs: { outcome_proof: { block_hash: string }; block_proof: any }[];
    }>("proofs/mainnet-spend-2.json");
    for (const proof of spend.proofs) {
      const blockHash = decodeBase58Hash(proof.outcome_proof.block_hash) as Uint8Array;
      expect(encodeBase58(merkleRootFromPath(blockHash, proof.block_proof))).toBe(
        spend.head.blockMerkleRoot,
      );
    }
  });
});
