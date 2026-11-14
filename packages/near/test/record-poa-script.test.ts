import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NEAR_ARCHIVAL_RPC_URL,
  POA_SPENDS,
  RECORDER_METHODS,
  type RecordedTx,
  recordSpend,
  txParams,
} from "../scripts/record-poa.js";
import { fakeRpc } from "./helpers/fake-rpc.js";
import { readFixture } from "./helpers/fixtures.js";

const SOURCE = readFileSync(new URL("../scripts/record-poa.ts", import.meta.url), "utf8");
const evidence = (file: string) => readFixture<{ answer: unknown }>(`poa/${file}`).answer;

describe("scripts/record-poa.ts", () => {
  it("sends tx and withdrawal_status only, to the two public endpoints, and nothing that signs", () => {
    expect(RECORDER_METHODS).toEqual(["tx", "withdrawal_status"]);
    // Every direct call in the script is `tx`; the bridge is read through readPoaWithdrawalStatus.
    const direct = [...SOURCE.matchAll(/\.call(?:<[^>]*>)?\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(direct).toEqual(["tx"]);
    expect(SOURCE).toContain("readPoaWithdrawalStatus(bridge, spend.txHash)");
    expect([...SOURCE.matchAll(/https:\/\/[^\s"'`]+/g)].map((m) => m[0])).toEqual([
      NEAR_ARCHIVAL_RPC_URL,
    ]);
    expect(SOURCE).toContain("httpJsonRpc(POA_BRIDGE_RPC_URL");
    for (const word of [
      "send_tx",
      "broadcast_tx",
      "eth_send",
      "child_process",
      "near-credentials",
    ]) {
      expect(SOURCE, word).not.toContain(word);
    }
  });

  it("asks for the two payouts with their sender and wait_until FINAL", () => {
    expect(POA_SPENDS.map(txParams)).toEqual([
      {
        tx_hash: "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9",
        sender_account_id: "v0.probarion.near",
        wait_until: "FINAL",
      },
      {
        tx_hash: "5amtgb8MujUkiydS5Ht9Ut6AX6pN9SGegHUCHGsX9NGH",
        sender_account_id: "v0.probarion.near",
        wait_until: "FINAL",
      },
    ]);
  });

  it("wrote the committed fixtures: the request it sent, and the answer without its signature", () => {
    for (const spend of POA_SPENDS) {
      const recorded = readFixture<RecordedTx>(`poa/${spend.file}`);
      expect(recorded._source).toContain("Read-only, nothing signed");
      expect(recorded.request).toEqual({
        url: NEAR_ARCHIVAL_RPC_URL,
        method: "tx",
        params: txParams(spend),
      });
      const transaction = recorded.result.transaction as Record<string, unknown>;
      expect(transaction.hash).toBe(spend.txHash);
      expect(transaction.signer_id).toBe(spend.sender);
      expect("signature" in transaction).toBe(false);
      expect(recorded.result.final_execution_status).toBe("FINAL");
    }
  });

  it("drops the signature, makes one call to each endpoint, and keeps the rest of the answer", async () => {
    const spend = POA_SPENDS[0];
    const recorded = readFixture<RecordedTx>(`poa/${spend.file}`);
    const answered = structuredClone(recorded.result);
    (answered.transaction as Record<string, unknown>).signature = "ed25519:not-a-real-signature";
    const near = fakeRpc(() => structuredClone(answered));
    const bridge = fakeRpc(() => evidence(spend.evidence));
    const now = new Date("2026-11-14T05:00:00.000Z");
    const out = await recordSpend(near, bridge, spend, evidence(spend.evidence), now);
    expect(near.calls).toEqual([{ method: "tx", params: txParams(spend) }]);
    expect(bridge.calls).toEqual([
      { method: "withdrawal_status", params: [{ withdrawal_hash: spend.txHash }] },
    ]);
    expect(out.result).toEqual(recorded.result);
    expect(out._source).toContain("2026-11-14T05:00:00.000Z");
  });

  it("writes nothing for a bridge record that differs from the evidence, or an answer for another tx", async () => {
    const [two, three] = POA_SPENDS;
    const recorded = readFixture<RecordedTx>(`poa/${two.file}`).result;
    const near = fakeRpc(() => structuredClone(recorded));
    const pending = structuredClone(evidence(two.evidence)) as {
      withdrawals: { status: string }[];
    };
    (pending.withdrawals[0] as { status: string }).status = "PENDING";
    await expect(
      recordSpend(
        near,
        fakeRpc(() => pending),
        two,
        evidence(two.evidence),
        new Date(),
      ),
    ).rejects.toThrow(/differ/);
    await expect(
      recordSpend(
        near,
        fakeRpc(() => evidence(three.evidence)),
        three,
        evidence(three.evidence),
        new Date(),
      ),
    ).rejects.toThrow(/is for BdN7oB76/);
  });
});
