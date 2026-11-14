// N1's online helpers over a scripted NearRpc (no network): the exact params sent, the head cross-check, and
// proveTransaction and the prove-receipt example served from the recorded mainnet answers.
import { describe, expect, it } from "vitest";
import { proveReceipt, RECEIPT_ID, RECEIVER_ID } from "../examples/prove-receipt.js";
import { NearFormatError } from "../src/errors.js";
import {
  fetchOutcomeProof,
  HeadMismatchError,
  proveTransaction,
  readCrossCheckedHead,
} from "../src/proof-rpc.js";
import { NearRpcError } from "../src/rpc.js";
import type { TrustedHead } from "../src/types.js";
import { fakeRpc } from "./helpers/fake-rpc.js";
import { readFixture } from "./helpers/fixtures.js";

// biome-ignore lint/suspicious/noExplicitAny: raw RPC JSON
type Json = Record<string, any>;

interface ProofFixture {
  head: Required<TrustedHead>;
  tx: Json;
  proofs: Json[];
}

const spend = readFixture<ProofFixture>("proofs/mainnet-spend-2.json");
const drill = readFixture<ProofFixture>("proofs/mainnet-drill-over-cap.json");
const SIGNER = "v0.probarion.near";
const SPEND_2 = "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9";
const head = spend.head;
const clone = <T>(value: T): T => structuredClone(value);

/** A `block` answer with the header fields the cross-check reads. */
const blockAnswer = (h: Required<TrustedHead>) => ({
  header: { hash: h.hash, height: h.height, block_merkle_root: h.blockMerkleRoot, prev_hash: "x" },
});

/** Serves `tx` and `light_client_proof` from a fixture, like an archival node would. */
function archivalFrom(
  fixture: ProofFixture,
  edit?: (method: string, params: Json, answer: Json) => Json,
) {
  return fakeRpc((method, raw) => {
    const params = raw as Json;
    let answer: Json | undefined;
    if (method === "tx") answer = clone(fixture.tx);
    if (method === "light_client_proof") {
      const id = params.type === "transaction" ? params.transaction_hash : params.receipt_id;
      answer = clone(fixture.proofs.find((proof) => proof.outcome_proof.id === id));
    }
    if (answer === undefined)
      throw new NearRpcError(method, { name: "UNKNOWN" }, `${method}: not served`);
    return edit === undefined ? answer : edit(method, params, answer);
  });
}

describe("fetchOutcomeProof", () => {
  it("sends light_client_proof with nearcore's params for a transaction and for a receipt", async () => {
    const rpc = fakeRpc(() => ({ answer: true }));
    await expect(
      fetchOutcomeProof(rpc, { type: "transaction", txHash: SPEND_2, senderId: SIGNER }, head.hash),
    ).resolves.toEqual({ answer: true });
    await fetchOutcomeProof(
      rpc,
      { type: "receipt", receiptId: RECEIPT_ID, receiverId: RECEIVER_ID },
      head.hash,
    );
    expect(rpc.calls).toEqual([
      {
        method: "light_client_proof",
        params: {
          type: "transaction",
          transaction_hash: SPEND_2,
          sender_id: SIGNER,
          light_client_head: head.hash,
        },
      },
      {
        method: "light_client_proof",
        params: {
          type: "receipt",
          receipt_id: RECEIPT_ID,
          receiver_id: RECEIVER_ID,
          light_client_head: head.hash,
        },
      },
    ]);
  });

  it("refuses a malformed target or head hash before calling", async () => {
    const rpc = fakeRpc(() => ({}));
    const bad: [Parameters<typeof fetchOutcomeProof>[1], string, string][] = [
      [{ type: "transaction", txHash: "x", senderId: SIGNER }, head.hash, "target.txHash"],
      [{ type: "transaction", txHash: SPEND_2, senderId: "Bad" }, head.hash, "target.senderId"],
      [
        { type: "receipt", receiptId: `1${RECEIPT_ID}`, receiverId: RECEIVER_ID },
        head.hash,
        "target.receiptId",
      ],
      [{ type: "receipt", receiptId: RECEIPT_ID, receiverId: "" }, head.hash, "target.receiverId"],
      [{ type: "block" } as never, head.hash, "target.type"],
      [{ type: "transaction", txHash: SPEND_2, senderId: SIGNER }, "head", "headHash"],
    ];
    for (const [target, headHash, what] of bad) {
      const error = await fetchOutcomeProof(rpc, target, headHash).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NearFormatError);
      expect((error as NearFormatError).what).toBe(what);
    }
    expect(rpc.calls).toEqual([]);
  });

  it("passes the RPC's error through", async () => {
    const rpc = fakeRpc(() => {
      throw new NearRpcError("light_client_proof", { name: "HANDLER_ERROR" }, "unknown block");
    });
    await expect(
      fetchOutcomeProof(rpc, { type: "transaction", txHash: SPEND_2, senderId: SIGNER }, head.hash),
    ).rejects.toBeInstanceOf(NearRpcError);
  });
});

