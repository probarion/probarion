// The keys file: the agent key and the ledger key of one vault, kept on this machine so that an MCP client's
// config file carries only the vault id. `probarion-mcp init` writes it once, readable by its owner only, and
// the server and `probarion-mcp status` read it. No message, log line or error from this module holds a value
// read from the file: a problem names the file and the field, and nothing else.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { generateKeyPair, publicKeyFromSecret } from "@probarion/core";

export const KEYS_FILE_FORMAT = "probarion-mcp-keys/1";

/** U+FEFF, which an editor on Windows may put at the start of a file it saves. */
const BYTE_ORDER_MARK = 0xfeff;

/** A keys file is a few hundred bytes; anything much larger is not one, and is not parsed. */
const MAX_KEYS_FILE_BYTES = 64 * 1024;

export type Network = "mainnet" | "testnet";

/** The two keys a valid file holds, with the public half of each. */
export interface FileKeys {
  agentKey: string;
  ledgerKey: string;
  agentPublicKey: string;
  ledgerPublicKey: string;
}

export type KeysFileCheck = { ok: true; keys: FileKeys } | { ok: false; problems: string[] };

/**
 * Reads a keys file: its text, or null when there is no file at that path. Any other failure (no permission,
 * a folder) is thrown. Injected into `loadConfig`, so that it reads no file of its own.
 */
export type ReadKeysFile = (path: string) => string | null;

/** `~/.probarion/<vault>/keys.json`. The vault must already be a checked NEAR account id. */
export function defaultKeysPath(home: string, vault: string): string {
  return join(home, ".probarion", vault, "keys.json");
}

/** The code of a Node file-system error, or undefined. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export const readKeysFileFromDisk: ReadKeysFile = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One key pair of the file, or null after naming its problems. */
function readPair(
  value: unknown,
  role: "agent" | "ledger",
  where: string,
  problems: string[],
): { secretKey: string; publicKey: string } | null {
  if (!isRecord(value)) {
    problems.push(`${where}: ${role} must be an object with public_key and secret_key`);
    return null;
  }
  const { public_key: publicKey, secret_key: secretKey } = value;
  if (typeof secretKey !== "string") {
    problems.push(`${where}: ${role}.secret_key must be a string`);
    return null;
  }
  if (typeof publicKey !== "string") {
    problems.push(`${where}: ${role}.public_key must be a string`);
    return null;
  }
  let derived: string;
  try {
    derived = publicKeyFromSecret(secretKey);
  } catch {
    // The library's message names only the kind of value; it is still not passed on.
    problems.push(`${where}: ${role}.secret_key is not an ed25519 secret key`);
    return null;
  }
  if (derived !== publicKey) {
    problems.push(`${where}: ${role}.public_key is not the public half of ${role}.secret_key`);
    return null;
  }
  return { secretKey, publicKey };
}

/**
 * Checks a keys file's text: valid JSON in this format, for this vault and network, each secret key deriving the
 * public key beside it, and two different keys. Every problem is named, by the file and the field.
 */
export function parseKeysFile(
  text: string,
  path: string,
  expected: { vault: string; network: Network },
): KeysFileCheck {
  const where = `keys file ${path}`;
  if (text.length > MAX_KEYS_FILE_BYTES) {
    return { ok: false, problems: [`${where} is too large to be a keys file`] };
  }
  let value: unknown;
  try {
    // A file saved by an editor on Windows may start with a byte order mark, which JSON.parse refuses.
    value = JSON.parse(text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text);
  } catch {
    // The parser's message quotes the text around the error, which can be a secret key: it is dropped.
    return { ok: false, problems: [`${where} is not valid JSON`] };
  }
  if (!isRecord(value) || value.format !== KEYS_FILE_FORMAT) {
    return {
      ok: false,
      problems: [
        `${where}: format must be "${KEYS_FILE_FORMAT}" (a file written by probarion-mcp init)`,
      ],
    };
  }
  const problems: string[] = [];
  if (value.vault !== expected.vault) {
    problems.push(`${where}: vault is not ${expected.vault}, the vault this server is set up for`);
  }
  if (value.network !== expected.network) {
    problems.push(`${where}: network is not ${expected.network}, the vault's network`);
  }
  const agent = readPair(value.agent, "agent", where, problems);
  const ledger = readPair(value.ledger, "ledger", where, problems);
  if (agent !== null && ledger !== null && agent.publicKey === ledger.publicKey) {
    problems.push(
      `${where}: agent and ledger hold the same key; the vault takes a key as one of the two, not both`,
    );
  }
  if (problems.length > 0 || agent === null || ledger === null) return { ok: false, problems };
  return {
    ok: true,
    keys: {
      agentKey: agent.secretKey,
      ledgerKey: ledger.secretKey,
      agentPublicKey: agent.publicKey,
      ledgerPublicKey: ledger.publicKey,
    },
  };
}

