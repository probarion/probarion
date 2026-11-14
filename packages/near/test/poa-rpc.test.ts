import { describe, expect, it } from "vitest";
import { NearFormatError } from "../src/errors.js";
import { POA_BRIDGE_RPC_URL, readPoaWithdrawalStatus } from "../src/poa-rpc.js";
import { NearRpcError } from "../src/rpc.js";
import { fakeRpc } from "./helpers/fake-rpc.js";
import { readFixture } from "./helpers/fixtures.js";

const SPEND_2 = "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9";
const SPEND_3 = "5amtgb8MujUkiydS5Ht9Ut6AX6pN9SGegHUCHGsX9NGH";
const answer = (file: string) => readFixture<{ answer: unknown }>(`poa/${file}`).answer;

describe("readPoaWithdrawalStatus (Experimental)", () => {
  it("sends exactly withdrawal_status with [{ withdrawal_hash }] and parses the answer", async () => {
    const bridge = fakeRpc(() => answer("poa-status-s1.json"));
    const records = await readPoaWithdrawalStatus(bridge, SPEND_2);
    expect(bridge.calls).toEqual([
      { method: "withdrawal_status", params: [{ withdrawal_hash: SPEND_2 }] },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: "COMPLETED",
      burnTxHash: SPEND_2,
      fee: 2_400n,
      received: 997_600n,
    });
    expect(POA_BRIDGE_RPC_URL).toBe("https://bridge.chaindefuser.com/rpc");
  });

  it("refuses an answer about another burn transaction", async () => {
    const bridge = fakeRpc(() => answer("poa-status-s1.json"));
    await expect(readPoaWithdrawalStatus(bridge, SPEND_3)).rejects.toThrow(NearFormatError);
    await expect(readPoaWithdrawalStatus(bridge, SPEND_3)).rejects.toMatchObject({
      what: "withdrawals[0].data.tx_hash",
    });
  });

  it("gives [] for no record, and passes the client's error and format errors through", async () => {
    expect(
      await readPoaWithdrawalStatus(
        fakeRpc(() => ({ withdrawals: [] })),
        SPEND_2,
      ),
    ).toEqual([]);
    const failing = fakeRpc(() => {
      throw new NearRpcError("withdrawal_status", { code: -32000 }, "withdrawal_status: refused");
    });
    await expect(readPoaWithdrawalStatus(failing, SPEND_2)).rejects.toThrow(NearRpcError);
    await expect(
      readPoaWithdrawalStatus(
        fakeRpc(() => "COMPLETED"),
        SPEND_2,
      ),
    ).rejects.toThrow(NearFormatError);
  });

  it("refuses a hash that is not a NEAR transaction hash before sending anything", async () => {
    const bridge = fakeRpc(() => answer("poa-status-s1.json"));
    for (const bad of ["", "0xc2df", `${SPEND_2}1`, `${SPEND_2.slice(0, -1)}0`]) {
      await expect(readPoaWithdrawalStatus(bridge, bad), bad).rejects.toThrow(TypeError);
    }
    expect(bridge.calls).toEqual([]);
  });
});
