// One ledger per vault. A vault has one hash-chained ledger; a second writer with its own ledger file forks
// it, and verify check c then fails for the ranges the other file anchored. Before a spend, the server checks
// that this machine's ledger holds every entry the vault's latest on-chain anchor covers, with the same root at
// that count. That catches another writer once it has anchored; one that has not anchored yet is caught later,
// by verify check d (a decision in this ledger behind every spend). It also checks that every entry after that
// anchor is signed by its own ledger key: the vault's next anchor covers them under that key, and verify check a
// fails for an entry in its range that another key signed (a keys file swapped while the ledger file stayed).
import type { ProbarionPort } from "./port.js";

/** LEDGER_FORK_RISK: the ledger the vault anchored is not this file. LEDGER_KEY_MISMATCH: another key signed its tail. */
export type LedgerForkCode = "LEDGER_FORK_RISK" | "LEDGER_KEY_MISMATCH";

export class LedgerForkError extends Error {
  readonly code: LedgerForkCode;
  constructor(code: LedgerForkCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

export interface AnchorLite {
  seq: number;
  root: string;
  count: number;
}
/** What the guard reads of a ledger entry: its link, and the public key that signed it. */
export interface LedgerEntryLite {
  link: string;
  signer: string;
}
export interface LedgerReader {
  all(): Promise<readonly LedgerEntryLite[]>;
}
export type LatestAnchor = () => Promise<AnchorLite | null>;

const FORK_HELP =
  "Another process writes this vault's ledger. Use one ledger per vault: give this server its own vault, or point PROBARION_LEDGER_PATH at the ledger file the other process uses on this machine. Nothing was sent.";

/** A signer as a message may show it: a public key, or a stand-in for a value that is not one. */
export function signerShown(signer: unknown): string {
  return typeof signer === "string" && /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signer)
    ? signer
    : "a value that is not a public key";
}

/**
 * Why this machine's ledger may not take the server's next entry, or null when it may. `ledgerPublicKey` is the public
 * key the server signs entries with; null skips the signer check (a server with no keys appends nothing). Pure.
 */
export function singleWriterProblem(
  entries: readonly LedgerEntryLite[],
  last: AnchorLite | null,
  ledgerPublicKey: string | null,
): LedgerForkError | null {
  const anchored = last === null ? 0 : last.count;
  if (last !== null && last.count > 0) {
    if (last.count > entries.length) {
      return new LedgerForkError(
        "LEDGER_FORK_RISK",
        `anchor ${last.seq} covers ${last.count} entries but the local ledger has ${entries.length}. ${FORK_HELP}`,
      );
    }
    if (entries[last.count - 1]?.link !== last.root) {
      return new LedgerForkError(
        "LEDGER_FORK_RISK",
        `anchor ${last.seq} does not match local entry ${last.count - 1}. ${FORK_HELP}`,
      );
    }
  }
  if (ledgerPublicKey === null) return null;
  const tail = entries.slice(anchored);
  const first = tail.findIndex((e) => e.signer !== ledgerPublicKey);
  if (first === -1) return null;
  const foreign = tail.filter((e) => e.signer !== ledgerPublicKey).length;
  const after =
    last === null || last.count === 0 ? "the vault has no anchor yet" : `after anchor ${last.seq}`;
  return new LedgerForkError(
    "LEDGER_KEY_MISMATCH",
    `${foreign} of the ${tail.length} unanchored entries in the local ledger (${after}) are signed by another ledger key than this server's, ${ledgerPublicKey}: entry ${anchored + first} by ${signerShown(tail[first]?.signer)}. The vault's next anchor would cover them under this server's key, and verify check a would fail for them. Anchor them first with the key that signed them, while it is the vault's ledger key, and only then have the owner set this server's key. Nothing was sent.`,
  );
}

/** Throws the guard's LedgerForkError when this machine's ledger may not take the server's next entry. */
export async function assertSingleWriter(
  ledger: LedgerReader,
  latest: LatestAnchor,
  ledgerPublicKey: string | null = null,
): Promise<void> {
  const last = await latest();
  if (ledgerPublicKey === null && (last === null || last.count === 0)) return;
  const problem = singleWriterProblem(await ledger.all(), last, ledgerPublicKey);
  if (problem !== null) throw problem;
}

/**
 * The port with the check in front of `requestSpend`; every read passes straight through. `ledgerPublicKey` is the
 * public half of the key the server signs ledger entries with, or null in read-only mode.
 */
export function withSingleWriterGuard(
  port: ProbarionPort,
  ledger: LedgerReader,
  latest: LatestAnchor,
  ledgerPublicKey: string | null = null,
): ProbarionPort {
  return {
    listMandates: () => port.listMandates(),
    checkSpend: (input) => port.checkSpend(input),
    requestSpend: async (input) => {
      await assertSingleWriter(ledger, latest, ledgerPublicKey);
      return port.requestSpend(input);
    },
    getSpend: (spendId) => port.getSpend(spendId),
    findSpendByRef: (ref) => port.findSpendByRef(ref),
    verify: () => port.verify(),
  };
}
