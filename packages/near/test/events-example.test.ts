import { describe, expect, it } from "vitest";
import { paidAmount, TESTNET_SPEND_1 } from "../examples/read-events.js";
import { EVENT_JSON_PREFIX } from "../src/events.js";
import type { OutcomeLike, TxTreeLike } from "../src/types.js";
import { fakeRpc } from "./helpers/fake-rpc.js";
import { readFixture } from "./helpers/fixtures.js";

// The real testnet `tx` answer of spend 1 (`paid` in the byte copy of apps/web/test/fixtures/testnet-spend-trees.json).
const PAID = readFixture<Record<"paid", TxTreeLike>>("events/testnet-spend-trees.json").paid;
const { txHash, sender, ft, merchant } = TESTNET_SPEND_1;

describe("examples/read-events.ts paidAmount", () => {
  it("reads one tx view and returns the merchant's 1000000 from the token's own event", async () => {
    const rpc = fakeRpc(() => PAID);
    expect(await paidAmount(rpc, txHash, sender, ft, merchant)).toBe(1_000_000n);
    expect(rpc.calls).toEqual([
      { method: "tx", params: { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" } },
    ]);
    expect(PAID.transaction?.hash).toBe(txHash);
  });

  it("returns the payer's side as a negative change and 0n for an account no event names", async () => {
    const rpc = fakeRpc(() => PAID);
    expect(await paidAmount(rpc, txHash, sender, ft, sender)).toBe(-1_000_000n);
    expect(await paidAmount(rpc, txHash, sender, ft, "someone-else.testnet")).toBe(0n);
    expect(await paidAmount(rpc, txHash, sender, "other-ft.testnet", merchant)).toBe(0n);
  });

  it("refuses when an event of the token cannot be read", async () => {
    // Derived from the real tree, labelled: the token's receipt also writes a broken EVENT_JSON: line.
    const broken = structuredClone(PAID);
    const receipt = broken.receipts_outcome.find(
      (r) => r.outcome.executor_id === ft,
    ) as OutcomeLike;
    (receipt.outcome.logs as string[]).push(`${EVENT_JSON_PREFIX}{"standard":"nep141"`);
    await expect(
      paidAmount(
        fakeRpc(() => broken),
        txHash,
        sender,
        ft,
        merchant,
      ),
    ).rejects.toThrow(/cannot all be read: malformed_event/);
  });

  it("refuses when the answer lacks a receipt that one of its outcomes created", async () => {
    // Derived from the real tree, labelled: the token's receipt left out, as an RPC that hides it would.
    const hidden = structuredClone(PAID);
    (hidden as { receipts_outcome: OutcomeLike[] }).receipts_outcome =
      hidden.receipts_outcome.filter((r) => r.outcome.executor_id !== ft);
    await expect(
      paidAmount(
        fakeRpc(() => hidden),
        txHash,
        sender,
        ft,
        merchant,
      ),
    ).rejects.toThrow(/cannot all be read: missing_outcome: .* created receipt /);
  });

  it("passes an RPC failure through", async () => {
    const rpc = fakeRpc(() => {
      throw new Error("UNKNOWN_TRANSACTION");
    });
    await expect(paidAmount(rpc, txHash, sender, ft, merchant)).rejects.toThrow(
      "UNKNOWN_TRANSACTION",
    );
  });
});