describe("readCrossCheckedHead", () => {
  it("reads the final block on the primary and the same block by hash on the secondary", async () => {
    const primary = fakeRpc(() => blockAnswer(head));
    const secondary = fakeRpc(() => blockAnswer(head));
    await expect(readCrossCheckedHead(primary, secondary)).resolves.toEqual(head);
    expect(primary.calls).toEqual([{ method: "block", params: { finality: "final" } }]);
    expect(secondary.calls).toEqual([{ method: "block", params: { block_id: head.hash } }]);
  });

  it("throws HeadMismatchError naming the field the providers disagree on", async () => {
    const other = drill.proofs[1]?.block_header_lite.prev_block_hash as string;
    const cases: [Required<TrustedHead>, HeadMismatchError["field"]][] = [
      [{ ...head, hash: other }, "hash"],
      [{ ...head, height: head.height + 1 }, "height"],
      [{ ...head, blockMerkleRoot: other }, "block_merkle_root"],
    ];
    for (const [seen, field] of cases) {
      const error = await readCrossCheckedHead(
        fakeRpc(() => blockAnswer(head)),
        fakeRpc(() => blockAnswer(seen)),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HeadMismatchError);
      expect((error as HeadMismatchError).field).toBe(field);
      expect((error as HeadMismatchError).name).toBe("HeadMismatchError");
    }
  });

  it("refuses a block answer without a well-formed header", async () => {
    const answers: [unknown, string][] = [
      [{}, "primary block.header"],
      [{ header: { ...blockAnswer(head).header, hash: "x" } }, "primary block.header.hash"],
      [{ header: { ...blockAnswer(head).header, height: "1" } }, "primary block.header.height"],
      [
        { header: { ...blockAnswer(head).header, block_merkle_root: 1 } },
        "primary block.header.block_merkle_root",
      ],
    ];
    for (const [answer, what] of answers) {
      const secondary = fakeRpc(() => blockAnswer(head));
      const error = await readCrossCheckedHead(
        fakeRpc(() => answer),
        secondary,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NearFormatError);
      expect((error as NearFormatError).what).toBe(what);
      expect(secondary.calls).toEqual([]);
    }
    const error = await readCrossCheckedHead(
      fakeRpc(() => blockAnswer(head)),
      fakeRpc(() => ({ header: null })),
    ).catch((e: unknown) => e);
    expect((error as NearFormatError).what).toBe("secondary block.header");
  });

  it("refuses one provider passed twice, and passes RPC errors through", async () => {
    const rpc = fakeRpc(() => blockAnswer(head));
    await expect(readCrossCheckedHead(rpc, rpc)).rejects.toBeInstanceOf(TypeError);
    expect(rpc.calls).toEqual([]);
    await expect(
      readCrossCheckedHead(
        fakeRpc(() => blockAnswer(head)),
        fakeRpc(() => {
          throw new NearRpcError("block", { name: "UNKNOWN_BLOCK" }, "block: unknown block");
        }),
      ),
    ).rejects.toBeInstanceOf(NearRpcError);
  });
});

