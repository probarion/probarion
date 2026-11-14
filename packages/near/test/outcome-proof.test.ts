// N1 against recorded mainnet data: every proof of spend 2's tree and of the drill's refused spend verifies, the
// proven outcomes equal the RPC's own tx answer, the recomputed block hashes equal the RPC's block hash at each
// height, and the tree check links receipts to their transaction (fixtures: scripts/record-proofs.ts).
import { describe, expect, it } from "vitest";
import { decodeBase58Hash, decodeBase64, encodeBase58 } from "../src/encoding.js";
import { NearFormatError } from "../src/errors.js";
import {
  lightBlockHash,
  MAX_PROOF_PATH,
  outcomeLeafHash,
  verifyOutcomeProof,
  verifyTransactionOutcomes,
} from "../src/outcome-proof.js";
import type { ProvenOutcome, ProvenStatus, TrustedHead } from "../src/types.js";
import { readFixture } from "./helpers/fixtures.js";
import { mulberry32 } from "./helpers/prng.js";

// biome-ignore lint/suspicious/noExplicitAny: raw RPC JSON, taken apart and broken on purpose
type Json = Record<string, any>;

interface ProofFixture {
  _source: string;
  head: Required<TrustedHead>;
  head_secondary: { rpc: string; hash: string; height: number; block_merkle_root: string };
  tx: Json;
  proofs: Json[];
  block_hash_by_height: Record<string, string>;
  failed_receipt_id?: string;
}

const spend = readFixture<ProofFixture>("proofs/mainnet-spend-2.json");
const drill = readFixture<ProofFixture>("proofs/mainnet-drill-over-cap.json");
const SIGNER = "v0.probarion.near";
const SPEND_2 = "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9";
const DRILL_OVER_CAP = "G6WJcTZA67NBSrLV8zhS7Ay5BQKt6qCSao7dndm1tF1c";
/** The vault's spend receipt and the NEAR Intents receipt of spend 2 (the middle of its tree). */
const VAULT_RECEIPT = "FuEKLqzVPpm3Ks9xVMHmNk3A2SJTNYbra17HVeKz96a9";
const INTENTS_RECEIPT = "F2BErA5fo6HBPhgwjyER9iiCrs9XHmDHX6dsey1dZmVi";
const POA_BURN_RECEIPT = "D7Ux36fgy29tu5jjEoEstVwbLz3FXDP8Q2gDu65ZkK3b";

const clone = <T>(value: T): T => structuredClone(value);

function verified(proof: unknown, head: TrustedHead = spend.head): ProvenOutcome {
  const result = verifyOutcomeProof(proof, head, { status: "any" });
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
  return result.outcome;
}

/** The RPC tx answer's entry for proof `i` of a fixture: the transaction outcome first, then receipts_outcome. */
function txEntry(fixture: ProofFixture, i: number): Json {
  return i === 0 ? fixture.tx.transaction_outcome : fixture.tx.receipts_outcome[i - 1];
}

function expectedStatus(status: unknown): ProvenStatus {
  if (status === "Unknown") return { kind: "unknown" };
  const record = status as Json;
  if ("Failure" in record) return { kind: "failure" };
  if ("SuccessReceiptId" in record) {
    return { kind: "success_receipt_id", receiptId: record.SuccessReceiptId };
  }
  return { kind: "success_value", value: decodeBase64(record.SuccessValue) as Uint8Array };
}

const proofIndex = (fixture: ProofFixture, id: string): number =>
  fixture.proofs.findIndex((proof) => proof.outcome_proof.id === id);

describe("recorded fixtures", () => {
  it("say where they came from and carry no signature", () => {
    for (const fixture of [spend, drill]) {
      expect(fixture._source).toContain("nothing signed");
      expect(fixture._source).toContain("https://archival-rpc.mainnet.fastnear.com");
      expect(fixture.tx.transaction.signature).toBeUndefined();
      expect(fixture.tx.transaction.signer_id).toBe(SIGNER);
    }
    expect(spend.tx.transaction.hash).toBe(SPEND_2);
    expect(spend.proofs).toHaveLength(1 + spend.tx.receipts_outcome.length);
    expect(drill.proofs).toHaveLength(1 + drill.tx.receipts_outcome.length);
    expect(drill.tx.transaction.hash).toBe(DRILL_OVER_CAP);
  });

  it("hold a head that two providers served alike, the same for both fixtures", () => {
    for (const fixture of [spend, drill]) {
      expect(fixture.head_secondary).toEqual({
        rpc: "https://rpc.intea.rs",
        hash: fixture.head.hash,
        height: fixture.head.height,
        block_merkle_root: fixture.head.blockMerkleRoot,
      });
    }
    expect(drill.head).toEqual(spend.head);
  });
});

