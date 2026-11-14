// N1 tamper tests on recorded mainnet proofs: changing any field the proof commits (keeping it well formed, so the
// change reaches the cryptography) is refused with the code of the check it breaks, and changing a field the proof
// does not commit (outcome.metadata, the JSON timestamp number, the Failure reason) passes and leaves the result
// exactly as it was, so nothing unproven reaches a ProvenOutcome.
import { describe, expect, it } from "vitest";
import { decodeBase58Hash, decodeBase64, encodeBase58, encodeBase64 } from "../src/encoding.js";
import { type OutcomeProofCode, verifyOutcomeProof } from "../src/outcome-proof.js";
import type { TrustedHead } from "../src/types.js";
import { readFixture } from "./helpers/fixtures.js";
import { mulberry32 } from "./helpers/prng.js";

// biome-ignore lint/suspicious/noExplicitAny: raw RPC JSON, taken apart and broken on purpose
type Json = Record<string, any>;

interface ProofFixture {
  head: Required<TrustedHead>;
  proofs: Json[];
}

const spend = readFixture<ProofFixture>("proofs/mainnet-spend-2.json");
const drill = readFixture<ProofFixture>("proofs/mainnet-drill-over-cap.json");
const head = spend.head;
const clone = <T>(value: T): T => structuredClone(value);

/** The same hash with one bit flipped: still 32 canonical base58 bytes, so only the cryptography can refuse it. */
function otherHash(hash: string, bit = 0): string {
  const bytes = decodeBase58Hash(hash) as Uint8Array;
  const copy = bytes.slice();
  copy[(bit >> 3) % 32] = (copy[(bit >> 3) % 32] as number) ^ (1 << (bit & 7));
  return encodeBase58(copy);
}

const flip = (direction: string): string => (direction === "Left" ? "Right" : "Left");

function codeOf(proof: unknown, trusted: TrustedHead = head): OutcomeProofCode | "ok" {
  const result = verifyOutcomeProof(proof, trusted, { status: "any" });
  return result.ok ? "ok" : result.code;
}

const byId = (id: string): Json =>
  spend.proofs.find((proof) => proof.outcome_proof.id === id) as Json;
/** intents.near's receipt: a log, two receipt ids, SuccessReceiptId, paths of 2, 4 and 23 items. */
const INTENTS = byId("F2BErA5fo6HBPhgwjyER9iiCrs9XHmDHX6dsey1dZmVi");
/** The vault's callback receipt: SuccessValue with a JSON body and a log. */
const CALLBACK = spend.proofs.find(
  (proof) =>
    typeof proof.outcome_proof.outcome.status.SuccessValue === "string" &&
    proof.outcome_proof.outcome.status.SuccessValue.length > 8,
) as Json;

interface Case {
  name: string;
  base: Json;
  edit: (proof: Json) => void;
  code: OutcomeProofCode;
  trusted?: TrustedHead;
}