describe("proveTransaction", () => {
  it("proves spend 2 from the recorded answers, fetching the tx and then each receipt's proof", async () => {
    const rpc = archivalFrom(spend);
    const result = await proveTransaction(rpc, { txHash: SPEND_2, senderId: SIGNER, head });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcomes).toHaveLength(11);
    expect(result.outcomes.map((outcome) => outcome.head)).toEqual(Array(11).fill(head));
    expect(rpc.calls[0]).toEqual({
      method: "tx",
      params: { tx_hash: SPEND_2, sender_account_id: SIGNER, wait_until: "FINAL" },
    });
    expect(rpc.calls[1]?.params).toEqual({
      type: "transaction",
      transaction_hash: SPEND_2,
      sender_id: SIGNER,
      light_client_head: head.hash,
    });
    expect(rpc.calls.slice(2).map((call) => call.params)).toEqual(
      spend.tx.receipts_outcome.map((entry: Json) => ({
        type: "receipt",
        receipt_id: entry.id,
        receiver_id: entry.outcome.executor_id,
        light_client_head: head.hash,
      })),
    );
  });

  it("proves the drill's tree and reports its failed receipt", async () => {
    const result = await proveTransaction(archivalFrom(drill), {
      txHash: drill.tx.transaction.hash,
      senderId: SIGNER,
      head,
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.outcomes.map((outcome) => outcome.status.kind)).toContain("failure");
  });

  it("does not trust the tx answer: an invented receipt does not link, a lying proof does not verify", async () => {
    const stranger = drill.proofs[1] as Json;
    const invented = archivalFrom(spend, (method, _params, answer) => {
      if (method !== "tx") return answer;
      answer.receipts_outcome.push(clone(drill.tx.receipts_outcome[0]));
      return answer;
    });
    // The fake archival node serves the drill's receipt when asked for it.
    const withStranger = fakeRpc(async (method, params) => {
      const p = params as Json;
      if (method === "light_client_proof" && p.receipt_id === stranger.outcome_proof.id) {
        return clone(stranger);
      }
      return invented.call(method, params);
    });
    await expect(
      proveTransaction(withStranger, { txHash: SPEND_2, senderId: SIGNER, head }),
    ).resolves.toMatchObject({ ok: false, index: 11, code: "not_linked" });

    const lying = archivalFrom(spend, (method, params, answer) => {
      if (method === "light_client_proof" && params.receipt_id === RECEIPT_ID) {
        answer.outcome_proof.outcome.logs = ["EVENT_JSON:{}"];
      }
      return answer;
    });
    await expect(
      proveTransaction(lying, { txHash: SPEND_2, senderId: SIGNER, head }),
    ).resolves.toMatchObject({ ok: false, code: "outcome_root_mismatch" });
  });

  it("does not trust the tx answer's list either: a receipt it leaves out makes the tree incomplete", async () => {
    // The drill's tx answer with its receipts dropped: without the check, the refused spend would read as a success.
    const dropped = archivalFrom(drill, (method, _params, answer) => {
      if (method === "tx") answer.receipts_outcome = [];
      return answer;
    });
    const result = await proveTransaction(dropped, {
      txHash: drill.tx.transaction.hash,
      senderId: SIGNER,
      head,
    });
    expect(result).toMatchObject({ ok: false, index: 0, code: "incomplete" });
    if (!result.ok) {
      expect(result.detail).toContain(`created receipt ${drill.proofs[1]?.outcome_proof.id}`);
    }
    expect(dropped.calls.map((call) => call.method)).toEqual(["tx", "light_client_proof"]);

    // Spend 2's tx answer without one of its leaf receipts: the proof of the receipt that created it is named.
    const leaf = spend.tx.receipts_outcome.find(
      (entry: Json) => entry.outcome.receipt_ids.length === 0,
    ) as Json;
    const short = archivalFrom(spend, (method, _params, answer) => {
      if (method === "tx") {
        answer.receipts_outcome = answer.receipts_outcome.filter((e: Json) => e.id !== leaf.id);
      }
      return answer;
    });
    const served = [spend.tx.transaction_outcome, ...spend.tx.receipts_outcome].filter(
      (entry: Json) => entry.id !== leaf.id,
    );
    const parent = served.findIndex((entry: Json) => entry.outcome.receipt_ids.includes(leaf.id));
    expect(parent).toBeGreaterThanOrEqual(0);
    await expect(
      proveTransaction(short, { txHash: SPEND_2, senderId: SIGNER, head }),
    ).resolves.toMatchObject({ ok: false, index: parent, code: "incomplete" });
  });

  it("returns too_many without fetching proofs for a tree over the cap", async () => {
    const rpc = archivalFrom(spend, (method, _params, answer) => {
      if (method !== "tx") return answer;
      answer.receipts_outcome = Array(256).fill(answer.receipts_outcome[0]);
      return answer;
    });
    await expect(
      proveTransaction(rpc, { txHash: SPEND_2, senderId: SIGNER, head }),
    ).resolves.toMatchObject({ ok: false, index: -1, code: "too_many" });
    expect(rpc.calls.map((call) => call.method)).toEqual(["tx"]);
  });

  it("refuses malformed input before calling, and a tx answer without receipts", async () => {
    const rpc = fakeRpc(() => ({}));
    const inputs: [unknown, string][] = [
      [{ txHash: "x", senderId: SIGNER, head }, "input.txHash"],
      [{ txHash: SPEND_2, senderId: "Bad", head }, "input.senderId"],
      [{ txHash: SPEND_2, senderId: SIGNER, head: { ...head, hash: "x" } }, "input.head.hash"],
      [
        { txHash: SPEND_2, senderId: SIGNER, head: { ...head, blockMerkleRoot: "x" } },
        "input.head.blockMerkleRoot",
      ],
      [{ txHash: SPEND_2, senderId: SIGNER }, "input"],
    ];
    for (const [input, what] of inputs) {
      const error = await proveTransaction(rpc, input as never).catch((e: unknown) => e);
      expect((error as NearFormatError).what).toBe(what);
    }
    expect(rpc.calls).toEqual([]);
    const error = await proveTransaction(
      fakeRpc(() => ({ receipts_outcome: [{ id: "x" }] })),
      {
        txHash: SPEND_2,
        senderId: SIGNER,
        head,
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NearFormatError);
    expect((error as NearFormatError).what).toBe("tx.receipts_outcome[0]");
  });
});

describe("examples/prove-receipt.ts", () => {
  it("proves the POA burn receipt of spend 2 from recorded answers", async () => {
    const proven = await proveReceipt(
      fakeRpc(() => blockAnswer(head)),
      fakeRpc(() => blockAnswer(head)),
      archivalFrom(spend),
    );
    const proof = spend.proofs.find((p) => p.outcome_proof.id === RECEIPT_ID) as Json;
    expect(proven).toEqual({
      receiptId: RECEIPT_ID,
      executorId: RECEIVER_ID,
      logs: proof.outcome_proof.outcome.logs,
      blockHash: proof.outcome_proof.block_hash,
      height: proof.block_header_lite.inner_lite.height,
      head,
    });
    expect(proven.logs[0]).toContain('"event":"ft_burn"');
    expect(proven.logs[0]).toContain("WITHDRAW_TO:0x");
  });

  it("throws when the archival node serves a proof that does not verify", async () => {
    const archival = archivalFrom(spend, (_method, _params, answer) => {
      answer.block_header_lite.inner_rest_hash = answer.block_header_lite.prev_block_hash;
      return answer;
    });
    await expect(
      proveReceipt(
        fakeRpc(() => blockAnswer(head)),
        fakeRpc(() => blockAnswer(head)),
        archival,
      ),
    ).rejects.toThrow(/block_hash_mismatch/);
  });
});
