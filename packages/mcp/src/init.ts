// `probarion-mcp init --vault <id> [--keys-file <path>]`: makes the server's two keys on this machine. It writes
// them to a keys file that only its owner can read, once, and prints only the two public keys, which the vault's
// owner adds to the vault. A keys file that is there already is checked and its public keys printed again; it
// is not replaced. The secret keys go into the file and nowhere else: not to stdout, stderr or an error.
import { existsSync } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { envValue } from "@probarion/sdk";
import { checkVault } from "./config.js";
import { findGitWorkTree } from "./git-work-tree.js";
import {
  defaultKeysPath,
  errorCode,
  KeysFileWriteError,
  type Network,
  parseKeysFile,
  readKeysFileFromDisk,
  writeNewKeysFile,
} from "./keys-file.js";
import { AGENT_TAB, consoleWhere } from "./site.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface InitIo {
  env: Env;
  home: string;
  /** The folder a relative --keys-file is read from. */
  cwd: string;
  out: Writable;
  err: Writable;
  /** Test seams. */
  platform?: NodeJS.Platform;
  now?: () => Date;
}

export const INIT_HELP = `Usage: probarion-mcp init --vault <id> [--keys-file <path>]

Makes the two keys the MCP server signs with, on this machine: the agent key (it can only call spend on the
vault) and the ledger key (it can only call anchor, and signs the ledger). They go into a keys file that only
you can read, by default ~/.probarion/<vault>/keys.json, and only their public halves are printed. The vault's
owner then adds the two public keys to the vault, and the server reads the keys from the file, so an MCP
client's config needs only PROBARION_VAULT_ID (and PROBARION_KEYS_FILE for a file elsewhere).

A keys file that exists already is not replaced: init checks it and prints its public keys again.
The network comes from the vault id (.near is mainnet, .testnet is testnet), or NEAR_NETWORK for another name.
Exit code 0 when the keys file is ready, 1 when it could not be written, 2 for a usage or keys file error.
`;

/** A single quote: ASCII ', or U+2018 to U+201B, which PowerShell also reads as one. */
const isQuote = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return c === "'" || (code >= 0x2018 && code <= 0x201b);
};

/**
 * A word for a printed command: bare when plain, else in single quotes. Null when it holds a single quote, which
 * bash and PowerShell quote differently (the probarion CLI's shellQuote refuses such a value the same way).
 */
function shellWord(value: string): string | null {
  if ([...value].some(isQuote)) return null;
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value}'`;
}

/** Backslashes to slashes on Windows, where Node and near-cli-rs read both and a JSON config needs no escape. */
function shown(file: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? file.replaceAll("\\", "/") : file;
}

interface Arguments {
  vault: string;
  keysFile: string | null;
}

function parseArgs(args: readonly string[]): Arguments | { problem: string } | "help" {
  let vault: string | null = null;
  let keysFile: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--help" || a === "-h") return "help";
    const flag = a.startsWith("--vault")
      ? "--vault"
      : a.startsWith("--keys-file")
        ? "--keys-file"
        : null;
    let value: string | undefined;
    if (flag !== null && a === flag) {
      value = args[i + 1];
      if (value === undefined || value.startsWith("-")) return { problem: `${flag} needs a value` };
      i += 1;
    } else if (flag !== null && a.startsWith(`${flag}=`)) {
      value = a.slice(flag.length + 1);
    } else {
      return { problem: `unknown argument ${JSON.stringify(a).slice(0, 60)}` };
    }
    if (flag === "--vault") vault = value;
    else keysFile = value;
  }
  if (vault === null) return { problem: "--vault <id> is required" };
  if (keysFile !== null && keysFile.trim() === "") return { problem: "--keys-file needs a path" };
  return { vault, keysFile };
}

