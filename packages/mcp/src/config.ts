import { isAbsolute, join } from "node:path";
import { isNearAccountId, NETWORKS, publicKeyFromSecret } from "@probarion/core";
import { envValue } from "@probarion/sdk";
import {
  defaultKeysPath,
  errorCode,
  type FileKeys,
  type Network,
  parseKeysFile,
  type ReadKeysFile,
} from "./keys-file.js";

/**
 * Where the server's two keys came from: the environment (PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY), a keys
 * file (`file:` and its path), or nowhere, which is read-only mode.
 */
export type KeysSource = "env" | `file:${string}` | "none";

export interface McpConfig {
  network: Network;
  vault: string;
  agentKey: string | null;
  ledgerKey: string | null;
  rpcUrls: string[];
  /** NEAR_ARCHIVAL_RPC_URLS, checked like NEAR_RPC_URLS; null for the SDK's default archival nodes. */
  archivalRpcUrls: string[] | null;
  /** The agent key's public half, or null in read-only mode. */
  agentPublicKey: string | null;
  /** The ledger key's public half, or null in read-only mode. */
  ledgerPublicKey: string | null;
  keysSource: KeysSource;
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
 * The vault id's network, with every problem named by `name` (the variable or flag that gave the id). The vault's
 * own name says its network (.near or .testnet); NEAR_NETWORK is needed only for another name. A vault id that
 * passes is a NEAR account id: lowercase letters and digits, with `-` or `_` inside dot-separated parts, so it has
 * no slash, backslash, `..` or upper case letter and is safe as one folder name under `~/.probarion`.
 */
export function checkVault(
  vault: string,
  nearNetwork: string | undefined,
  name: string,
): { network: Network | null; problems: string[] } {
  const problems: string[] = [];
  const named = vault.endsWith(".testnet") ? "testnet" : vault.endsWith(".near") ? "mainnet" : null;
  const network = nearNetwork ?? named;
  if (network !== "mainnet" && network !== "testnet") {
    problems.push(
      `NEAR_NETWORK must be "mainnet" or "testnet" (it can be left out when ${name} ends in .near or .testnet)`,
    );
  }
  if (!isNearAccountId(vault)) {
    problems.push(`${name} must be a NEAR account id, e.g. acme.vaults.probarion.near`);
  } else if (network === "mainnet" && vault.endsWith(".testnet")) {
    problems.push(`${name} looks like a testnet account but NEAR_NETWORK is mainnet`);
  } else if (network === "testnet" && vault.endsWith(".near")) {
    problems.push(`${name} looks like a mainnet account but NEAR_NETWORK is testnet`);
  }
  return {
    network: network === "mainnet" || network === "testnet" ? network : null,
    problems,
  };
}

/** The text of the keys file at `path`, null when there is none, or a problem when it cannot be read. */
function peek(read: ReadKeysFile, path: string): { text: string | null } | { problem: string } {
  try {
    return { text: read(path) };
  } catch (error) {
    return {
      problem: `the keys file ${path} could not be read (${errorCode(error) ?? "unknown error"})`,
    };
  }
}

/**
 * The server's settings from its environment (an MCP client passes them in its config file). Every problem is
 * named at once, by variable name or by file and field: a value is never printed, since two of them are secret
 * keys. The keys come from, in this order: PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY (both, or neither);
 * the keys file PROBARION_KEYS_FILE names, which must exist; `~/.probarion/<vault>/keys.json` when it exists;
 * otherwise none, and the server is read-only. One key from the environment and the other from a file is
 * refused. Pure: every file it looks at is read through `readKeysFile`.
 */
export function loadConfig(env: Env, home: string, readKeysFile: ReadKeysFile): McpConfig {
  const vault = envValue(env, "PROBARION_VAULT_ID") ?? "";
  const checked = checkVault(vault, envValue(env, "NEAR_NETWORK"), "PROBARION_VAULT_ID");
  const problems = [...checked.problems];
  const network = checked.network;
  // Only a checked vault id goes into a path.
  const defaultPath =
    checked.problems.length === 0 && network !== null ? defaultKeysPath(home, vault) : null;

  const envAgent = envValue(env, "PROBARION_AGENT_KEY") ?? null;
  const envLedger = envValue(env, "PROBARION_LEDGER_KEY") ?? null;
  const keysFileVar = envValue(env, "PROBARION_KEYS_FILE") ?? null;

  let keys: FileKeys | null = null;
  let keysSource: KeysSource = "none";

  /** Takes the keys of the file at `path`, checked against this vault, or names its problems. */
  const fromFile = (path: string, text: string): void => {
    if (defaultPath === null || network === null) return; // the vault's own problem is named already
    const parsed = parseKeysFile(text, path, { vault, network });
    if (parsed.ok) {
      keys = parsed.keys;
      keysSource = `file:${path}`;
    } else {
      problems.push(...parsed.problems);
    }
  };

  if (envAgent !== null || envLedger !== null) {
    const agentPublicKey = publicHalf(
      envAgent,
      "PROBARION_AGENT_KEY",
      "the vault's function-call key that can only call spend",
      problems,
    );
    const ledgerPublicKey = publicHalf(
      envLedger,
      "PROBARION_LEDGER_KEY",
      "the vault's function-call key that can only call anchor",
      problems,
    );
    if (envAgent === null || envLedger === null) {
      // With a keys file in play, this is one key from the environment and the other from the file.
      let file: string | null = null;
      if (keysFileVar !== null) file = "the keys file PROBARION_KEYS_FILE names";
      else if (defaultPath !== null) {
        const found = peek(readKeysFile, defaultPath);
        if (!("text" in found) || found.text !== null) file = `the keys file ${defaultPath}`;
      }
      problems.push(
        file === null
          ? "set both PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY, or neither for read-only mode"
          : `set both PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY, or neither to take both keys from ${file}: one key from the environment and the other from a file is refused`,
      );
    } else if (agentPublicKey !== null && agentPublicKey === ledgerPublicKey) {
      problems.push(
        "PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY are the same key; the vault takes a key as one of the two, not both",
      );
    } else if (agentPublicKey !== null && ledgerPublicKey !== null) {
      // Both keys in the environment win over any keys file.
      keys = { agentKey: envAgent, ledgerKey: envLedger, agentPublicKey, ledgerPublicKey };
      keysSource = "env";
    }
  } else if (keysFileVar !== null) {
    if (!isAbsolute(keysFileVar)) {
      problems.push(
        "PROBARION_KEYS_FILE must be an absolute path: an MCP client starts the server in a folder of its own choosing",
      );
    } else {
      const found = peek(readKeysFile, keysFileVar);
      if ("problem" in found) problems.push(found.problem);
      else if (found.text === null) {
        problems.push(
          `PROBARION_KEYS_FILE names ${keysFileVar}, which does not exist: make it with probarion-mcp init --vault <id> --keys-file <path>`,
        );
      } else fromFile(keysFileVar, found.text);
    }
  } else if (defaultPath !== null) {
    const found = peek(readKeysFile, defaultPath);
    if ("problem" in found) problems.push(found.problem);
    else if (found.text !== null) fromFile(defaultPath, found.text);
  }

  const rpcUrls = urlList(env, "NEAR_RPC_URLS", problems);
  const archivalRpcUrls = urlList(env, "NEAR_ARCHIVAL_RPC_URLS", problems);
  if (problems.length > 0 || network === null) {
    throw new ConfigError(`invalid configuration:\n- ${problems.join("\n- ")}`);
  }
  // TypeScript does not follow the assignments inside fromFile.
  const taken = keys as FileKeys | null;
  return {
    network,
    vault,
    agentKey: taken?.agentKey ?? null,
    ledgerKey: taken?.ledgerKey ?? null,
    rpcUrls: rpcUrls.length > 0 ? rpcUrls : [...NETWORKS[network].rpcUrls],
    archivalRpcUrls: archivalRpcUrls.length > 0 ? archivalRpcUrls : null,
    agentPublicKey: taken?.agentPublicKey ?? null,
    ledgerPublicKey: taken?.ledgerPublicKey ?? null,
    keysSource,
    ledgerPath:
      envValue(env, "PROBARION_LEDGER_PATH") ?? join(home, ".probarion", vault, "ledger.jsonl"),
    readOnly: taken === null,
  };
}
