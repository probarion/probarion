// One ledger per vault. A vault has one hash-chained ledger; a second writer with its own ledger file forks
// it, and verify check c then fails for the ranges the other file anchored. Before a spend, the server checks
// that this machine's ledger holds every entry the vault's latest on-chain anchor covers, with the same root at
// that count. That catches another writer once it has anchored; one that has not anchored yet is caught later,
// by verify check d (a decision in this ledger behind every spend).
import type { ProbarionPort } from "./port.js";

export class LedgerForkError extends Error {}

export interface AnchorLite {
  seq: number;
  root: string;
  count: number;
}
export interface LedgerReader {
  all(): Promise<readonly { link: string }[]>;
}
export type LatestAnchor = () => Promise<AnchorLite | null>;

const HELP =
  "Another process writes this vault's ledger. Use one ledger per vault: give this server its own vault, or point PROBARION_LEDGER_PATH at the ledger file the other process uses on this machine. Nothing was sent.";

export async function assertSingleWriter(
  ledger: LedgerReader,
  latest: LatestAnchor,
): Promise<void> {
  const last = await latest();
  if (last === null || last.count === 0) return;
  const entries = await ledger.all();
  if (last.count > entries.length) {
    throw new LedgerForkError(
      `LEDGER_FORK_RISK: anchor ${last.seq} covers ${last.count} entries but the local ledger has ${entries.length}. ${HELP}`,
    );
  }
  if (entries[last.count - 1]?.link !== last.root) {
    throw new LedgerForkError(
      `LEDGER_FORK_RISK: anchor ${last.seq} does not match local entry ${last.count - 1}. ${HELP}`,
    );
  }
}

/** The port with the check in front of `requestSpend`; every read passes straight through. */
export function withSingleWriterGuard(
  port: ProbarionPort,
  ledger: LedgerReader,
  latest: LatestAnchor,
): ProbarionPort {
  return {
    listMandates: () => port.listMandates(),
    checkSpend: (input) => port.checkSpend(input),
    requestSpend: async (input) => {
      await assertSingleWriter(ledger, latest);
      return port.requestSpend(input);
    },
    getSpend: (spendId) => port.getSpend(spendId),
    findSpendByRef: (ref) => port.findSpendByRef(ref),
    verify: () => port.verify(),
  };
}
