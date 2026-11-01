import "server-only";
import { NETWORKS } from "@probarion/core";
import { RpcClient, resolveRpcUrls } from "@probarion/sdk";
import { getEnv } from "@/lib/env";
import { createVaultReader, type VaultReader } from "./reader";

let rpc: RpcClient | null = null;
let reader: VaultReader | null = null;

/**
 * The process-wide SDK RpcClient (failover, backoff on 429, URL redaction). One shared instance, so
 * it remembers which provider answered last. Built lazily so `next build` needs no RPC settings.
 *
 * Two rounds over the providers and an 8 s timeout per try (the SDK defaults are 3 rounds and 15 s):
 * a console page is waiting on these reads, so it gives up sooner and shows the error.
 */
export function getRpc(): RpcClient {
  if (rpc === null) {
    const env = getEnv();
    rpc = new RpcClient({
      urls: resolveRpcUrls(env.NEAR_NETWORK, env.NEAR_RPC_URLS),
      maxRounds: 2,
      timeoutMs: 8_000,
    });
  }
  return rpc;
}

export function getReader(): VaultReader {
  reader ??= createVaultReader(getRpc());
  return reader;
}

/** The network's fixed addresses (USDC, Intents, POA assets, factory, explorer) for `NEAR_NETWORK`. */
export function chainConsts() {
  return NETWORKS[getEnv().NEAR_NETWORK];
}