function tamperCases(): Case[] {
  const cases: Case[] = [];
  const outcome = (proof: Json): Json => proof.outcome_proof.outcome;
  const inner = (proof: Json): Json => proof.block_header_lite.inner_lite;
  const add = (name: string, edit: (proof: Json) => void, code: OutcomeProofCode, base = INTENTS) =>
    cases.push({ name, base, edit, code });

  add(
    "outcome_proof.id",
    (p) => {
      p.outcome_proof.id = otherHash(p.outcome_proof.id);
    },
    "outcome_root_mismatch",
  );
  INTENTS.outcome_proof.outcome.logs.forEach((log: string, i: number) => {
    add(
      `one byte of logs[${i}]`,
      (p) => {
        const at = Math.max(log.indexOf("1"), 0);
        outcome(p).logs[i] =
          `${log.slice(0, at)}${log[at] === "2" ? "3" : "2"}${log.slice(at + 1)}`;
      },
      "outcome_root_mismatch",
    );
  });
  add("a log added", (p) => void outcome(p).logs.push("x"), "outcome_root_mismatch");
  add("a log removed", (p) => void outcome(p).logs.pop(), "outcome_root_mismatch");
  add(
    "executor_id",
    (p) => {
      outcome(p).executor_id = "intents2.near";
    },
    "outcome_root_mismatch",
  );
  add(
    "gas_burnt",
    (p) => {
      outcome(p).gas_burnt += 1;
    },
    "outcome_root_mismatch",
  );
  add(
    "tokens_burnt",
    (p) => {
      outcome(p).tokens_burnt = String(BigInt(outcome(p).tokens_burnt) + 1n);
    },
    "outcome_root_mismatch",
  );
  add(
    "status kind SuccessReceiptId to SuccessValue",
    (p) => {
      outcome(p).status = { SuccessValue: "" };
    },
    "outcome_root_mismatch",
  );
  add(
    "status kind to Failure",
    (p) => {
      outcome(p).status = { Failure: {} };
    },
    "outcome_root_mismatch",
  );
  add(
    "status kind to Unknown",
    (p) => {
      outcome(p).status = "Unknown";
    },
    "outcome_root_mismatch",
  );
  add(
    "status value SuccessReceiptId",
    (p) => {
      outcome(p).status = { SuccessReceiptId: otherHash(outcome(p).status.SuccessReceiptId) };
    },
    "outcome_root_mismatch",
  );
  add(
    "status value SuccessValue",
    (p) => {
      const value = decodeBase64(outcome(p).status.SuccessValue) as Uint8Array;
      value[0] = (value[0] as number) ^ 1;
      outcome(p).status = { SuccessValue: encodeBase64(value) };
    },
    "outcome_root_mismatch",
    CALLBACK,
  );
  add(
    "status SuccessValue to SuccessReceiptId",
    (p) => {
      outcome(p).status = { SuccessReceiptId: p.outcome_proof.id };
    },
    "outcome_root_mismatch",
    CALLBACK,
  );
  INTENTS.outcome_proof.outcome.receipt_ids.forEach((_: string, i: number) => {
    add(
      `receipt_ids[${i}]`,
      (p) => {
        outcome(p).receipt_ids[i] = otherHash(outcome(p).receipt_ids[i]);
      },
      "outcome_root_mismatch",
    );
  });
  add(
    "receipt_ids reordered",
    (p) => void outcome(p).receipt_ids.reverse(),
    "outcome_root_mismatch",
  );
  add("a receipt id removed", (p) => void outcome(p).receipt_ids.pop(), "outcome_root_mismatch");

  const paths: [string, (p: Json) => Json[], OutcomeProofCode][] = [
    ["outcome_proof.proof", (p) => p.outcome_proof.proof, "outcome_root_mismatch"],
    ["outcome_root_proof", (p) => p.outcome_root_proof, "outcome_root_mismatch"],
    ["block_proof", (p) => p.block_proof, "head_mismatch"],
  ];
  for (const [name, at, code] of paths) {
    at(INTENTS).forEach((_, i) => {
      add(
        `${name}[${i}].hash`,
        (p) => {
          const item = at(p)[i] as Json;
          item.hash = otherHash(item.hash);
        },
        code,
      );
      add(
        `${name}[${i}].direction`,
        (p) => {
          const item = at(p)[i] as Json;
          item.direction = flip(item.direction);
        },
        code,
      );
    });
    add(`${name} with its last item dropped`, (p) => void at(p).pop(), code);
  }

  for (const field of [
    "epoch_id",
    "next_epoch_id",
    "prev_state_root",
    "next_bp_hash",
    "block_merkle_root",
  ]) {
    add(
      `inner_lite.${field}`,
      (p) => {
        inner(p)[field] = otherHash(inner(p)[field]);
      },
      "block_hash_mismatch",
    );
  }
  add(
    "inner_lite.outcome_root",
    (p) => {
      inner(p).outcome_root = otherHash(inner(p).outcome_root);
    },
    "outcome_root_mismatch",
  );
  add(
    "inner_lite.height",
    (p) => {
      inner(p).height += 1;
    },
    "block_hash_mismatch",
  );
  add(
    "inner_lite.timestamp_nanosec",
    (p) => {
      inner(p).timestamp_nanosec = String(BigInt(inner(p).timestamp_nanosec) + 1n);
    },
    "block_hash_mismatch",
  );
  add(
    "inner_lite.timestamp_nanosec set to the JSON timestamp",
    (p) => {
      inner(p).timestamp_nanosec = String(BigInt(inner(p).timestamp));
    },
    "block_hash_mismatch",
  );
  add(
    "inner_rest_hash",
    (p) => {
      p.block_header_lite.inner_rest_hash = otherHash(p.block_header_lite.inner_rest_hash);
    },
    "block_hash_mismatch",
  );
  add(
    "prev_block_hash",
    (p) => {
      p.block_header_lite.prev_block_hash = otherHash(p.block_header_lite.prev_block_hash);
    },
    "block_hash_mismatch",
  );
  add(
    "outcome_proof.block_hash",
    (p) => {
      p.outcome_proof.block_hash = otherHash(p.outcome_proof.block_hash);
    },
    "block_hash_mismatch",
  );
  cases.push({
    name: "the head's block_merkle_root",
    base: INTENTS,
    edit: () => {},
    code: "head_mismatch",
    trusted: { ...head, blockMerkleRoot: otherHash(head.blockMerkleRoot) },
  });
  return cases;
}

