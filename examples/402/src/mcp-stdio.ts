// Starts @probarion/mcp over stdio, on testnet, with the vault's two function-call keys from the environment.
// Run `pnpm build` in the repository first: this starts packages/mcp/dist/bin.js.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { envValue } from "@probarion/sdk";

type Env = Readonly<Record<string, string | undefined>>;

/** The settings passed on to the server. The keys go to it and are not printed. */
const PASSED_ON = [
  "PROBARION_VAULT_ID",
  "PROBARION_AGENT_KEY",
  "PROBARION_LEDGER_KEY",
  "PROBARION_LEDGER_PATH",
  "NEAR_RPC_URLS",
] as const;

/** The testnet vault in the environment, or null when PROBARION_VAULT_ID is not a .testnet vault. */
export function testnetVault(env: Env): string | null {
  const vault = envValue(env, "PROBARION_VAULT_ID") ?? "";
  const network = envValue(env, "NEAR_NETWORK") ?? "testnet";
  return network === "testnet" && vault.endsWith(".testnet") ? vault : null;
}

export async function connectMcp(env: Env, name: string): Promise<Client> {
  const childEnv: Record<string, string> = { ...getDefaultEnvironment(), NEAR_NETWORK: "testnet" };
  for (const key of PASSED_ON) {
    const value = envValue(env, key);
    if (value !== undefined) childEnv[key] = value;
  }
  const bin = fileURLToPath(new URL("bin.js", import.meta.resolve("@probarion/mcp")));
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [bin], env: childEnv }),
  );
  return client;
}
