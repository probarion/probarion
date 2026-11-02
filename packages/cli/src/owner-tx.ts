import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type NetworkId, sha256Hex } from "@probarion/core";
import { CliError } from "./errors.js";
import type { CliIo } from "./io.js";

/** Interfaces §4.2 v2: mutating owner and approver methods require exactly 1 yoctoNEAR. */
export const ONE_YOCTO = "1 yoctoNEAR";

export interface OwnerTx {
  network: NetworkId;
  contractId: string;
  method: string;
  args: Record<string, unknown>;
  gasTgas: string;
  deposit: string; // as near-cli-rs prints it: "1 yoctoNEAR", "0.1 NEAR", "0 NEAR"
  signAs?: string | undefined;
  signer?: "owner" | "approver";
  note?: string;
}

/**
 * A word for a printed command: bare when it is plain, otherwise in single quotes. A value holding a
 * single quote is refused: bash writes it `'\''` and PowerShell writes it `''`, no spelling works in
 * both, and the printed commands promise to run in either.
 */
export function shellQuote(value: string): string {
  if (value.includes("'")) {
    throw new CliError(
      `${JSON.stringify(value)} contains a single quote ('), which bash and PowerShell quote differently, so it cannot go into a command that runs in both`,
    );
  }
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value}'`;
}

/** Refuses a path that shellQuote would refuse, with the flag the owner has to change. Writes nothing. */
export function assertQuotablePath(shown: string, flag: string): void {
  if (shown.includes("'")) {
    throw new CliError(
      `${flag}: the path ${JSON.stringify(shown)} contains a single quote ('), which bash and PowerShell quote differently: choose a path without one`,
    );
  }
}

export function renderNearCliCommand(tx: OwnerTx, argsPath: string): string {
  return [
    "near contract call-function as-transaction",
    shellQuote(tx.contractId),
    shellQuote(tx.method),
    "file-args",
    shellQuote(argsPath),
    "prepaid-gas",
    `'${tx.gasTgas} Tgas'`,
    "attached-deposit",
    `'${tx.deposit}'`,
    "sign-as",
    // A placeholder stays unquoted on purpose: pasted as it is, the shell rejects it.
    tx.signAs === undefined ? `<${tx.signer ?? "owner"}-account-id>` : shellQuote(tx.signAs),
    "network-config",
    tx.network,
    "sign-with-keychain",
    "send",
  ].join(" ");
}

/** Backslashes to slashes on Windows paths; a POSIX path is left alone (a backslash is a legal file name character there). */
export function forwardSlashes(value: string, pathApi: path.PlatformPath = path): string {
  return pathApi.sep === "\\" ? value.replaceAll("\\", "/") : value;
}

/**
 * How a file is named in the printed command (R11): `./relative` under the working directory,
 * otherwise absolute, and with forward slashes on Windows. near-cli-rs reads both spellings there,
 * and a backslash path would be eaten by the shell the owner pastes it into.
 */
export function displayPath(cwd: string, file: string, pathApi: path.PlatformPath = path): string {
  const rel = pathApi.relative(cwd, file);
  const inside =
    rel !== "" && rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel);
  return inside ? `./${forwardSlashes(rel, pathApi)}` : forwardSlashes(file, pathApi);
}

/**
 * `<method>.<first 12 hex of sha256(args JSON)>.args.json` (T15-R1). The name follows the content, so
 * a later print can never rewrite the file under a command printed earlier: a pasted old command
 * still reads the arguments the owner reviewed. Two prints with identical arguments share one file,
 * which is harmless because the content is the same.
 */
export function argsFileName(method: string, argsJson: string): string {
  return `${method}.${sha256Hex(argsJson).slice(0, 12)}.args.json`;
}

/**
 * Creates the args file exclusively ("wx"). A file already there is fine only if its content is
 * exactly ours (an identical earlier print); anything else is refused, because the name was meant to
 * pin the content and a file under it that differs was edited after printing (or collided).
 */
async function writeArgsFile(file: string, shown: string, argsJson: string): Promise<void> {
  try {
    await writeFile(file, argsJson, { encoding: "utf8", flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let existing: string;
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    throw new CliError(
      `${shown} exists and cannot be read as a file (${error instanceof Error ? error.message : String(error)}): delete it and print again`,
    );
  }
  if (existing !== argsJson) {
    throw new CliError(
      `${shown} exists with different content (edited after printing, or a hash collision): delete it and print again`,
    );
  }
}

/**
 * Writes <outDir>/<method>.<hash>.args.json and prints the command with the full sha256 of that
 * file beside it, so the owner can check the file against the line before signing. Never signs,
 * never sends.
 */
export async function printOwnerTx(io: CliIo, tx: OwnerTx, outDir: string): Promise<string> {
  const dir = path.resolve(io.cwd, outDir);
  const argsJson = `${JSON.stringify(tx.args, null, 2)}\n`;
  const file = path.join(dir, argsFileName(tx.method, argsJson));
  const shown = displayPath(io.cwd, file);
  // Before anything is created: a path the printed command cannot quote for both bash and PowerShell.
  assertQuotablePath(shown, "--out-dir");
  await mkdir(dir, { recursive: true });
  await writeArgsFile(file, shown, argsJson);
  const quoted = shellQuote(shown);
  const lines = [
    `${(tx.signer ?? "owner").toUpperCase()} SIGNS: probarion never signs owner or approver transactions. Review the arguments, then sign with your own wallet or near-cli-rs:`,
    "",
    renderNearCliCommand(tx, shown),
    `sha256 of the args file: ${sha256Hex(argsJson)}  (check: sha256sum ${quoted}, or Get-FileHash -Algorithm SHA256 ${quoted} in PowerShell)`,
    "Run it in bash, zsh or PowerShell (not cmd.exe).",
    "",
    `${tx.method} arguments (${shown}):`,
    argsJson.trimEnd(),
  ];
  if (tx.note !== undefined) lines.push("", tx.note);
  lines.push(
    "",
    "With a Ledger hardware wallet, replace `sign-with-keychain send` with `sign-with-ledger usb send`.",
  );
  io.out(`${lines.join("\n")}\n`);
  return file;
}
