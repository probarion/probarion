import { describe, expect, it } from "vitest";
import { asWalletTx, sendNearTx } from "./transfer";

const HALF = "500000000000000000000000"; // 0.5 NEAR

describe("sendNearTx (R3 top-up)", () => {
  it("is one plain Transfer to the vault: no method, no args, no gas, the deposit only", () => {
    const tx = sendNearTx("acme.vaults.probarion.near", HALF);
    expect(tx).toEqual({
      receiverId: "acme.vaults.probarion.near",
      actions: [{ type: "Transfer", params: { deposit: HALF } }],
      summary:
        "Send 0.5 NEAR to acme.vaults.probarion.near (it pays the vault's storage and gas, and cannot be withdrawn)",
    });
  });

  it("passes the same object to the wallet layer", () => {
    const tx = sendNearTx("acme.vaults.probarion.near", HALF);
    expect(asWalletTx(tx)).toBe(tx);
  });

  it.each([
    ["0", "zero"],
    ["-1", "negative"],
    ["1e24", "exponent"],
    ["01", "leading zero"],
    [(2n ** 128n).toString(), "above u128"],
  ])("refuses the amount %s (%s)", (amount) => {
    expect(() => sendNearTx("acme.vaults.probarion.near", amount)).toThrow(RangeError);
  });

  it("refuses a receiver that is not a NEAR account id", () => {
    expect(() => sendNearTx("Acme.near", HALF)).toThrow(RangeError);
    expect(() => sendNearTx("a", HALF)).toThrow(RangeError);
  });
});