export class KeysFileWriteError extends Error {}

export type WriteKeysFileResult =
  | { status: "created"; agentPublicKey: string; ledgerPublicKey: string }
  | { status: "exists" };

/**
 * The folders whose entries a new file at `file` adds: its own folder, and when `mkdirSync` made folders for it
 * (`firstMade`, the top one it made), each folder up to the one that holds `firstMade`.
 */
export function foldersToSync(file: string, firstMade: string | undefined): string[] {
  const folders = [dirname(file)];
  if (firstMade === undefined) return folders;
  // Node on Windows hands back the folder it made as a \\?\ path; the path it was given has no such prefix.
  const top = dirname(firstMade.startsWith("\\\\?\\") ? firstMade.slice(4) : firstMade);
  for (let at = dirname(file); at !== top; ) {
    const up = dirname(at);
    if (up === at) break; // the root: `firstMade` was not above the file after all
    at = up;
    folders.push(at);
  }
  return folders;
}

/** Syncs a folder, so that a new entry in it survives a crash. A file system that cannot sync a folder is let be. */
function syncFolderOnDisk(folder: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(folder, "r");
    fsyncSync(fd);
  } catch {
    // EISDIR, EPERM or EINVAL where a folder cannot be opened or synced: the file itself is synced already.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing was written through it.
      }
    }
  }
}

/**
 * Makes two new key pairs and writes them to `path`, which must not exist yet: "wx" opens it only when it is new,
 * so an existing file is left as it is (status "exists"). The file gets mode 0600 and a folder it creates 0700,
 * where the OS enforces mode bits. The file is synced before this returns, and outside Windows so is each folder
 * it adds an entry to (its own, and any folder made for it), where the file system allows it: the public keys
 * handed back are then in a file that survives a crash. Only the public keys come back.
 */
export function writeNewKeysFile(
  path: string,
  opts: {
    vault: string;
    network: Network;
    now: Date;
    /** Test seams. */
    platform?: NodeJS.Platform;
    syncFolder?: (folder: string) => void;
  },
): WriteKeysFileResult {
  const agent = generateKeyPair();
  const ledger = generateKeyPair();
  if (agent.publicKey === ledger.publicKey) {
    throw new KeysFileWriteError("the two new keys came out the same; nothing was written");
  }
  const text = `${JSON.stringify(
    {
      format: KEYS_FILE_FORMAT,
      vault: opts.vault,
      network: opts.network,
      agent: { public_key: agent.publicKey, secret_key: agent.secretKey },
      ledger: { public_key: ledger.publicKey, secret_key: ledger.secretKey },
      created_at: opts.now.toISOString(),
    },
    null,
    2,
  )}\n`;
  const failed = (error: unknown): KeysFileWriteError =>
    new KeysFileWriteError(
      `could not create the keys file ${path} (${errorCode(error) ?? "unknown error"})`,
    );
  let firstMade: string | undefined;
  try {
    firstMade = mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    // Its own EEXIST (Windows) or ENOTDIR (POSIX) means a file is in the way of a folder: not the keys file.
    throw failed(error);
  }
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return { status: "exists" };
    throw failed(error);
  }
  let written = false;
  try {
    // writeSync may write less than asked (a full disk): every byte, or a failure.
    const bytes = Buffer.from(text, "utf8");
    for (let at = 0; at < bytes.length; ) {
      const n = writeSync(fd, bytes, at);
      if (n <= 0) throw Object.assign(new Error("short write"), { code: "EIO" });
      at += n;
    }
    fsyncSync(fd);
    written = true;
  } catch (error) {
    throw new KeysFileWriteError(
      `could not write the keys file ${path} (${errorCode(error) ?? "unknown error"})`,
    );
  } finally {
    closeSync(fd);
    // "wx" made this file in this call, so a part-written one is removed rather than left with part of a key.
    if (!written) {
      try {
        unlinkSync(path);
      } catch {
        // Gone already, or not removable: the error above still says the file could not be written.
      }
    }
  }
  // On POSIX file systems (ext4, xfs) a new file's entry in its folder is durable only once the folder is synced.
  // Node on Windows cannot sync a folder, so there only the file is synced.
  if ((opts.platform ?? process.platform) !== "win32") {
    for (const folder of foldersToSync(path, firstMade))
      (opts.syncFolder ?? syncFolderOnDisk)(folder);
  }
  return { status: "created", agentPublicKey: agent.publicKey, ledgerPublicKey: ledger.publicKey };
}
