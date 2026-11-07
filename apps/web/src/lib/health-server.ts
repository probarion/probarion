import "server-only";
import { NEARAI_BASE_URL } from "@probarion/core";
import type { Network } from "@/lib/config";
import { type Env, getEnv } from "@/lib/env";
import {
  cachedProbe,
  MAX_PROVIDERS,
  NEARAI_PROBE_NAME,
  type Probe,
  probeNearAi,
  probeNearRpc,
  providerName,
} from "@/lib/health";
import { originFor, otherNetwork } from "@/lib/network";

// The health of the request's network, for the three routes and /status. The RPC list is the one every reader of that
// network uses (getEnv().networks[network]); a probe never names a configured URL, and never writes the chain check's
// per-process right and wrong sets (lib/near/chain.ts), which belong to sign-in, Register and the approvers re-sync.

export type RpcHealth =
  | { kind: "probe"; probe: Probe; provider: number; providers: number }
  | { kind: "unknown_provider"; providers: number }
  | { kind: "settings" };

export interface HealthReport {
  network: Network;
  /** False when the settings cannot be read: the console is down, and the RPC probes did not run. */
  settings: boolean;
  rpc: readonly { provider: number; probe: Probe }[];
  nearai: { probe: Probe; configured: boolean };
  /** The other network, and where it is served (null: not served). */
  other: { network: Network; origin: string | null };
  checkedAt: string;
}

function settings(): Env | null {
  try {
    return getEnv();
  } catch {
    return null;
  }
}

/** Provider `provider` (0-based) of `network`'s RPC list. */
export async function rpcHealth(network: Network, provider: number): Promise<RpcHealth> {
  const env = settings();
  if (env === null) return { kind: "settings" };
  const { rpcUrls, rpcUrlsVariable } = env.networks[network];
  const providers = Math.min(rpcUrls.length, MAX_PROVIDERS);
  if (!Number.isInteger(provider) || provider < 0 || provider >= providers) {
    return { kind: "unknown_provider", providers };
  }
  const url = rpcUrls[provider] ?? "";
  const name = providerName(network, url, provider, rpcUrlsVariable);
  const probe = await cachedProbe(`rpc:${network}:${provider}`, name, () =>
    probeNearRpc(network, url, name),
  );
  return { kind: "probe", probe, provider, providers };
}

/** NEAR AI Cloud serves the whole project, so one cache entry serves every address. */
export async function nearAiHealth(): Promise<{ probe: Probe; configured: boolean }> {
  const probe = await cachedProbe("nearai", NEARAI_PROBE_NAME, () => probeNearAi(NEARAI_BASE_URL));
  const env = settings();
  return { probe, configured: env !== null && env.NEARAI_API_KEY !== null };
}

/** Everything /status shows. It never throws. */
export async function healthReport(network: Network): Promise<HealthReport> {
  const env = settings();
  const count = env === null ? 0 : Math.min(env.networks[network].rpcUrls.length, MAX_PROVIDERS);
  const [rows, nearai] = await Promise.all([
    Promise.all(Array.from({ length: count }, (_, provider) => rpcHealth(network, provider))),
    nearAiHealth(),
  ]);
  const rpc = rows.flatMap((row) =>
    row.kind === "probe" ? [{ provider: row.provider, probe: row.probe }] : [],
  );
  const other = otherNetwork(network);
  return {
    network,
    settings: env !== null,
    rpc,
    nearai,
    other: { network: other, origin: env === null ? null : originFor(other, env) },
    checkedAt: new Date().toISOString(),
  };
}