describe("verifyOutcomeProof on recorded mainnet proofs", () => {
  for (const [name, fixture] of [
    ["spend 2", spend],
    ["drill", drill],
  ] as const) {
    fixture.proofs.forEach((proof, i) => {
      it(`${name} proof ${i} (${proof.outcome_proof.id.slice(0, 8)}) proves what the tx answer says`, () => {
        const outcome = verified(proof, fixture.head);
        const entry = txEntry(fixture, i);
        expect(outcome.id).toBe(entry.id);
        expect(outcome.executorId).toBe(entry.outcome.executor_id);
        expect(outcome.logs).toEqual(entry.outcome.logs);
        expect(outcome.receiptIds).toEqual(entry.outcome.receipt_ids);
        expect(outcome.gasBurnt).toBe(BigInt(entry.outcome.gas_burnt));
        expect(outcome.tokensBurnt).toBe(BigInt(entry.outcome.tokens_burnt));
        expect(outcome.status).toEqual(expectedStatus(entry.outcome.status));
        // The tx answer's entry hashes to the same leaf: the RPC's answer is what the proof commits.
        expect(outcomeLeafHash(entry)).toEqual(outcomeLeafHash(proof.outcome_proof));

        const lite = proof.block_header_lite;
        const height = lite.inner_lite.height;
        expect(outcome.block).toEqual({
          hash: fixture.block_hash_by_height[height],
          height,
          timestampNs: BigInt(lite.inner_lite.timestamp_nanosec),
          epochId: lite.inner_lite.epoch_id,
        });
        expect(lightBlockHash(lite)).toBe(fixture.block_hash_by_height[height]);
        expect(outcome.block.hash).toBe(proof.outcome_proof.block_hash);
        expect(outcome.head).toEqual(fixture.head);
      });
    });
  }

  it("verifies the default expectation (success) on spend 2's receipts", () => {
    for (const proof of spend.proofs) {
      expect(verifyOutcomeProof(proof, spend.head).ok).toBe(true);
    }
  });

  it("checks the expected id and executor after the cryptography", () => {
    const proof = spend.proofs[proofIndex(spend, POA_BURN_RECEIPT)];
    const receiver = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
    expect(
      verifyOutcomeProof(proof, spend.head, { id: POA_BURN_RECEIPT, executorId: receiver }).ok,
    ).toBe(true);
    expect(verifyOutcomeProof(proof, spend.head, { id: INTENTS_RECEIPT })).toMatchObject({
      ok: false,
      code: "id_mismatch",
    });
    expect(verifyOutcomeProof(proof, spend.head, { executorId: "intents.near" })).toMatchObject({
      ok: false,
      code: "executor_mismatch",
    });
  });

  it("reads the exact timestamp_nanosec: the JSON timestamp number is off in recorded headers", () => {
    const off = spend.proofs.filter(
      (proof) =>
        String(BigInt(proof.block_header_lite.inner_lite.timestamp)) !==
        proof.block_header_lite.inner_lite.timestamp_nanosec,
    );
    expect(off.length).toBeGreaterThan(0);
    for (const proof of off) {
      const lite = clone(proof.block_header_lite);
      lite.inner_lite.timestamp_nanosec = String(BigInt(lite.inner_lite.timestamp));
      expect(lightBlockHash(lite)).not.toBe(proof.outcome_proof.block_hash);
    }
  });
});

