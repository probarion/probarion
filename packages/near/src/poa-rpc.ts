// N4, Experimental: reads the POA bridge's record of a withdrawal. The bridge speaks JSON-RPC 2.0, so any NearRpc
// pointed at it works (httpJsonRpc(POA_BRIDGE_RPC_URL) included). The method and its params were confirmed by a
// call that read public data on 2026-11-14; status values other than COMPLETED are not documented in what we read.
import { isBase58Hash } from "./encoding.js";
import { NearFormatError } from "./errors.js";
import { type PoaBridgeWithdrawal, parsePoaWithdrawalStatus } from "./poa.js";
import type { NearRpc } from "./rpc.js";

/** The POA bridge's public JSON-RPC endpoint (NEAR Intents' Base and Solana withdrawals). */
export const POA_BRIDGE_RPC_URL = "https://bridge.chaindefuser.com/rpc";

/**
 * `withdrawal_status` with params `[{ withdrawal_hash: burnTxHash }]` on a client pointed at the bridge: the bridge's
 * records of the withdrawals in that NEAR transaction, parsed by parsePoaWithdrawalStatus. A record that names
 * another burn transaction is refused (NearFormatError): the answer is about something else. The records are a
 * pointer to the release (`transferTxHash`), not proof of it: verifyPoaSettlement checks them against the burn and
 * the destination receipt. Throws TypeError for a hash that is not a NEAR transaction hash, the client's error
 * (NearRpcError for httpJsonRpc) when the call fails, and NearFormatError for an answer it cannot read. Sends
 * nothing else and signs nothing.
 */
export async function readPoaWithdrawalStatus(
  bridge: NearRpc,
  burnTxHash: string,
): Promise<PoaBridgeWithdrawal[]> {
  if (!isBase58Hash(burnTxHash)) {
    throw new TypeError(
      "readPoaWithdrawalStatus: burnTxHash must be a base58 NEAR transaction hash",
    );
  }
  const answer = await bridge.call("withdrawal_status", [{ withdrawal_hash: burnTxHash }]);
  const withdrawals = parsePoaWithdrawalStatus(answer);
  for (const [i, withdrawal] of withdrawals.entries()) {
    if (withdrawal.burnTxHash !== burnTxHash) {
      throw new NearFormatError(
        `withdrawals[${i}].data.tx_hash`,
        `withdrawal_status: the bridge answered for ${withdrawal.burnTxHash}, not ${burnTxHash}`,
      );
    }
  }
  return withdrawals;
}
