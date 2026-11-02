// The off-chain evidence a snapshot draws on (Task 14): plan 02's documented Day-4 decisions and the burn
// transactions recorded in docs/mainnet-proof.json (plan 05). Reading them needs the file system, never the network.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Hex32, sha256Hex } from "@probarion/core";

/** Plan 02's Day-4 decision records; each v0 spend's decision_hash is the sha256 of one of these files. */
export const PRE_LEDGER_DECISION_FILE = /^v0-decision-.+\.json$/;

/** Where `docs/evidence` and `docs/mainnet-proof.json` are by default (relative to the working directory). */
export const DEFAULT_EVIDENCE_DIR = "docs/evidence";
export const DEFAULT_PROOF_FILE = "docs/mainnet-proof.json";

/**
 * The only vaults whose spends predate the signed ledger (carries A): mainnet v0 (Day 4 of plan 02). Every other
 * vault gets no pre-ledger hashes, whatever a caller or `docs/evidence` holds, so the public Day-4 hashes can
 * never exempt another vault's spends from check d.
 */
export const PRE_LEDGER_VAULTS: Readonly<Record<"mainnet" | "testnet", readonly string[]>> = {
  mainnet: ["v0.probarion.near"],
  testnet: [],
};

export function isPreLedgerVault(network: "mainnet" | "testnet", vault: string): boolean {
  return PRE_LEDGER_VAULTS[network].includes(vault);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

/** sha256 of the exact bytes of each `v0-decision-*.json` in `dir`, in name order. A missing directory gives []. */
export async function readPreLedgerDecisionHashes(dir: string): Promise<Hex32[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const hashes: Hex32[] = [];
  for (const name of names.filter((n) => PRE_LEDGER_DECISION_FILE.test(n)).sort()) {
    hashes.push(sha256Hex(new Uint8Array(await readFile(join(dir, name)))));
  }
  return hashes;
}

/** Spend id to the transactions that may hold its burn (R7 source 1). Each one is checked on chain. */
export type BurnTxHints = ReadonlyMap<number, readonly string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The burn tx hints of `vault` from a plan 05 evidence file (`docs/mainnet-proof.json`, interfaces §16): every
 * recorded transaction of `network` whose receiver is the vault, that carries a `spend_id` and was expected to
 * succeed (a `base_payout`, or the `approved` tx that paid a held spend). A hint is only a place to look: check h
 * still needs the burn pair inside the transaction. A missing file gives an empty map; a file that is not JSON
 * throws.
 */
export async function loadBurnTxHints(
  file: string,
  opts: { vault: string; network: "mainnet" | "testnet" },
): Promise<Map<number, string[]>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return new Map();
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  const txs = isRecord(parsed) && isRecord(parsed.txs) ? parsed.txs : {};
  const hints = new Map<number, string[]>();
  for (const tx of Object.values(txs)) {
    if (!isRecord(tx)) continue;
    const { hash, network, receiver_id: receiver, spend_id: spendId, expect } = tx;
    if (typeof hash !== "string" || hash.length === 0) continue;
    if (network !== opts.network || receiver !== opts.vault || expect === "failure") continue;
    if (typeof spendId !== "number" || !Number.isSafeInteger(spendId) || spendId < 0) continue;
    const list = hints.get(spendId) ?? [];
    if (!list.includes(hash)) list.push(hash);
    hints.set(spendId, list);
  }
  return hints;
}
