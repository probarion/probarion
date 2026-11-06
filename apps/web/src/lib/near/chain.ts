import { RpcClient, type RpcClientOptions, RpcMalformedError } from "@probarion/sdk";
import type { Network } from "@/lib/config";
import { log } from "@/lib/log";
import { createVaultReader, type VaultReader } from "./reader";

// One deployment serves both networks, each with its own RPC list from the settings (W-NET-R2). A list that points a
// network at the other one's nodes passes the checks on its shape (a URL with no network in its host), and would sign
// people in, and register vaults, against the wrong chain. The paths that create lasting state (sign-in, Register and the
// approvers re-sync) therefore take their chain client from here, and from nowhere else: a client built only from the URLs
// that have been asked which chain they serve and have answered with the network's own (W-NET-R7). The RPC client fails over
// from URL to URL and keeps the one that answered last, so no URL that has not been checked may be in it.

/** One of the network's RPC URLs answers for another chain. Never a transient failure: that is the RPC's own error. */
export class WrongChainError extends Error {
  override name = "WrongChainError";
  constructor(readonly network: Network) {
    super(`the ${network} RPC answers for another chain`);
  }
}

/**
 * What the process knows about the URLs of one network, per URL (the exact string of the list, never logged: a URL can hold
 * an API key). `right`: it answered `status` with the network's own chain. `wrong`: it answered with another chain, which
 * is remembered until the process restarts and is never cleared by a later right answer. A URL in neither set is unknown:
 * it has not answered, or its answer said nothing (an error, a timeout, a steady 429, no `chain_id`).
 */
interface UrlState {
  right: Set<string>;
  wrong: Set<string>;
}
const states = new Map<Network, UrlState>();

/** The client of the production path, kept per network so that its failover keeps its preferred URL between requests. */
const clients = new Map<Network, { key: string; client: RpcClient }>();

/** For tests: forgets everything, as a restart of the process does. */
export function forgetVerifiedChains(): void {
  states.clear();
  clients.clear();
}

/** A network's RPC list as the settings give it: the URLs, and the variable that supplied them (named in the log). */
export interface RpcList {
  rpcUrls: readonly string[];
  rpcUrlsVariable: string;
}

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
 * The chain client for sign-in, Register and the approvers re-sync (W-NET-R7). Every URL of the network's list that is not
 * yet known to be right or wrong is asked `status`, each on its own. Then:
 *
 * - if any URL is wrong (now, or at any earlier check of this process): `WrongChainError`, logged with the network, the
 *   variable that supplied the list and the URL's position in the variable as written (never the URL), and nothing is
 *   minted or registered. A right URL never outvotes a wrong one, and a wrong URL is not asked again;
 * - else, if no URL is right: the RPC client's own error (a URL that cannot be reached) or `RpcMalformedError` (an answer
 *   without a readable `chain_id`), which is `unavailable`, never a pass;
 * - else an `RpcClient` built only from the URLs that are right, in the order of the list. A URL that has not answered
 *   right is not in it, so failover cannot reach it; it is asked again at the next check, and once every URL is right the
 *   client holds the whole list and nobody is asked.
 *
 * The caller uses this client for every chain call it makes, and never `getRpc(network)`.
 *
 * `clientOptions` is for tests (a `fetch`, `sleep` and `maxRounds`); the clients are the SDK's own.
 */
export async function verifiedRpc(
  network: Network,
  list: RpcList,
  clientOptions: Partial<RpcClientOptions> = {},
): Promise<RpcClient> {
  const unique = [...new Set(list.rpcUrls)];
  if (unique.length === 0) throw new Error(`no RPC URL is set for ${network}`);
  let state = states.get(network);
  if (state === undefined) {
    state = { right: new Set(), wrong: new Set() };
    states.set(network, state);
  }
  const { right, wrong } = state;

  const pending = unique.filter((url) => !right.has(url) && !wrong.has(url));
  const results = await Promise.all(pending.map((url) => probe(network, url, clientOptions)));
  let failure: { error: unknown } | null = null;
  for (const [i, r] of results.entries()) {
    const url = pending[i] as string;
    if (r.ok) right.add(url);
    else if (r.wrong) wrong.add(url);
    else failure ??= { error: r.error };
  }

  const wrongUrl = unique.find((url) => wrong.has(url));
  if (wrongUrl !== undefined) {
    log.error("chain.wrong", {
      network,
      variable: list.rpcUrlsVariable,
      entry: list.rpcUrls.indexOf(wrongUrl) + 1,
    });
    throw new WrongChainError(network);
  }
  const verified = unique.filter((url) => right.has(url));
  if (verified.length === 0) {
    // Nothing is right and nothing is wrong: every URL is unknown, and this check asked each of them.
    throw (
      (failure as { error: unknown } | null)?.error ?? new Error(`no ${network} RPC has answered`)
    );
  }

  // Production: the same client while the verified URLs are the same, so its failover remembers the URL that answered last.
  // A test that injects a `fetch` gets a new client each time.
  const injected = Object.keys(clientOptions).length > 0;
  const key = verified.join("\n");
  const cached = clients.get(network);
  if (!injected && cached?.key === key) return cached.client;
  const client = new RpcClient({
    maxRounds: 2,
    timeoutMs: 8_000,
    ...clientOptions,
    urls: verified,
  });
  if (!injected) clients.set(network, { key, client });
  return client;
}

/**
 * `verifiedRpc` and a reader of the vault contracts over that same client: for the callers (Register, the approvers
 * re-sync) that read vaults and the factory as well as accounts. Never `getReader(network)`.
 */
export async function verifiedChain(
  network: Network,
  list: RpcList,
  clientOptions: Partial<RpcClientOptions> = {},
): Promise<{ rpc: RpcClient; reader: VaultReader }> {
  const rpc = await verifiedRpc(network, list, clientOptions);
  return { rpc, reader: createVaultReader(rpc) };
}
