import { Command, CommanderError } from "commander";
import { registerAgent } from "./commands/agent.js";
import { registerCheck } from "./commands/check.js";
import { registerLedger } from "./commands/ledger.js";
import { registerMandate } from "./commands/mandate.js";
import { registerOwnerCalls } from "./commands/owner-calls.js";
import { registerVault } from "./commands/vault.js";
import { registerVerify } from "./commands/verify.js";
import { CliError } from "./errors.js";
import type { CliIo } from "./io.js";
import { CLI_VERSION } from "./version.js";

export function buildProgram(io: CliIo): Command {
  const program = new Command("probarion");
  program
    .description("Spend by mandate. Prove every payment. (Unaudited beta.)")
    .version(CLI_VERSION)
    .option("--network <network>", "mainnet | testnet (default: NEAR_NETWORK, else testnet)")
    .option(
      "--rpc <urls>",
      "comma-separated NEAR RPC URLs (default: NEAR_RPC_URLS, else the network defaults)",
    )
    .exitOverride()
    .configureOutput({ writeOut: (text) => io.out(text), writeErr: (text) => io.err(text) });
  registerVault(program, io);
  registerMandate(program, io);
  registerAgent(program, io);
  registerLedger(program, io);
  registerOwnerCalls(program, io);
  registerCheck(program, io);
  registerVerify(program, io);
  return program;
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let exitCode = 0;
  const program = buildProgram({
    ...io,
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    io.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    // A CliError carries its own code (64 for a usage error of check and verify); anything else is 1.
    return error instanceof CliError ? error.exitCode : 1;
  }
  return exitCode;
}