describe("tamper table: each committed field", () => {
  it("starts from proofs that verify, and a timestamp the JSON number does not match", () => {
    expect(codeOf(INTENTS)).toBe("ok");
    expect(codeOf(CALLBACK)).toBe("ok");
    const lite = INTENTS.block_header_lite.inner_lite;
    expect(String(BigInt(lite.timestamp))).not.toBe(lite.timestamp_nanosec);
  });

  for (const c of tamperCases()) {
    it(`${c.name}: ${c.code}`, () => {
      const proof = clone(c.base);
      c.edit(proof);
      expect(codeOf(proof, c.trusted)).toBe(c.code);
    });
  }
});

// ---------- seeded mutation loop ----------

type Leaf = {
  path: (string | number)[];
  kind: "hash" | "log" | "direction" | "count" | "u64" | "u128" | "base64" | "account";
};

/** Every value of a proof that its hashes commit, with how to change it and keep it well formed. */
function coveredLeaves(proof: Json): Leaf[] {
  const leaves: Leaf[] = [];
  const op = proof.outcome_proof;
  leaves.push({ path: ["outcome_proof", "id"], kind: "hash" });
  leaves.push({ path: ["outcome_proof", "block_hash"], kind: "hash" });
  op.outcome.logs.forEach((_: string, i: number) => {
    leaves.push({ path: ["outcome_proof", "outcome", "logs", i], kind: "log" });
  });
  op.outcome.receipt_ids.forEach((_: string, i: number) => {
    leaves.push({ path: ["outcome_proof", "outcome", "receipt_ids", i], kind: "hash" });
  });
  leaves.push({ path: ["outcome_proof", "outcome", "gas_burnt"], kind: "count" });
  leaves.push({ path: ["outcome_proof", "outcome", "tokens_burnt"], kind: "u128" });
  leaves.push({ path: ["outcome_proof", "outcome", "executor_id"], kind: "account" });
  const status = op.outcome.status;
  if (typeof status === "object" && "SuccessValue" in status) {
    leaves.push({ path: ["outcome_proof", "outcome", "status", "SuccessValue"], kind: "base64" });
  }
  if (typeof status === "object" && "SuccessReceiptId" in status) {
    leaves.push({ path: ["outcome_proof", "outcome", "status", "SuccessReceiptId"], kind: "hash" });
  }
  const pathLeaves = (prefix: (string | number)[], items: Json[]) => {
    items.forEach((_, i) => {
      leaves.push({ path: [...prefix, i, "hash"], kind: "hash" });
      leaves.push({ path: [...prefix, i, "direction"], kind: "direction" });
    });
  };
  pathLeaves(["outcome_proof", "proof"], op.proof);
  pathLeaves(["outcome_root_proof"], proof.outcome_root_proof);
  pathLeaves(["block_proof"], proof.block_proof);
  for (const field of [
    "epoch_id",
    "next_epoch_id",
    "prev_state_root",
    "outcome_root",
    "next_bp_hash",
    "block_merkle_root",
  ]) {
    leaves.push({ path: ["block_header_lite", "inner_lite", field], kind: "hash" });
  }
  leaves.push({ path: ["block_header_lite", "inner_lite", "height"], kind: "count" });
  leaves.push({ path: ["block_header_lite", "inner_lite", "timestamp_nanosec"], kind: "u64" });
  leaves.push({ path: ["block_header_lite", "inner_rest_hash"], kind: "hash" });
  leaves.push({ path: ["block_header_lite", "prev_block_hash"], kind: "hash" });
  return leaves;
}

function parentOf(root: Json, path: (string | number)[]): [Json, string | number] {
  let node: Json = root;
  for (const step of path.slice(0, -1)) node = node[step];
  return [node, path[path.length - 1] as string | number];
}

