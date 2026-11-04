import { type Command, CommanderError } from "commander";

/** The exit code of a usage error in the commands whose 1 is a result (`check`, `verify`): EX_USAGE of sysexits.h. */
export const EXIT_USAGE = 64;

export class CliError extends Error {
  override name = "CliError";
  /** The exit code `runCli` returns for this error. */
  readonly exitCode: number = 1;
}

/**
 * A missing, malformed or conflicting flag of `check` or `verify`. Those commands exit 1 for a result (the vault
 * would refuse; a check fails), so a usage error must not look like one: it exits 64.
 */
export class UsageError extends CliError {
  override name = "UsageError";
  override readonly exitCode = EXIT_USAGE;
}

/** Runs `fn` and turns a `CliError` it throws into a `UsageError` with the same message. */
export function asUsage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CliError && !(error instanceof UsageError)) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

/**
 * Commander's own parse errors of `command` (an unknown option, a missing value or required option) exit 64 too.
 * `--help` keeps exit 0. Commander has already printed the message when this runs.
 */
export function usageExitCodes(command: Command): Command {
  return command.exitOverride((error) => {
    throw error.exitCode === 0 ? error : new CommanderError(EXIT_USAGE, error.code, error.message);
  });
}
