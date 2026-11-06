import { RpcClient, type RpcClientOptions, RpcMalformedError } from "@probarion/sdk";
import type { Network } from "@/lib/config";
import { log } from "@/lib/log";

// One deployment serves both networks, each with its own RPC list from the settings (W-NET-R2). A list that points a
// network at the other one's nodes passes the checks on its shape (a URL with no network in its host), and would sign
// people in, and register vaults, against the wrong chain. The two paths that create lasting state, sign-in and Register,
// therefore ask the nodes which chain they serve before they act. The RPC client fails over from URL to URL and keeps the
// one that answered last, so a list is only as good as its worst URL: every URL is asked, each on its own (W-NET-R5).

/** One of the network's RPC URLs answers for another chain. Never a transient failure: that is the RPC's own error. */
export class WrongChainError extends Error {
  override name = "WrongChainError";
  constructor(readonly network: Network) {
    super(`the ${network} RPC answers for another chain`);
  }
}

/**
 * The URLs of each network that have answered `status` with the network's own chain, for the life of this process. Kept
 * in memory only and never logged: a URL can hold an API key.
 */
const answeredRight = new Map<Network, Set<string>>();

/** For tests: forgets what has been verified, so the next check asks every URL again. */
export function forgetVerifiedChains(): void {
  answeredRight.clear();
}

/** The settings variable a network's RPC list comes from, for the log (the suffixed form the runbook tells the OWNER to set). */
const RPC_VARIABLE: Record<Network, string> = {
  mainnet: "NEAR_RPC_URLS_MAINNET",
  testnet: "NEAR_RPC_URLS_TESTNET",
};

/** One URL's outcome. */
type Probe =
  | { ok: true }
  | { ok: false; wrong: true }
  | { ok: false; wrong: false; error: unknown };

/**
 * Asks one URL, on its own (a client with that URL alone, so no failover can answer for another URL), which chain it
 * serves: JSON-RPC `status`, whose `chain_id` is "mainnet" or "testnet".
 */
async function probe(
  network: Network,
  url: string,
  clientOptions: Partial<RpcClientOptions>,
): Promise<Probe> {
  try {
    const client = new RpcClient({ maxRounds: 2, timeoutMs: 5_000, ...clientOptions, urls: [url] });
    const answer = await client.call<unknown>("status", []);
    const chainId =
      typeof answer === "object" && answer !== null
        ? (answer as { chain_id?: unknown }).chain_id
        : undefined;
    if (typeof chainId !== "string" || chainId === "") {
      throw new RpcMalformedError("status: the answer has no chain_id");
    }
    return chainId === network ? { ok: true } : { ok: false, wrong: true };
  } catch (error) {
    return { ok: false, wrong: false, error };
  }
}

/**
 * Checks that every URL of the network's RPC list answers JSON-RPC `status` with `chain_id` equal to `network`. The
 * first check for a network asks all of them, each on its own; a URL that has answered correctly once is not asked again
 * for the life of the process, so the network is remembered as passed when every URL has answered correctly, and until
 * then each check asks only the URLs that have not.
 *
 * Any URL that answers for another chain fails the check with `WrongChainError` (logged with the network, the variable
 * and the URL's position, never the URL, which can hold an API key); that wins over a URL that did not answer. A URL
 * that cannot be reached fails it with the RPC client's own error, and an answer without a readable `chain_id` with
 * `RpcMalformedError`: both are failures to check, never a pass. Nothing about a failure is remembered, so a corrected
 * setting or a node that comes back is picked up by the next request.
 *
 * `clientOptions` is for tests (a `fetch`, `sleep` and `maxRounds`); the client is the SDK's own, one URL at a time.
 */
export async function ensureChain(
  network: Network,
  urls: readonly string[],
  clientOptions: Partial<RpcClientOptions> = {},
): Promise<void> {
  const unique = [...new Set(urls)];
  if (unique.length === 0) throw new Error(`no RPC URL is set for ${network}`);
  const right = answeredRight.get(network) ?? new Set<string>();
  const pending = unique.filter((url) => !right.has(url));
  if (pending.length === 0) return;

  const results = await Promise.all(pending.map((url) => probe(network, url, clientOptions)));
  let wrongAt: number | null = null;
  let failure: { error: unknown } | null = null;
  for (const [i, r] of results.entries()) {
    const url = pending[i] as string;
    if (r.ok) right.add(url);
    else if (r.wrong) wrongAt ??= unique.indexOf(url) + 1;
    else failure ??= { error: r.error };
  }
  answeredRight.set(network, right);

  if (wrongAt !== null) {
    log.error("chain.wrong", { network, variable: RPC_VARIABLE[network], entry: wrongAt });
    throw new WrongChainError(network);
  }
  if (failure !== null) throw failure.error;
}