/** A different value of the same kind, so the proof stays well formed and only the hashes can catch it. */
function mutate(value: unknown, kind: Leaf["kind"], next: () => number): unknown {
  const pick = (n: number) => Math.floor(next() * n);
  switch (kind) {
    case "hash":
      return otherHash(value as string, pick(256));
    case "direction":
      return flip(value as string);
    case "count":
      return (value as number) + 1 + pick(1000);
    case "u64":
    case "u128":
      return String(BigInt(value as string) + 1n + BigInt(pick(1000)));
    case "account":
      return `${value as string}`.replace(/^[a-z0-9]/, (c) => (c === "z" ? "y" : "z"));
    case "base64": {
      const bytes = decodeBase64(value) as Uint8Array;
      if (bytes.length === 0) return encodeBase64(Uint8Array.of(pick(256)));
      const copy = bytes.slice();
      const at = pick(copy.length);
      copy[at] = (copy[at] as number) ^ (1 << pick(8));
      return encodeBase64(copy);
    }
    case "log": {
      const log = value as string;
      const ascii = Array.from({ length: log.length }, (_, i) => i).filter(
        (i) => log.charCodeAt(i) < 0x80,
      );
      if (ascii.length === 0) return `${log}x`;
      const at = ascii[pick(ascii.length)] as number;
      const replacement = log[at] === "a" ? "b" : "a";
      return `${log.slice(0, at)}${replacement}${log.slice(at + 1)}`;
    }
  }
}

const CRYPTO_CODES = ["outcome_root_mismatch", "block_hash_mismatch", "head_mismatch"];
const allProofs = [...spend.proofs, ...drill.proofs];

describe("seeded mutation loop (mulberry32)", () => {
  it("refuses 500 random changes to committed fields, each by a hash check", () => {
    const next = mulberry32(0x5eed);
    for (let run = 0; run < 500; run++) {
      const base = allProofs[Math.floor(next() * allProofs.length)] as Json;
      const leaves = coveredLeaves(base);
      const proof = clone(base);
      let trusted: TrustedHead = head;
      let label: string;
      // About one run in twenty changes the trusted head instead of the proof.
      if (next() < 0.05) {
        trusted = {
          ...head,
          blockMerkleRoot: otherHash(head.blockMerkleRoot, Math.floor(next() * 256)),
        };
        label = "head.blockMerkleRoot";
      } else {
        const leaf = leaves[Math.floor(next() * leaves.length)] as Leaf;
        const [parent, key] = parentOf(proof, leaf.path);
        const before = parent[key];
        parent[key] = mutate(before, leaf.kind, next);
        expect(parent[key], `run ${run}: ${leaf.path.join(".")} unchanged`).not.toEqual(before);
        label = leaf.path.join(".");
      }
      const result = verifyOutcomeProof(proof, trusted, { status: "any" });
      expect(result.ok, `run ${run}: ${label} was accepted`).toBe(false);
      if (!result.ok) expect(CRYPTO_CODES, `run ${run}: ${label}`).toContain(result.code);
    }
  });

  it("accepts changes to fields the proof does not commit, and none of them reaches the result", () => {
    const next = mulberry32(0xfee1);
    const failed = drill.proofs[1] as Json;
    for (let run = 0; run < 150; run++) {
      const base = allProofs[Math.floor(next() * allProofs.length)] as Json;
      const before = verifyOutcomeProof(base, head, { status: "any" });
      const proof = clone(base);
      const choice = Math.floor(next() * 4);
      if (choice === 0) {
        proof.outcome_proof.outcome.metadata = { version: 99, gas_profile: [{ cost: "X", run }] };
      } else if (choice === 1) {
        proof.block_header_lite.inner_lite.timestamp += 1 + Math.floor(next() * 1e6);
      } else if (choice === 2) {
        proof.outcome_proof.extra = `run ${run}`;
        proof.block_header_lite.inner_lite.extra = run;
      } else {
        const failure = clone(failed);
        failure.outcome_proof.outcome.status = {
          Failure: {
            ActionError: {
              index: run,
              kind: { FunctionCallError: { ExecutionError: `edited ${run}` } },
            },
          },
        };
        const result = verifyOutcomeProof(failure, head, { status: "failure" });
        expect(result).toEqual(verifyOutcomeProof(failed, head, { status: "failure" }));
        expect(
          JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? `${v}` : v)),
        ).not.toContain(`edited ${run}`);
        continue;
      }
      const after = verifyOutcomeProof(proof, head, { status: "any" });
      expect(before.ok).toBe(true);
      expect(after, `run ${run}, change ${choice}`).toEqual(before);
    }
  });
});