describe("the drill's refused spend", () => {
  const failed = drill.proofs[1] as Json;

  it("is a proven Failure, refused by the default expectation", () => {
    expect(failed.outcome_proof.id).toBe(drill.failed_receipt_id);
    expect(verifyOutcomeProof(failed, drill.head)).toMatchObject({
      ok: false,
      code: "status_mismatch",
    });
    const result = verifyOutcomeProof(failed, drill.head, { status: "failure" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.status).toEqual({ kind: "failure" });
    expect(result.outcome.executorId).toBe(SIGNER);
  });

  it("keeps the panic text out of the result: the reason is not in the proof", () => {
    expect(JSON.stringify(drill.tx.receipts_outcome[0].outcome.status)).toContain(
      "PROBARION:OverPerPayment",
    );
    const result = verifyOutcomeProof(failed, drill.head, { status: "failure" });
    const text = JSON.stringify(result, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(text).not.toContain("OverPerPayment");
  });

  it("is refused under expectation success and kept under any", () => {
    expect(verifyOutcomeProof(failed, drill.head, { status: "success" }).ok).toBe(false);
    expect(verifyOutcomeProof(failed, drill.head, { status: "any" }).ok).toBe(true);
    expect(verifyOutcomeProof(spend.proofs[1], spend.head, { status: "failure" })).toMatchObject({
      ok: false,
      code: "status_mismatch",
    });
  });
});

describe("verifyTransactionOutcomes", () => {
  const expectSpend = { txHash: SPEND_2, signerId: SIGNER };

  it("proves spend 2's whole tree and reports each outcome in list order", () => {
    const result = verifyTransactionOutcomes(spend.proofs, spend.head, expectSpend);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes.map((outcome) => outcome.id)).toEqual([
      SPEND_2,
      ...spend.tx.receipts_outcome.map((entry: Json) => entry.id),
    ]);
    expect(result.outcomes).toHaveLength(11);
  });

  it("does not depend on the order of the receipt proofs", () => {
    const next = mulberry32(7);
    for (let run = 0; run < 20; run++) {
      const receipts = spend.proofs.slice(1);
      for (let i = receipts.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [receipts[i], receipts[j]] = [receipts[j] as Json, receipts[i] as Json];
      }
      expect(
        verifyTransactionOutcomes([spend.proofs[0], ...receipts], spend.head, expectSpend).ok,
      ).toBe(true);
    }
  });

  it("proves the drill's tree and reports the failed receipt without judging it", () => {
    const result = verifyTransactionOutcomes(drill.proofs, drill.head, {
      txHash: DRILL_OVER_CAP,
      signerId: SIGNER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes[1]?.status).toEqual({ kind: "failure" });
  });

  it("refuses a receipt whose parent proof was dropped (not_linked)", () => {
    const proofs = spend.proofs.filter((proof) => proof.outcome_proof.id !== INTENTS_RECEIPT);
    const orphan = proofs.findIndex((proof) => proof.outcome_proof.id === POA_BURN_RECEIPT);
    expect(verifyTransactionOutcomes(proofs, spend.head, expectSpend)).toMatchObject({
      ok: false,
      index: orphan,
      code: "not_linked",
    });
  });

  it("refuses a proof of another transaction's receipt (not_linked)", () => {
    const proofs = [...spend.proofs, drill.proofs[1]];
    expect(verifyTransactionOutcomes(proofs, spend.head, expectSpend)).toMatchObject({
      ok: false,
      index: proofs.length - 1,
      code: "not_linked",
    });
  });

  it("refuses a proof given twice (duplicate)", () => {
    const proofs = [...spend.proofs, spend.proofs[3]];
    expect(verifyTransactionOutcomes(proofs, spend.head, expectSpend)).toMatchObject({
      ok: false,
      index: proofs.length - 1,
      code: "duplicate",
    });
    expect(
      verifyTransactionOutcomes([spend.proofs[0], spend.proofs[0]], spend.head, expectSpend),
    ).toMatchObject({ ok: false, index: 1, code: "duplicate" });
  });

  it("checks the transaction's proof comes first, with the given hash and signer", () => {
    expect(
      verifyTransactionOutcomes(spend.proofs, spend.head, { txHash: DRILL_OVER_CAP }),
    ).toMatchObject({ ok: false, index: 0, code: "id_mismatch" });
    expect(
      verifyTransactionOutcomes(spend.proofs, spend.head, {
        txHash: SPEND_2,
        signerId: "intents.near",
      }),
    ).toMatchObject({ ok: false, index: 0, code: "executor_mismatch" });
    const swapped = [spend.proofs[1], spend.proofs[0], ...spend.proofs.slice(2)];
    expect(verifyTransactionOutcomes(swapped, spend.head, expectSpend)).toMatchObject({
      ok: false,
      index: 0,
      code: "id_mismatch",
    });
    expect(verifyTransactionOutcomes(spend.proofs, spend.head, { txHash: SPEND_2 }).ok).toBe(true);
  });

  it("refuses an empty list, more than 256 proofs, and a malformed list or expectation", () => {
    expect(verifyTransactionOutcomes([], spend.head, expectSpend)).toMatchObject({
      ok: false,
      index: -1,
      code: "empty",
    });
    const many = Array.from({ length: 257 }, () => spend.proofs[0]);
    expect(verifyTransactionOutcomes(many, spend.head, expectSpend)).toMatchObject({
      ok: false,
      index: -1,
      code: "too_many",
    });
    expect(verifyTransactionOutcomes("x" as never, spend.head, expectSpend)).toMatchObject({
      ok: false,
      index: -1,
      code: "malformed",
    });
    expect(verifyTransactionOutcomes(spend.proofs, spend.head, {} as never)).toMatchObject({
      ok: false,
      index: -1,
      code: "malformed",
    });
  });

  it("names the index of a proof that does not verify", () => {
    const proofs = clone(spend.proofs);
    (proofs[4] as Json).outcome_proof.outcome.gas_burnt += 1;
    expect(verifyTransactionOutcomes(proofs, spend.head, expectSpend)).toMatchObject({
      ok: false,
      index: 4,
      code: "outcome_root_mismatch",
    });
    (proofs[4] as Json).outcome_proof.outcome.gas_burnt = "1";
    expect(verifyTransactionOutcomes(proofs, spend.head, expectSpend)).toMatchObject({
      ok: false,
      index: 4,
      code: "malformed",
    });
    const otherHead = {
      ...spend.head,
      blockMerkleRoot: drill.proofs[0]?.block_header_lite.prev_block_hash,
    };
    expect(verifyTransactionOutcomes(spend.proofs, otherHead, expectSpend)).toMatchObject({
      ok: false,
      index: 0,
      code: "head_mismatch",
    });
  });

  it("proves a subset that stays linked: a receipt left out of the list is not reported", () => {
    const vault = proofIndex(spend, VAULT_RECEIPT);
    const result = verifyTransactionOutcomes(
      [spend.proofs[0], spend.proofs[vault]],
      spend.head,
      expectSpend,
    );
    expect(result.ok).toBe(true);
  });
});

describe("strict parsing", () => {
  const base = spend.proofs[proofIndex(spend, INTENTS_RECEIPT)] as Json;
  const code = (proof: unknown, head: TrustedHead = spend.head) => {
    const result = verifyOutcomeProof(proof, head, { status: "any" });
    return result.ok ? "ok" : result.code;
  };
  const edited = (edit: (proof: Json) => void): Json => {
    const proof = clone(base);
    edit(proof);
    return proof;
  };
  const bytes = (length: number) => encodeBase58(new Uint8Array(length).fill(7));

  it("starts from a proof that verifies", () => {
    expect(code(base)).toBe("ok");
  });

  it("refuses a hash with a leading 1 added, or one of 31 or 33 bytes", () => {
    for (const value of [`1${base.outcome_proof.id}`, bytes(31), bytes(33)]) {
      const proof = edited((p) => {
        p.outcome_proof.id = value;
      });
      const result = verifyOutcomeProof(proof, spend.head, { status: "any" });
      expect(result).toMatchObject({ ok: false, code: "malformed" });
      if (!result.ok) expect(result.detail).toContain("outcome_proof.id");
    }
    expect(
      code(
        edited((p) => {
          p.block_proof[0].hash = `1${p.block_proof[0].hash}`;
        }),
      ),
    ).toBe("malformed");
    expect(decodeBase58Hash(bytes(32))).not.toBeNull();
  });

  it("requires timestamp_nanosec as a canonical u64 string", () => {
    for (const value of [undefined, "18446744073709551616", 1794554670108796200, "01", "", "-1"]) {
      expect(
        code(
          edited((p) => {
            p.block_header_lite.inner_lite.timestamp_nanosec = value;
          }),
        ),
      ).toBe("malformed");
    }
  });

  it("refuses an unknown or ambiguous status", () => {
    for (const status of [
      { SuccessValueX: "" },
      { SuccessValue: "", Failure: {} },
      "unknown",
      "Failure",
      { SuccessValue: "QR==" },
      { SuccessValue: 1 },
      { SuccessReceiptId: "x" },
      { Failure: undefined },
      null,
      undefined,
    ]) {
      expect(
        code(
          edited((p) => {
            p.outcome_proof.outcome.status = status;
          }),
        ),
      ).toBe("malformed");
    }
  });

  it("takes directions spelled exactly Left or Right", () => {
    for (const direction of ["left", "RIGHT", "", 0, undefined]) {
      expect(
        code(
          edited((p) => {
            p.outcome_root_proof[0].direction = direction;
          }),
        ),
      ).toBe("malformed");
    }
  });

  it(`refuses a path of more than ${MAX_PROOF_PATH} items in each of the three paths`, () => {
    for (const path of ["outcome_proof.proof", "outcome_root_proof", "block_proof"]) {
      const at = (p: Json): Json[] =>
        path === "outcome_proof.proof" ? p.outcome_proof.proof : p[path];
      const filled = (count: number) =>
        edited((p) => {
          const items = at(p);
          while (items.length < count) items.push({ ...(items[0] as Json) });
        });
      expect(code(filled(MAX_PROOF_PATH + 1))).toBe("path_too_long");
      // At the cap the path is read, and it fails on the hashes instead.
      expect(code(filled(MAX_PROOF_PATH))).not.toMatch(/malformed|path_too_long|ok/);
    }
  });

  it("refuses numbers where NEAR sends strings and strings where it sends numbers", () => {
    const cases: [string, (p: Json) => void][] = [
      [
        "gas_burnt as a string",
        (p) => {
          p.outcome_proof.outcome.gas_burnt = "1";
        },
      ],
      [
        "gas_burnt above 2^53",
        (p) => {
          p.outcome_proof.outcome.gas_burnt = 2 ** 53;
        },
      ],
      [
        "gas_burnt negative",
        (p) => {
          p.outcome_proof.outcome.gas_burnt = -1;
        },
      ],
      [
        "tokens_burnt as a number",
        (p) => {
          p.outcome_proof.outcome.tokens_burnt = 1;
        },
      ],
      [
        "tokens_burnt over u128",
        (p) => {
          p.outcome_proof.outcome.tokens_burnt = (1n << 128n).toString();
        },
      ],
      [
        "height as a string",
        (p) => {
          p.block_header_lite.inner_lite.height = "1";
        },
      ],
      [
        "executor_id not an account",
        (p) => {
          p.outcome_proof.outcome.executor_id = "Intents.near";
        },
      ],
      [
        "a log that is not a string",
        (p) => {
          p.outcome_proof.outcome.logs = [1];
        },
      ],
      [
        "a lone surrogate in a log",
        (p) => {
          p.outcome_proof.outcome.logs = ["\uD800"];
        },
      ],
      [
        "1001 logs",
        (p) => {
          p.outcome_proof.outcome.logs = Array(1001).fill("x");
        },
      ],
      [
        "receipt_ids missing",
        (p) => {
          delete p.outcome_proof.outcome.receipt_ids;
        },
      ],
      [
        "block_header_lite missing",
        (p) => {
          delete p.block_header_lite;
        },
      ],
      [
        "a path that is not an array",
        (p) => {
          p.block_proof = {};
        },
      ],
    ];
    for (const [name, edit] of cases) {
      expect(code(edited(edit)), name).toBe("malformed");
    }
  });

  it("refuses a malformed head or expectation, and input that is not a proof, without throwing", () => {
    expect(code(base, { blockMerkleRoot: "x" })).toBe("malformed");
    expect(code(base, { ...spend.head, height: -1 })).toBe("malformed");
    expect(code(base, { ...spend.head, hash: "x" })).toBe("malformed");
    expect(code(base, null as never)).toBe("malformed");
    expect(verifyOutcomeProof(base, spend.head, { status: "succes" as never })).toMatchObject({
      ok: false,
      code: "malformed",
    });
    expect(verifyOutcomeProof(base, spend.head, { id: 1 as never })).toMatchObject({
      ok: false,
      code: "malformed",
    });
    for (const value of [null, undefined, "proof", 1, [], {}]) {
      expect(code(value)).toBe("malformed");
    }
    const hostile = clone(base);
    Object.defineProperty(hostile, "outcome_proof", {
      get() {
        throw new Error("boom");
      },
    });
    expect(code(hostile)).toBe("malformed");
  });

  it("names the refused field in the low-level helpers' NearFormatError", () => {
    const lite = clone(base.block_header_lite);
    delete lite.inner_lite.timestamp_nanosec;
    expect(() => lightBlockHash(lite)).toThrow(NearFormatError);
    try {
      lightBlockHash(lite);
    } catch (error) {
      expect((error as NearFormatError).what).toBe(
        "block_header_lite.inner_lite.timestamp_nanosec",
      );
    }
    const outcome = clone(base.outcome_proof);
    outcome.outcome.tokens_burnt = 5;
    try {
      outcomeLeafHash(outcome);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NearFormatError);
      expect((error as NearFormatError).what).toBe("outcome.outcome.tokens_burnt");
    }
  });
});
