import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isHex32, NETWORKS, type NetworkId, sha256Hex } from "@probarion/core";
import {
  DEFAULT_LEDGER_PATH,
  envValue,
  ledgerPathFromEnv,
  RpcClient,
  resolveRpcUrls,
} from "@probarion/sdk";
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

/** `flag` names the option in the error (`--rpc`, or `--archival-rpc` when verify passes that one as `rpc`). */
export function rpcUrlsFor(
  opts: GlobalOpts,
  env: Env,
  network: NetworkId,
  flag = "--rpc",
): string[] {
  if (opts.rpc !== undefined) {
    const urls = splitList(opts.rpc);
    if (urls.length === 0) throw new CliError(`${flag} needs at least one URL`);
    return urls;
  }
  return resolveRpcUrls(network, undefined, env);
}

export function makeRpc(opts: GlobalOpts, env: Env, network: NetworkId, flag = "--rpc"): RpcClient {
  return new RpcClient({ urls: rpcUrlsFor(opts, env, network, flag) });
}

/**
 * The ledger file: `--ledger`, else PROBARION_LEDGER_PATH, else `.probarion/ledger.jsonl`, resolved against the
 * working directory. An empty PROBARION_LEDGER_PATH counts as unset (R12); an empty `--ledger` is refused.
 */
export function ledgerFile(option: string | undefined, env: Env, cwd: string): string {
  if (option !== undefined && option.trim() === "") throw new CliError("--ledger needs a path");
  return resolve(cwd, option ?? ledgerPathFromEnv(env, DEFAULT_LEDGER_PATH));
}

/**
 * Whether two absolute paths name one file: the same path (letter case aside on Windows), or, when both exist,
 * the same device and inode (a hard link, a symlink, another spelling of the same file).
 */
export async function sameFile(a: string, b: string, platform: NodeJS.Platform): Promise<boolean> {
  const fold = (p: string) => (platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  if (fold(a) === fold(b)) return true;
  try {
    const [x, y] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })]);
    return x.ino !== 0n && x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/** Whether anything (a file, a directory) is at `path`. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The error for an output file that is already there, worded the same for every command. */
export function alreadyExists(flag: string, given: string): CliError {
  return new CliError(`${flag} ${given} already exists: choose a new file`);
}

/**
 * Writes `text` to a new file ("wx"): an export or a snapshot never replaces a file that is there. `flag` and
 * `given` name the option and its value in the error.
 */
export async function writeNewFile(
  path: string,
  text: string,
  flag: string,
  given: string,
): Promise<void> {
  try {
    await writeFile(path, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
    if (code === "EEXIST") throw alreadyExists(flag, given);
    throw error;
  }
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
