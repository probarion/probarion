// The binary's arguments. With none, probarion-mcp is the MCP server (main.ts) and stdout carries only
// JSON-RPC. init, status, demo, --version and --help are for a person at a terminal, and each one exits when
// it is done.
import { homedir } from "node:os";
import type { Writable } from "node:stream";
import { DEMO_VAULT, runDemo } from "./demo.js";
import { runInit } from "./init.js";
import { VERSION } from "./main.js";
import { runStatus } from "./status.js";
import { argumentShown } from "./words.js";

export const HELP = `probarion-mcp ${VERSION}: the Probarion MCP server. Unaudited beta.

Usage:
  probarion-mcp                      Run the MCP server over stdio. This is what an MCP client starts.
  probarion-mcp init --vault <id> [--keys-file <path>]
                                     Make the server's agent key and ledger key on this machine, in a
                                     keys file only you can read (default ~/.probarion/<vault>/keys.json).
                                     Prints only the two public keys, for the vault's owner to add.
  probarion-mcp status               Check that the vault is ready for this server: its keys, the
                                     vault's view of them, a mandate, USDC and the local ledger.
                                     Read-only: nothing is signed or sent.
  probarion-mcp demo [--vault <id>]  A read-only tour of the five tools against a live testnet vault
                                     (default ${DEMO_VAULT}). No key is needed, and
                                     nothing is signed or sent.
  probarion-mcp --version            Print the version.
  probarion-mcp --help               Print this help.

The server reads its settings from its environment: PROBARION_VAULT_ID (required); its keys from
PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY when both are set, else from the keys file PROBARION_KEYS_FILE
names, else from ~/.probarion/<vault>/keys.json when it exists, else none (read-only mode); NEAR_NETWORK
(when the vault id ends in neither .near nor .testnet), NEAR_RPC_URLS, NEAR_ARCHIVAL_RPC_URLS and
PROBARION_LEDGER_PATH. status reads the same settings.
More: https://github.com/probarion/probarion/tree/main/packages/mcp
`;

export interface CliIo {
  env: Readonly<Record<string, string | undefined>>;
  out: Writable;
  err: Writable;
  /** The home folder that holds ~/.probarion. Default: the user's. */
  home?: string;
  /** The folder a relative path is read from. Default: the process's working folder. */
  cwd?: string;
  /** The command this binary was started as, for the commands init and status print. Default `probarion-mcp`. */
  self?: string;
}

/** Runs the command named by the arguments (there is at least one); returns the exit code. */
export async function runCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  const home = io.home ?? homedir();
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
    case "init":
      return runInit(rest, { ...io, home, cwd: io.cwd ?? process.cwd() });
    case "status":
      return runStatus(rest, { ...io, home });
    case "demo":
      return runDemo(rest, io);
    default:
      io.err.write(`probarion-mcp: unknown argument ${argumentShown(command ?? "", 1)}\n\n${HELP}`);
      return 2;
  }
}
