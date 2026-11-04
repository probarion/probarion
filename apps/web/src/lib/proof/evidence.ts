// The off-chain evidence /proof hands the SDK instead of letting it read files (R5): on Vercel there is no
// docs/evidence and no docs/mainnet-proof.json at runtime. It lives in one committed file,
// apps/web/content/proof-evidence.json, keyed by "<network>:<vault>". docs/runbooks/web-deploy.md says how to fill it.
import { type Hex32, isNearAccountId, isNearTxHash } from "@probarion/core";
import type { Network } from "@/lib/config";

/** The evidence file is malformed. /proof then shows an error state and runs no check: it fails closed. */
export class ProofEvidenceError extends Error {
  constructor(why: string) {
    super(`content/proof-evidence.json: ${why}`);
    this.name = "ProofEvidenceError";
  }
}

/** A transaction that may hold a spend's burn, and the account that signed it when that is known. */
export interface BurnHint {
  hash: string;
  signer?: string;
}

/** What one vault gets: the SDK's `preLedgerDecisionHashes` and `burnTxHints`, in the SDK's own shapes. */
export interface VaultEvidence {
  preLedgerDecisionHashes: Hex32[];
  burnTxHints: Map<number, BurnHint[]>;
}

const KEY = /^(mainnet|testnet):(.*)$/;
const HEX32 = /^[0-9a-f]{64}$/;
const SPEND_ID = /^(0|[1-9][0-9]*)$/;
const ENTRY_FIELDS: readonly string[] = ["preLedgerDecisionHashes", "burnTxHints"];
const HINT_FIELDS: readonly string[] = ["hash", "signer"];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bad = (why: string): never => {
  throw new ProofEvidenceError(why);
};

function hint(value: unknown, where: string): BurnHint {
  if (typeof value === "string") {
    return isNearTxHash(value) ? { hash: value } : bad(`${where} is not a NEAR tx hash`);
  }
  if (!isObject(value)) return bad(`${where} is neither a tx hash nor { hash, signer }`);
  if (Object.keys(value).some((k) => !HINT_FIELDS.includes(k))) {
    return bad(`${where} has a field other than hash and signer`);
  }
  if (!isNearTxHash(value.hash)) return bad(`${where}.hash is not a NEAR tx hash`);
  if (value.signer === undefined) return { hash: value.hash };
  if (!isNearAccountId(value.signer)) return bad(`${where}.signer is not a NEAR account id`);
  return { hash: value.hash, signer: value.signer };
}

function vaultEvidence(value: unknown, where: string): VaultEvidence {
  if (!isObject(value)) return bad(`${where} is not an object`);
  if (Object.keys(value).some((k) => !ENTRY_FIELDS.includes(k))) {
    return bad(`${where} has a field other than preLedgerDecisionHashes and burnTxHints`);
  }
  // Absent is "none"; anything else, null included, must be the documented shape.
  const hashes = value.preLedgerDecisionHashes === undefined ? [] : value.preLedgerDecisionHashes;
  if (!Array.isArray(hashes)) return bad(`${where}.preLedgerDecisionHashes is not a list`);
  hashes.forEach((h, i) => {
    if (typeof h !== "string" || !HEX32.test(h)) {
      bad(`${where}.preLedgerDecisionHashes[${i}] is not 64 lowercase hex digits`);
    }
  });
  const hints = value.burnTxHints === undefined ? {} : value.burnTxHints;
  if (!isObject(hints)) return bad(`${where}.burnTxHints is not an object keyed by spend id`);
  const burnTxHints = new Map<number, BurnHint[]>();
  for (const [id, list] of Object.entries(hints)) {
    if (!SPEND_ID.test(id) || !Number.isSafeInteger(Number(id))) {
      bad(`${where}.burnTxHints has a key that is not a spend id`);
    }
    if (!Array.isArray(list)) return bad(`${where}.burnTxHints[${id}] is not a list`);
    burnTxHints.set(
      Number(id),
      list.map((h, i) => hint(h, `${where}.burnTxHints[${id}][${i}]`)),
    );
  }
  return { preLedgerDecisionHashes: [...(hashes as Hex32[])], burnTxHints };
}

/**
 * The file's entries by "<network>:<vault>". Anything that is not exactly the documented shape throws a
 * `ProofEvidenceError`, whose message names the place, never the value.
 */
export function parseProofEvidence(raw: unknown): Map<string, VaultEvidence> {
  if (!isObject(raw)) return bad("the file is not a JSON object");
  const out = new Map<string, VaultEvidence>();
  Object.entries(raw).forEach(([key, value], i) => {
    const m = KEY.exec(key);
    if (m === null || !isNearAccountId(m[2])) {
      bad(`key ${i + 1} is not "<network>:<vault>" with network mainnet or testnet`);
    }
    out.set(key, vaultEvidence(value, `"${key}"`));
  });
  return out;
}

/**
 * The evidence for `vault` on `network`: what the file holds under exactly that key, else nothing. The SDK applies
 * pre-ledger hashes to v0.probarion.near on mainnet only, whatever is passed. Throws on a malformed file.
 */
export function evidenceFor(raw: unknown, network: Network, vault: string): VaultEvidence {
  return (
    parseProofEvidence(raw).get(`${network}:${vault}`) ?? {
      preLedgerDecisionHashes: [],
      burnTxHints: new Map(),
    }
  );
}
