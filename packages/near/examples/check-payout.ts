// Example: did a payout from NEAR Intents to a Base address settle? Reads the three public records (the NEAR
// transaction, the POA bridge's record of it, the Base release it names) and returns one verdict. It reads
// public data and signs nothing. In an app, import from "@probarion/near"; here the source files are imported directly.
//
//   const near = httpJsonRpc("https://archival-rpc.mainnet.fastnear.com");
//   const base = httpJsonRpc("https://mainnet.base.org");
//   const bridge = httpJsonRpc(POA_BRIDGE_RPC_URL);
//   const verdict = await checkPayout(near, base, bridge, {
//     txHash: "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9",
//     sender: "v0.probarion.near",
//     asset: "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
//     address: "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27",
//     erc20: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
//   });
//   for (const check of verdict.checks) console.log(check.ok ? "pass" : "FAIL", check.id, check.detail);
import { type PoaSettlement, parsePoaWithdrawalStatus, verifyPoaSettlement } from "../src/poa.js";
import type { NearRpc } from "../src/rpc.js";
import type { TxTreeLike } from "../src/types.js";

export interface PayoutToBase {
  /** The NEAR transaction that called `ft_withdraw`, and the account that signed it. */
  txHash: string;
  sender: string;
  /** The POA token burned, the Base address it was sent to, and the ERC-20 it is released as on Base. */
  asset: string;
  address: string;
  erc20: string;
  amount?: bigint;
  owner?: string;
  maxFee?: bigint;
}

/**
 * `tx` (wait_until FINAL, so every receipt has its final status) on `near`, `withdrawal_status` on `bridge` (the
 * request readPoaWithdrawalStatus sends; the raw answer goes to the verdict, which reads it itself), then
 * `eth_getTransactionReceipt` on `base` for the release the bridge names. A failed read throws the client's
 * error; everything the records say, including a missing release, is in the verdict.
 */
export async function checkPayout(
  near: NearRpc,
  base: NearRpc,
  bridge: NearRpc,
  payout: PayoutToBase,
): Promise<PoaSettlement> {
  const tx = await near.call<TxTreeLike>("tx", {
    tx_hash: payout.txHash,
    sender_account_id: payout.sender,
    wait_until: "FINAL",
  });
  const bridgeAnswer = await bridge.call("withdrawal_status", [{ withdrawal_hash: payout.txHash }]);
  let release: string | null = null;
  try {
    const records = parsePoaWithdrawalStatus(bridgeAnswer).filter(
      (r) => r.burnTxHash === payout.txHash,
    );
    release = records.length === 1 ? (records[0]?.transferTxHash ?? null) : null;
  } catch {
    // An answer the parser refuses: the verdict's bridge_record check says why.
  }
  const destinationReceipt =
    release === null ? null : await base.call("eth_getTransactionReceipt", [release]);
  return verifyPoaSettlement({
    near: tx,
    nearTxHash: payout.txHash,
    bridgeAnswer,
    destinationReceipt,
    expect: {
      asset: payout.asset,
      address: payout.address,
      erc20: payout.erc20,
      ...(payout.amount === undefined ? {} : { amount: payout.amount }),
      ...(payout.owner === undefined ? {} : { owner: payout.owner }),
      ...(payout.maxFee === undefined ? {} : { maxFee: payout.maxFee }),
    },
  });
}
