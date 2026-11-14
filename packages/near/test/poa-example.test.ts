import { describe, expect, it } from "vitest";
import { checkPayout, type PayoutToBase } from "../examples/check-payout.js";
import { fakeRpc } from "./helpers/fake-rpc.js";
import { readFixture } from "./helpers/fixtures.js";

const PAYOUT: PayoutToBase = {
  txHash: "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9",
  sender: "v0.probarion.near",
  asset: "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  address: "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27",
  erc20: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  amount: 1_000_000n,
  maxFee: 5_000n,
};
const RELEASE = "0xc2df8f8799467834cdaed0e8f23638af49334483387560fd34ef360939e1ea71";

/** Three fake endpoints serving the recorded spend-2 records. */
function endpoints(
  bridgeAnswer: unknown = readFixture<{ answer: unknown }>("poa/poa-status-s1.json").answer,
) {
  return {
    near: fakeRpc(() => readFixture<{ result: unknown }>("poa/mainnet-spend-2-tx.json").result),
    base: fakeRpc(
      () =>
        readFixture<{ receipts: Record<string, unknown> }>("poa/base-receipts.json").receipts[
          "spend-2"
        ],
    ),
    bridge: fakeRpc(() => bridgeAnswer),
  };
}

describe("examples/check-payout.ts", () => {
  it("reads the three records of spend 2 and settles it", async () => {
    const { near, base, bridge } = endpoints();
    const verdict = await checkPayout(near, base, bridge, PAYOUT);
    expect(verdict.ok).toBe(true);
    expect(verdict.checks.every((c) => c.ok)).toBe(true);
    expect(near.calls).toEqual([
      {
        method: "tx",
        params: { tx_hash: PAYOUT.txHash, sender_account_id: PAYOUT.sender, wait_until: "FINAL" },
      },
    ]);
    expect(bridge.calls).toEqual([
      { method: "withdrawal_status", params: [{ withdrawal_hash: PAYOUT.txHash }] },
    ]);
    expect(base.calls).toEqual([{ method: "eth_getTransactionReceipt", params: [RELEASE] }]);
    expect(verdict.transfer?.value).toBe(997_600n);
  });

  it("does not ask Base when the bridge names no release, and reports why", async () => {
    const { near, base, bridge } = endpoints({ withdrawals: [] });
    const verdict = await checkPayout(near, base, bridge, PAYOUT);
    expect(verdict.ok).toBe(false);
    expect(base.calls).toEqual([]);
    expect(verdict.checks.find((c) => c.id === "bridge_record")?.detail).toBe(
      `the bridge has no record of ${PAYOUT.txHash}`,
    );
    const garbled = endpoints("COMPLETED");
    const refused = await checkPayout(garbled.near, garbled.base, garbled.bridge, PAYOUT);
    expect(refused.checks.find((c) => c.id === "bridge_record")?.detail).toMatch(/not readable/);
    expect(garbled.base.calls).toEqual([]);
  });

  it("fails the verdict when the payout was meant for another address", async () => {
    const { near, base, bridge } = endpoints();
    const verdict = await checkPayout(near, base, bridge, {
      ...PAYOUT,
      address: `0x${"1".repeat(40)}`,
    });
    expect(verdict.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual([
      "memo_address",
      "destination_transfer",
    ]);
  });
});
