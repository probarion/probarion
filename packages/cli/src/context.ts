import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isHex32, NETWORKS, type NetworkId, sha256Hex } from "@probarion/core";
import { envValue, RpcClient, resolveRpcUrls } from "@probarion/sdk";
import { CliError } from "./errors.js";
import { NEAR_ACCOUNT_RE } from "./payee.js";

export type GlobalOpts = { network?: string; rpc?: string };
type Env = Readonly<Record<string, string | undefined>>;

/** `--network`, else NEAR_NETWORK, else testnet. An empty NEAR_NETWORK counts as unset (R12). */
export function resolveNetwork(opts: GlobalOpts, env: Env): NetworkId {
  const network = opts.network ?? envValue(env, "NEAR_NETWORK") ?? "testnet";
  if (network !== "mainnet" && network !== "testnet") {
    throw new CliError(`--network (or NEAR_NETWORK) must be mainnet or testnet, got ${network}`);
  }
  return network;
}

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function rpcUrlsFor(opts: GlobalOpts, env: Env, network: NetworkId): string[] {
  if (opts.rpc !== undefined) {
    const urls = splitList(opts.rpc);
    if (urls.length === 0) throw new CliError("--rpc needs at least one URL");
    return urls;
  }
  return resolveRpcUrls(network, undefined, env);
}

export function makeRpc(opts: GlobalOpts, env: Env, network: NetworkId): RpcClient {
  return new RpcClient({ urls: rpcUrlsFor(opts, env, network) });
}

export function requireVault(vault: string | undefined, env: Env): string {
  const id = vault ?? envValue(env, "PROBARION_VAULT_ID");
  if (id === undefined || id === "") {
    throw new CliError("--vault (or PROBARION_VAULT_ID) is required");
  }
  if (!NEAR_ACCOUNT_RE.test(id)) throw new CliError(`--vault ${id} is not a valid NEAR account id`);
  return id;
}

/** PROBARION_FACTORY_ID, else the network's factory. An empty PROBARION_FACTORY_ID counts as unset (R12). */
export function factoryIdFor(network: NetworkId, env: Env): string {
  const id = envValue(env, "PROBARION_FACTORY_ID") ?? NETWORKS[network].factory;
  if (!NEAR_ACCOUNT_RE.test(id)) {
    throw new CliError(`PROBARION_FACTORY_ID ${id} is not a valid NEAR account id`);
  }
  return id;
}

/**
 * An account the owner or approver signs as. It is printed into a shell command, so anything that
 * is not an account id is refused, not quoted.
 */
export function optionalAccount(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!NEAR_ACCOUNT_RE.test(value))
    throw new CliError(`${flag} ${value} is not a valid NEAR account id`);
  return value;
}

/** A 64-hex purpose hash as given, or the sha256 of a PO/contract file. */
export async function readPurpose(value: string, cwd: string): Promise<string> {
  const trimmed = value.trim();
  if (isHex32(trimmed)) return trimmed;
  try {
    return sha256Hex(new Uint8Array(await readFile(resolve(cwd, trimmed))));
  } catch {
    throw new CliError(
      `--purpose ${value} is neither 64 lowercase hex characters nor a readable file`,
    );
  }
}
