import { describe, expect, it } from "vitest";
import { verifyTransactionOutcomes } from "../src/outcome-proof.js";
import { verifyPoaSettlement } from "../src/poa.js";
import type { ProvenOutcome, TrustedHead } from "../src/types.js";
import { readFixture } from "./helpers/fixtures.js";

// One end-to-end check of a cross-chain payout: mainnet spend 2's light_client_proofs (recorded by
// scripts/record-proofs.ts) prove every outcome of the NEAR transaction under one head, and the settlement verdict
// reads the burn pair from those proven outcomes, then binds it to the POA bridge's record and the Base receipt.
const ASSET = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const USDC_ON_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAYEE = "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27";
const SPEND_2 = "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9";
/** The POA token's ft_burn receipt of spend 2, in the NEAR block of 2026-11-13T07:24:30.662Z. */
const FT_BURN = "D7Ux36fgy29tu5jjEoEstVwbLz3FXDP8Q2gDu65ZkK3b";

interface ProofFixture {
  head: TrustedHead;
  proofs: unknown[];
}

const proofs = () => structuredClone(readFixture<ProofFixture>("proofs/mainnet-spend-2.json"));
const baseReceipt = () =>
  structuredClone(
    readFixture<{ receipts: Record<string, Record<string, unknown>> }>("poa/base-receipts.json")
      .receipts["spend-2"],
  ) as Record<string, unknown> & { logs: Record<string, unknown>[] };
const settle = (
  outcomes: Parameters<typeof verifyPoaSettlement>[0]["near"],
  destinationReceipt: unknown = baseReceipt(),
) =>
  verifyPoaSettlement({
    near: outcomes,
    nearTxHash: SPEND_2,
    bridgeAnswer: readFixture<{ answer: unknown }>("poa/poa-status-s1.json").answer,
    destinationReceipt,
    expect: {
      asset: ASSET,
      address: PAYEE,
      erc20: USDC_ON_BASE,
      amount: 1_000_000n,
      owner: "v0.probarion.near",
      maxFee: 2_400n,
    },
  });

/** Spend 2's outcomes, every one proven under the recorded head with the transaction's own proof. */
function provenOutcomes(): readonly ProvenOutcome[] {
  const { head, proofs: list } = proofs();
  const tree = verifyTransactionOutcomes(list, head, {
    txHash: SPEND_2,
    signerId: "v0.probarion.near",
  });
  if (!tree.ok) throw new Error(`the recorded proofs did not verify: ${tree.detail}`);
  return tree.outcomes;
}

describe("the POA settlement on proven outcomes", () => {
  it("settles spend 2 from its proven NEAR outcomes, with the burn pair marked proven", () => {
    const verdict = settle(provenOutcomes());
    expect(verdict.checks.filter((c) => !c.ok)).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.burn).toMatchObject({
      amount: 1_000_000n,
      memo: `WITHDRAW_TO:${PAYEE}`,
      proven: true,
    });
    expect(verdict.checks[0]?.detail).toMatch(/both proven$/);
  });

  it("checks that the Base release is not earlier than the proven burn's NEAR block", () => {
    const outcomes = provenOutcomes();
    expect(outcomes.find((o) => o.id === FT_BURN)?.block.timestampNs).toBe(
      1_794_554_670_662_211_999n,
    );
    expect(settle(outcomes).checks.find((c) => c.id === "destination_transfer")?.detail).toMatch(
      /, at 2026-11-13T07:24:38\.000Z, not before the burn's NEAR block at 2026-11-13T07:24:30\.662Z$/,
    );
    const at = (seconds: number) => {
      const receipt = baseReceipt();
      (receipt.logs[0] as Record<string, unknown>).blockTimestamp = `0x${seconds.toString(16)}`;
      return settle(outcomes, receipt).checks.find((c) => c.id === "destination_transfer");
    };
    // The same second as the burn's block passes (the two chains' clocks are compared to the second).
    expect(at(1_794_554_670)?.ok).toBe(true);
    expect(at(1_794_554_669)).toEqual({
      id: "destination_transfer",
      ok: false,
      detail:
        "the release's Base block time 2026-11-13T07:24:29.000Z is earlier than the burn's NEAR block time " +
        "2026-11-13T07:24:30.662Z: it is not this burn's release",
    });
    // A Base RPC that does not add blockTimestamp to logs: the order is not checked, and the detail says so.
    const bare = baseReceipt();
    delete (bare.logs[0] as Record<string, unknown>).blockTimestamp;
    expect(
      settle(outcomes, bare).checks.find((c) => c.id === "destination_transfer")?.detail,
    ).toMatch(/; the order in time is not checked \(the Base log carries no blockTimestamp\)$/);
  });

  it("refuses when the proofs are not of the transaction the bridge names", () => {
    const { head, proofs: list } = proofs();
    // Without the transaction's own proof, the receipts are not tied to tx BdN7oB76.
    const tree = verifyTransactionOutcomes(list, head, { txHash: SPEND_2 });
    if (!tree.ok) throw new Error(tree.detail);
    const receiptsOnly = tree.outcomes.filter((o) => o.id !== SPEND_2);
    const verdict = settle(receiptsOnly);
    expect(verdict.ok).toBe(false);
    expect(verdict.checks[0]?.detail).toMatch(/do not include the outcome of transaction/);
  });
});
