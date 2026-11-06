import { type RpcClient, RpcMalformedError } from "@probarion/sdk";
import type { Network } from "@/lib/config";
import { log } from "@/lib/log";

// One deployment serves both networks, each with its own RPC list from the settings (W-NET-R2). A list that points a
// network at the other one's nodes passes the checks on its shape (a URL with no network in its host), and would sign
// people in, and register vaults, against the wrong chain. The two paths that create lasting state, sign-in and Register,
// therefore ask the node which chain it serves before they act.

/** The network's RPC answers for another chain. Never a transient failure: that is the RPC's own error. */
export class WrongChainError extends Error {
  override name = "WrongChainError";
  constructor(readonly network: Network) {
    super(`the ${network} RPC answers for another chain`);
  }
}

/** The networks whose RPC has been seen to answer for its own chain, for the life of this process. */
const verified = new Set<Network>();

/** For tests: forgets what has been verified, so the next check asks the node again. */
export function forgetVerifiedChains(): void {
  verified.clear();
}

/**
 * Checks, once per network for the life of the process, that `rpc` answers JSON-RPC `status` with `chain_id` equal to
 * `network` (the nodes say "mainnet" and "testnet"). A pass is remembered. A mismatch throws `WrongChainError` and is
 * logged with the network alone (never the URL, which can hold an API key); it is not remembered, so a corrected setting
 * is picked up by the next request. A node that cannot be reached throws the RPC client's own error, and an answer
 * without a readable `chain_id` throws `RpcMalformedError`: both are failures to check, not passes, and not remembered.
 */
export async function ensureChain(network: Network, rpc: Pick<RpcClient, "call">): Promise<void> {
  if (verified.has(network)) return;
  const answer = await rpc.call<unknown>("status", []);
  const chainId =
    typeof answer === "object" && answer !== null
      ? (answer as { chain_id?: unknown }).chain_id
      : undefined;
  if (typeof chainId !== "string" || chainId === "") {
    throw new RpcMalformedError("status: the answer has no chain_id");
  }
  if (chainId !== network) {
    log.error("chain.wrong", { network });
    throw new WrongChainError(network);
  }
  verified.add(network);
}
