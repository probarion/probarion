import "server-only";
import { headers } from "next/headers";
import type { Network } from "@/lib/config";
import { type Env, getEnv } from "@/lib/env";
import {
  type NetworkRouting,
  networkForHost,
  otherNetworkOf,
  publicRouting,
} from "@/lib/site/network";

// One deployment serves both networks (W-NET-R2). The network of a request comes from the address it was opened at,
// and from nothing else: never a query parameter, a cookie or a body. Everything that answers a request resolves it
// once here and passes it down; nothing below reads a network the caller did not name.

export { otherNetworkOf as otherNetwork };

/** The routing the settings describe: the default network, and the origin of each network this site serves. */
export function routingOf(env: Pick<Env, "defaultNetwork" | "networks">): NetworkRouting {
  const origin = (n: Network): string | null =>
    env.networks[n].enabled ? env.networks[n].origin : null;
  return {
    defaultNetwork: env.defaultNetwork,
    origins: { mainnet: origin("mainnet"), testnet: origin("testnet") },
  };
}

/**
 * The network of a request, from its `Host` header. A host equal to an enabled network's origin is that network;
 * anything else (a preview, a deployment URL, localhost, no host) is the default network. Pure, so tests can cover it.
 */
export function networkForRequestHost(
  host: string | null | undefined,
  env: Pick<Env, "defaultNetwork" | "networks">,
): Network {
  return networkForHost(host, routingOf(env));
}

/** The network of the request being answered. Only for code that runs inside a request. */
export async function requestNetwork(): Promise<Network> {
  return networkForRequestHost((await headers()).get("host"), getEnv());
}

/**
 * The same, for a page that must still render when the settings cannot be read (the Canary, usage, the rules, the error
 * state of a proof page): if the settings fail, the host is read against the public map built into the page at build time
 * (the same rule, the same origins). It reads no secret and decides nothing about access.
 */
export async function softRequestNetwork(): Promise<Network> {
  const host = (await headers()).get("host");
  try {
    return networkForRequestHost(host, getEnv());
  } catch {
    return networkForHost(host, publicRouting());
  }
}

/** Where a network is served (`https://host`), or null when this site does not serve it. */
export function originFor(network: Network, env: Pick<Env, "networks"> = getEnv()): string | null {
  return env.networks[network].origin;
}
