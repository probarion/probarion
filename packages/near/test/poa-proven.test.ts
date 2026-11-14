import { describe, expect, it } from "vitest";
import { verifyTransactionOutcomes } from "../src/outcome-proof.js";
import { verifyPoaSettlement } from "../src/poa.js";
import type { TrustedHead } from "../src/types.js";
import { readFixture } from "./helpers/fixtures.js";

// One end-to-end check of a cross-chain payout: mainnet spend 2's light_client_proofs (recorded by
// scripts/record-proofs.ts) prove every outcome of the NEAR transaction under one head, and the settlement verdict
// reads the burn pair from those proven outcomes, then binds it to the POA bridge's record and the Base receipt.
const ASSET = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const USDC_ON_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAYEE = "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27";
const SPEND_2 = "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9";

interface ProofFixture {
  head: TrustedHead;
  proofs: unknown[];
}

const proofs = () => structuredClone(readFixture<ProofFixture>("proofs/mainnet-spend-2.json"));
const settle = (outcomes: Parameters<typeof verifyPoaSettlement>[0]["near"]) =>
  verifyPoaSettlement({
    near: outcomes,
    nearTxHash: SPEND_2,
    bridgeAnswer: readFixture<{ answer: unknown }>("poa/poa-status-s1.json").answer,
    destinationReceipt: readFixture<{ receipts: Record<string, unknown> }>("poa/base-receipts.json")
      .receipts["spend-2"],
    expect: {
      asset: ASSET,
      address: PAYEE,
      erc20: USDC_ON_BASE,
      amount: 1_000_000n,
      owner: "v0.probarion.near",
    },
  });

describe("the POA settlement on proven outcomes", () => {
  it("settles spend 2 from its proven NEAR outcomes, with the burn pair marked proven", () => {
    const { head, proofs: list } = proofs();
    const tree = verifyTransactionOutcomes(list, head, {
      txHash: SPEND_2,
      signerId: "v0.probarion.near",
    });
    if (!tree.ok) throw new Error(`the recorded proofs did not verify: ${tree.detail}`);
    const verdict = settle(tree.outcomes);
    expect(verdict.checks.filter((c) => !c.ok)).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.burn).toMatchObject({
      amount: 1_000_000n,
      memo: `WITHDRAW_TO:${PAYEE}`,
      proven: true,
    });
    expect(verdict.checks[0]?.detail).toMatch(/both proven$/);
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
