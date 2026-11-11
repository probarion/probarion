// Starts @probarion/mcp over stdio, on testnet, with the vault's two function-call keys from the environment,
// and resolves the paths a testnet run writes to. Run `pnpm build` in the repository first: this starts
// packages/mcp/dist/bin.js.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { envValue } from "@probarion/sdk";

type Env = Readonly<Record<string, string | undefined>>;

/** The settings passed on to the server as they are. The keys go to it and are not printed. */
const PASSED_ON = [
  "PROBARION_VAULT_ID",
  "PROBARION_AGENT_KEY",
  "PROBARION_LEDGER_KEY",
  "NEAR_RPC_URLS",
] as const;

/** Where receipts go when RECEIPTS_PATH is not set: receipts.jsonl in this example's folder (git ignores it). */
export const DEFAULT_RECEIPTS_PATH = fileURLToPath(new URL("../receipts.jsonl", import.meta.url));

/** The testnet vault in the environment, or null when PROBARION_VAULT_ID is not a .testnet vault. */
export function testnetVault(env: Env): string | null {
  const vault = envValue(env, "PROBARION_VAULT_ID") ?? "";
  const network = envValue(env, "NEAR_NETWORK") ?? "testnet";
  return network === "testnet" && vault.endsWith(".testnet") ? vault : null;
}

/**
 * A path from the environment, made absolute against the folder the command was run from. `pnpm --filter`
 * runs a script in examples/402 and sets INIT_CWD to where pnpm was started, so a path given from the
 * repository root still means the repository root.
 */
export function fromCallerDir(env: Env, path: string): string {
  return resolve(envValue(env, "INIT_CWD") ?? process.cwd(), path);
}

/** The ledger file the MCP server is given, absolute; null when PROBARION_LEDGER_PATH is not set. */
export function ledgerPathOf(env: Env): string | null {
  const path = envValue(env, "PROBARION_LEDGER_PATH");
  return path === undefined ? null : fromCallerDir(env, path);
}

/** The line that names the ledger file, printed before the first call. */
export function ledgerLine(env: Env, vault: string): string {
  const path = ledgerPathOf(env);
  return path === null
    ? `Ledger file: the MCP server's default, ~/.probarion/${vault}/ledger.jsonl (PROBARION_LEDGER_PATH is not set).`
    : `Ledger file: ${path}`;
}

/** Where a testnet run appends its receipts: RECEIPTS_PATH made absolute, else DEFAULT_RECEIPTS_PATH. */
export function receiptsPathOf(env: Env): string {
  const path = envValue(env, "RECEIPTS_PATH");
  return path === undefined ? DEFAULT_RECEIPTS_PATH : fromCallerDir(env, path);
}

export async function connectMcp(env: Env, name: string): Promise<Client> {
  const childEnv: Record<string, string> = { ...getDefaultEnvironment(), NEAR_NETWORK: "testnet" };
  for (const key of PASSED_ON) {
    const value = envValue(env, key);
    if (value !== undefined) childEnv[key] = value;
  }
  // The server opens the ledger path as given, from its own folder: it gets the absolute path.
  const ledgerPath = ledgerPathOf(env);
  if (ledgerPath !== null) childEnv.PROBARION_LEDGER_PATH = ledgerPath;
  const bin = fileURLToPath(new URL("bin.js", import.meta.resolve("@probarion/mcp")));
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [bin], env: childEnv }),
  );
  return client;
}
