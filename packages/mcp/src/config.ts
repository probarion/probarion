import { join } from "node:path";
import { isNearAccountId, NETWORKS } from "@probarion/core";
import { envValue } from "@probarion/sdk";

export interface McpConfig {
  network: "mainnet" | "testnet";
  vault: string;
  agentKey: string | null;
  ledgerKey: string | null;
  rpcUrls: string[];
  ledgerPath: string;
  readOnly: boolean;
}

export class ConfigError extends Error {}

type Env = Readonly<Record<string, string | undefined>>;

/** A node on this machine (a sandbox, a test double) may speak plain http. */
const LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;

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
  if (agentKey !== null && !agentKey.startsWith("ed25519:")) {
    problems.push(
      'PROBARION_AGENT_KEY must start with "ed25519:" (the vault\'s function-call key that can only call spend)',
    );
  }
  if (ledgerKey !== null && !ledgerKey.startsWith("ed25519:")) {
    problems.push(
      'PROBARION_LEDGER_KEY must start with "ed25519:" (the vault\'s function-call key that can only call anchor)',
    );
  }
  if ((agentKey === null) !== (ledgerKey === null)) {
    problems.push(
      "set both PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY, or neither for read-only mode",
    );
  }
  const rpcUrls = (envValue(env, "NEAR_RPC_URLS") ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  if (rpcUrls.some((url) => !url.startsWith("https://") && !LOCAL_HTTP.test(url))) {
    problems.push(
      "NEAR_RPC_URLS must be a comma-separated list of https:// URLs (http:// only for a node on this machine)",
    );
  }
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
    ledgerPath:
      envValue(env, "PROBARION_LEDGER_PATH") ?? join(home, ".probarion", vault, "ledger.jsonl"),
    readOnly: agentKey === null,
  };
}
