// Example: how much did a merchant receive in one transaction? The answer comes from the token contract's own
// NEP-141 events in receipts that succeeded: a line that another contract logs, or one left by a receipt that
// failed, does not count, and an ft_transfer_call refund nets out. The default transaction is Probarion's testnet
// spend 1, where the vault v0.probarion.testnet paid 1 test USDC (usdc.probarion.testnet, 6 decimals) to
// probarion-payee.testnet.
//
//   pnpm --filter @probarion/near exec tsx examples/read-events.ts [txHash sender token merchant [rpcUrl]]
//
// This reads one RPC node's `tx` answer and trusts it; prove-receipt.ts shows how to check the receipts against a
// head instead. An app imports the same names from "@probarion/near"; the example imports the source so it runs in
// the repo.
import { pathToFileURL } from "node:url";
import { ftDeltas } from "../src/events.js";
import { httpJsonRpc, type NearRpc } from "../src/rpc.js";
import type { TxTreeLike } from "../src/types.js";

export const TESTNET_SPEND_1 = {
  txHash: "3DFV2thBU9V4b5w7kM691poLJ8SWiCqp46LKBn1Fy9cX",
  sender: "v0.probarion.testnet",
  ft: "usdc.probarion.testnet",
  merchant: "probarion-payee.testnet",
} as const;

/**
 * The merchant's net change in `token` (in the token's smallest unit) over every receipt of the transaction, 0n
 * when no counted event names it. Refuses (throws) when any event of the token could not be read, or when the
 * answer lacks a receipt that one of its outcomes created (a hidden refund, say), since the sum would then be
 * partial.
 */
export async function paidAmount(
  rpc: NearRpc,
  txHash: string,
  sender: string,
  token: string,
  merchant: string,
): Promise<bigint> {
  const tx = await rpc.call<TxTreeLike>("tx", {
    tx_hash: txHash,
    sender_account_id: sender,
    wait_until: "FINAL",
  });
  const { deltas, problems } = ftDeltas(tx, token);
  if (problems.length > 0) {
    throw new Error(
      `the events of ${token} in ${txHash} cannot all be read: ${problems.map((p) => p.problem).join("; ")}`,
    );
  }
  return deltas.get(merchant) ?? 0n;
}

// Run directly (not imported by a test): one `tx` view call on an archival node; nothing is signed.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [txHash, sender, token, merchant, url] = process.argv.slice(2);
  const target =
    txHash !== undefined && sender !== undefined && token !== undefined && merchant !== undefined
      ? { txHash, sender, ft: token, merchant }
      : TESTNET_SPEND_1;
  const amount = await paidAmount(
    httpJsonRpc(url ?? "https://archival-rpc.testnet.fastnear.com"),
    target.txHash,
    target.sender,
    target.ft,
    target.merchant,
  );
  process.stdout.write(
    `${target.merchant} received ${amount} (smallest unit of ${target.ft}) in ${target.txHash}\n`,
  );
}
