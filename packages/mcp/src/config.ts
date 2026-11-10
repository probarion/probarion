import { join } from "node:path";
import { isNearAccountId, NETWORKS, publicKeyFromSecret } from "@probarion/core";
import { envValue } from "@probarion/sdk";

export interface McpConfig {
  network: "mainnet" | "testnet";
  vault: string;
  agentKey: string | null;
  ledgerKey: string | null;
  rpcUrls: string[];
  /** NEAR_ARCHIVAL_RPC_URLS, checked like NEAR_RPC_URLS; null for the SDK's default archival nodes. */
  archivalRpcUrls: string[] | null;
  /** The agent key's public half, or null in read-only mode. */
  agentPublicKey: string | null;
  ledgerPath: string;
  readOnly: boolean;
}

export class ConfigError extends Error {}

type Env = Readonly<Record<string, string | undefined>>;

/** A node on this machine (a sandbox, a test double) may speak plain http. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A comma-separated URL list: https only (http only on this machine), and no user name or password in a URL. */
function urlList(env: Env, name: string, problems: string[]): string[] {
  const urls = (envValue(env, name) ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  const bad = urls.some((url) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return true;
    }
    if (u.username !== "" || u.password !== "") return true;
    return !(u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname)));
  });
  if (bad) {
    problems.push(
      `${name} must be a comma-separated list of https:// URLs (http:// only for a node on this machine), with no user name or password in a URL`,
    );
  }
  return urls;
}

/** The key's public half, or a problem named by its variable when it is not an ed25519 secret key. */
function publicHalf(
  key: string | null,
  name: string,
  role: string,
  problems: string[],
): string | null {
  if (key === null) return null;
  if (!key.startsWith("ed25519:")) {
    problems.push(`${name} must start with "ed25519:" (${role})`);
    return null;
  }
  try {
    return publicKeyFromSecret(key);
  } catch {
    problems.push(`${name} is not a valid ed25519 secret key (${role})`);
    return null;
  }
}

/**
 * The server's settings from its environment (an MCP client passes them in its config file). Every problem is
 * named at once, by variable name: a value is never printed, since two of them are secret keys.
 */
export function loadConfig(env: Env, home: string): McpConfig {
  const problems: string[] = [];
  const vault = envValue(env, "PROBARION_VAULT_ID") ?? "";
  // The vault's own name says its network (.near or .testnet); NEAR_NETWORK is needed only for another name.
  const named = vault.endsWith(".testnet") ? "testnet" : vault.endsWith(".near") ? "mainnet" : null;
  const network = envValue(env, "NEAR_NETWORK") ?? named;
  if (network !== "mainnet" && network !== "testnet") {
    problems.push(
      'NEAR_NETWORK must be "mainnet" or "testnet" (it can be left out when PROBARION_VAULT_ID ends in .near or .testnet)',
    );
  }
  if (!isNearAccountId(vault)) {
    problems.push("PROBARION_VAULT_ID must be a NEAR account id, e.g. acme.vaults.probarion.near");
  } else if (network === "mainnet" && vault.endsWith(".testnet")) {
    problems.push("PROBARION_VAULT_ID looks like a testnet account but NEAR_NETWORK is mainnet");
  } else if (network === "testnet" && vault.endsWith(".near")) {
    problems.push("PROBARION_VAULT_ID looks like a mainnet account but NEAR_NETWORK is testnet");
  }
  const agentKey = envValue(env, "PROBARION_AGENT_KEY") ?? null;
  const ledgerKey = envValue(env, "PROBARION_LEDGER_KEY") ?? null;
  const agentPublicKey = publicHalf(
    agentKey,
    "PROBARION_AGENT_KEY",
    "the vault's function-call key that can only call spend",
    problems,
  );
  publicHalf(
    ledgerKey,
    "PROBARION_LEDGER_KEY",
    "the vault's function-call key that can only call anchor",
    problems,
  );
  if ((agentKey === null) !== (ledgerKey === null)) {
    problems.push(
      "set both PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY, or neither for read-only mode",
    );
  }
  const rpcUrls = urlList(env, "NEAR_RPC_URLS", problems);
  const archivalRpcUrls = urlList(env, "NEAR_ARCHIVAL_RPC_URLS", problems);
  if (problems.length > 0) {
    throw new ConfigError(`invalid configuration:\n- ${problems.join("\n- ")}`);
  }
  const net = network as "mainnet" | "testnet";
  return {
    network: net,
    vault,
    agentKey,
    ledgerKey,
    rpcUrls: rpcUrls.length > 0 ? rpcUrls : [...NETWORKS[net].rpcUrls],
    archivalRpcUrls: archivalRpcUrls.length > 0 ? archivalRpcUrls : null,
    agentPublicKey,
    ledgerPath:
      envValue(env, "PROBARION_LEDGER_PATH") ?? join(home, ".probarion", vault, "ledger.jsonl"),
    readOnly: agentKey === null,
  };
}
