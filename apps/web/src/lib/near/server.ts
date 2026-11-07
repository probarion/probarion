import "server-only";
import { NETWORKS } from "@probarion/core";
import { RpcClient } from "@probarion/sdk";
import type { Network } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { createVaultReader, type VaultReader } from "./reader";

// One client and one reader per network (W-NET-R2). A call names the network it is about: a request's own, or a
// vault's `tenants.network`. A network's client is built from that network's RPC list only, so testnet providers never
// answer a mainnet question.
const rpcs: Partial<Record<Network, RpcClient>> = {};
const readers: Partial<Record<Network, VaultReader>> = {};

/**
 * The network's SDK RpcClient (failover, backoff on 429, URL redaction). One shared instance per network, so it
 * remembers which provider answered last. Built lazily so `next build` needs no RPC settings.
 *
 * Two rounds over the providers and an 8 s timeout per try (the SDK defaults are 3 rounds and 15 s):
 * a console page is waiting on these reads, so it gives up sooner and shows the error.
 */
export function getRpc(network: Network): RpcClient {
  let rpc = rpcs[network];
  if (rpc === undefined) {
    rpc = new RpcClient({
      // loadEnv already applies the network's default when the variable is unset.
      urls: getEnv().networks[network].rpcUrls,
      maxRounds: 2,
      timeoutMs: 8_000,
    });
    rpcs[network] = rpc;
  }
  return rpc;
}

export function getReader(network: Network): VaultReader {
  let reader = readers[network];
  if (reader === undefined) {
    reader = createVaultReader(getRpc(network));
    readers[network] = reader;
  }
  return reader;
}

/** The network's fixed addresses (USDC, Intents, POA assets, factory, explorer). */
export function chainConsts(network: Network) {
  return NETWORKS[network];
}