/** Runs `init`; returns the exit code. */
export async function runInit(args: readonly string[], io: InitIo): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === "help") {
    io.out.write(INIT_HELP);
    return 0;
  }
  if ("problem" in parsed) {
    io.err.write(`probarion-mcp init: ${parsed.problem}\n\n${INIT_HELP}`);
    return 2;
  }
  const { vault } = parsed;
  const checked = checkVault(vault, envValue(io.env, "NEAR_NETWORK"), "--vault");
  if (checked.problems.length > 0 || checked.network === null) {
    io.err.write(`probarion-mcp init:\n- ${checked.problems.join("\n- ")}\n`);
    return 2;
  }
  const network: Network = checked.network;
  const platform = io.platform ?? process.platform;
  const file =
    parsed.keysFile === null
      ? defaultKeysPath(io.home, vault)
      : path.resolve(io.cwd, parsed.keysFile);
  const where = shown(file, platform);

  let agentPublicKey: string;
  let ledgerPublicKey: string;
  let created: boolean;
  try {
    const written = writeNewKeysFile(file, {
      vault,
      network,
      now: (io.now ?? (() => new Date()))(),
    });
    if (written.status === "created") {
      ({ agentPublicKey, ledgerPublicKey } = written);
      created = true;
    } else {
      // There already: check it, and print its public keys again. It is not replaced.
      let text: string | null;
      try {
        text = readKeysFileFromDisk(file);
      } catch (error) {
        io.err.write(
          `probarion-mcp init: ${where} exists but could not be read (${errorCode(error) ?? "unknown error"}). init does not replace a keys file.\n`,
        );
        return 2;
      }
      const check =
        text === null
          ? { ok: false as const, problems: [`keys file ${where} went away while it was read`] }
          : parseKeysFile(text, where, { vault, network });
      if (!check.ok) {
        io.err.write(
          `probarion-mcp init: ${where} exists and is not a valid keys file for ${vault}:\n- ${check.problems.join("\n- ")}\ninit does not replace a keys file: move it away to make new keys, or give --keys-file another path.\n`,
        );
        return 2;
      }
      ({ agentPublicKey, ledgerPublicKey } = check.keys);
      created = false;
    }
  } catch (error) {
    if (error instanceof KeysFileWriteError) {
      io.err.write(`probarion-mcp init: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  // The same two warnings as `probarion agent keygen --out`.
  if (platform === "win32") {
    io.err.write(
      `warning: on Windows, file permissions are not restricted by mode bits: ${where} gets the permissions of its folder, so other users or programs on this machine may be able to read it. Keep it in a folder only you can read.\n`,
    );
  }
  if ((await findGitWorkTree(file)) !== null) {
    const word = shellWord(where);
    io.err.write(
      word === null
        ? "warning: this file is inside a git repository: make sure it is ignored and not tracked (run git check-ignore -v and git ls-files on it)\n"
        : `warning: this file is inside a git repository: make sure it is ignored and not tracked (git check-ignore -v ${word}; git ls-files ${word})\n`,
    );
  }

  const ledgerPath =
    envValue(io.env, "PROBARION_LEDGER_PATH") ??
    path.join(io.home, ".probarion", vault, "ledger.jsonl");
  const ledgerShown = shown(ledgerPath, platform);
  const custom = parsed.keysFile !== null;
  const settings = custom
    ? `PROBARION_VAULT_ID=${vault} and PROBARION_KEYS_FILE=${where}`
    : `PROBARION_VAULT_ID=${vault}`;
  const agentPk = shellWord(agentPublicKey) ?? agentPublicKey;
  const ledgerPk = shellWord(ledgerPublicKey) ?? ledgerPublicKey;
  const lines = [
    `probarion-mcp init: vault ${vault} on ${network}`,
    created
      ? `Wrote the keys file ${where}${platform === "win32" ? "" : " (mode 0600)"}. It holds the two secret keys, which are not printed.`
      : `The keys file ${where} is there already and was not changed. Its public keys:`,
    "",
    `agent public key:  ${agentPublicKey}`,
    `ledger public key: ${ledgerPublicKey}`,
    "",
    "Next:",
    "1. The vault's owner adds the two public keys to the vault. Paste them on",
    `   ${consoleWhere(network, vault, AGENT_TAB)}`,
    "   or print the two owner transactions with the probarion CLI, and sign them in the owner's wallet:",
    `   probarion agent add --vault ${vault} --pk ${agentPk}`,
    `   probarion ledger set-key --vault ${vault} --pk ${ledgerPk}`,
    `2. Check that the vault is ready: probarion-mcp status, with ${settings}.`,
    `3. Give the MCP client only ${settings}: the server reads its keys from the keys file.`,
    "",
    path.dirname(ledgerPath) === path.dirname(file)
      ? `Back up the folder ${shown(path.dirname(file), platform)}: the keys file is there, and so is ${path.basename(ledgerPath)}, the only copy of the agent's signed record once the server writes it.`
      : `Back up the keys file and the folder ${shown(path.dirname(ledgerPath), platform)}: ${ledgerShown} is the only copy of the agent's signed record once the server writes it.`,
  ];
  if (created && existsSync(ledgerPath)) {
    lines.push(
      `Note: ${ledgerShown} exists already, signed with another ledger key. The entries after the vault's last anchor must be signed by its current ledger key, so anchor that ledger with the old key before the owner sets the new one.`,
    );
  }
  io.out.write(`${lines.join("\n")}\n`);
  return 0;
}
