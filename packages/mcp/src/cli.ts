// The binary's arguments. With none, probarion-mcp is the MCP server (main.ts) and stdout carries only
// JSON-RPC. --version, --help and demo are for a person at a terminal, and each one exits when it is done.
import type { Writable } from "node:stream";
import { DEMO_VAULT, runDemo } from "./demo.js";
import { VERSION } from "./main.js";

export const HELP = `probarion-mcp ${VERSION}: the Probarion MCP server. Unaudited beta.

Usage:
  probarion-mcp                      Run the MCP server over stdio. This is what an MCP client starts.
  probarion-mcp demo [--vault <id>]  A read-only tour of the five tools against a live testnet vault
                                     (default ${DEMO_VAULT}). No key is needed, and
                                     nothing is signed or sent.
  probarion-mcp --version            Print the version.
  probarion-mcp --help               Print this help.

The server reads its settings from its environment: PROBARION_VAULT_ID (required), PROBARION_AGENT_KEY
and PROBARION_LEDGER_KEY (both, or neither for read-only mode), NEAR_NETWORK (when the vault id ends in
neither .near nor .testnet), NEAR_RPC_URLS, NEAR_ARCHIVAL_RPC_URLS and PROBARION_LEDGER_PATH.
More: https://github.com/probarion/probarion/tree/main/packages/mcp
`;

export interface CliIo {
  env: Readonly<Record<string, string | undefined>>;
  out: Writable;
  err: Writable;
}

/** Runs the command named by the arguments (there is at least one); returns the exit code. */
export async function runCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "--version":
    case "-v":
      io.out.write(`${VERSION}\n`);
      return 0;
    case "--help":
    case "-h":
    case "help":
      io.out.write(HELP);
      return 0;
    case "demo":
      return runDemo(rest, io);
    default:
      io.err.write(
        `probarion-mcp: unknown argument ${JSON.stringify(command ?? "").slice(0, 60)}\n\n${HELP}`,
      );
      return 2;
  }
}
