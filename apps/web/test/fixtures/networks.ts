import { NETWORKS } from "@probarion/core";
import type { Network } from "@/lib/config";
import type { Env, NetworkSettings } from "@/lib/env";

// The network part of `Env`, built by hand with no import of `@/lib/env` at run time, so a test that replaces that module
// (`vi.mock("@/lib/env", ...)`) can still build it. `test/fixtures/env.ts` is the same through the real `loadEnv`.

export const MAINNET_ORIGIN = "https://mainnet.probarion.test";
export const TESTNET_ORIGIN = "https://testnet.probarion.test";
export const MAINNET_HOST = "mainnet.probarion.test";
export const TESTNET_HOST = "testnet.probarion.test";

type NetworkPart = Pick<Env, "defaultNetwork" | "enabledNetworks" | "networks">;

export function settingsFor(
  network: Network,
  over: Partial<NetworkSettings> = {},
): NetworkSettings {
  return {
    enabled: true,
    origin: network === "mainnet" ? MAINNET_ORIGIN : TESTNET_ORIGIN,
    rpcUrls: [...NETWORKS[network].rpcUrls],
    rpcUrlsVariable: network === "mainnet" ? "NEAR_RPC_URLS_MAINNET" : "NEAR_RPC_URLS_TESTNET",
    archivalRpcUrls: [],
    factoryId: NETWORKS[network].factory,
    demoVaultId: null,
    canaryVaultId: null,
    teamVaultIds: [],
    ...over,
  };
}

/**
 * The network part of an Env. By default the default network is `defaultNetwork` and only it is served (at its own
 * origin); `both` serves the other one too. `mainnet` and `testnet` replace settings of one network.
 */
export function networkPart(
  o: {
    defaultNetwork?: Network;
    both?: boolean;
    mainnet?: Partial<NetworkSettings>;
    testnet?: Partial<NetworkSettings>;
  } = {},
): NetworkPart {
  const defaultNetwork = o.defaultNetwork ?? "testnet";
  const serves = (n: Network) => o.both === true || n === defaultNetwork;
  const networks: Record<Network, NetworkSettings> = {
    mainnet: settingsFor("mainnet", {
      enabled: serves("mainnet"),
      origin: serves("mainnet") ? MAINNET_ORIGIN : null,
      ...o.mainnet,
    }),
    testnet: settingsFor("testnet", {
      enabled: serves("testnet"),
      origin: serves("testnet") ? TESTNET_ORIGIN : null,
      ...o.testnet,
    }),
  };
  return {
    defaultNetwork,
    enabledNetworks: (["mainnet", "testnet"] as const).filter((n) => networks[n].enabled),
    networks,
  };
}
