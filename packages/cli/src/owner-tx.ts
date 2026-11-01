import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NetworkId } from "@probarion/core";
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

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
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

/**
 * How a file is named in the printed command (R11): `./relative` under the working directory,
 * otherwise absolute, and with forward slashes on Windows. near-cli-rs reads both spellings there,
 * and a backslash path would be eaten by the shell the owner pastes it into.
 */
export function displayPath(cwd: string, file: string, pathApi: path.PlatformPath = path): string {
  const slashes = (value: string): string =>
    pathApi.sep === "\\" ? value.replaceAll("\\", "/") : value;
  const rel = pathApi.relative(cwd, file);
  const inside =
    rel !== "" && rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel);
  return inside ? `./${slashes(rel)}` : slashes(file);
}

/** Writes <outDir>/<method>.args.json and prints the command. Never signs, never sends. */
export async function printOwnerTx(io: CliIo, tx: OwnerTx, outDir: string): Promise<string> {
  const dir = path.resolve(io.cwd, outDir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${tx.method}.args.json`);
  const argsJson = `${JSON.stringify(tx.args, null, 2)}\n`;
  await writeFile(file, argsJson, "utf8");
  const shown = displayPath(io.cwd, file);
  const lines = [
    `${(tx.signer ?? "owner").toUpperCase()} SIGNS: probarion never signs owner or approver transactions. Review the arguments, then sign with your own wallet or near-cli-rs:`,
    "",
    renderNearCliCommand(tx, shown),
    "",
    `${tx.method} arguments (${shown}):`,
    argsJson.trimEnd(),
  ];
  if (tx.note !== undefined) lines.push("", tx.note);
  lines.push("", "With a Ledger hardware wallet, replace sign-with-keychain by sign-with-ledger.");
  io.out(`${lines.join("\n")}\n`);
  return file;
}
