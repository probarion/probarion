import type { LedgerEntry } from "@probarion/core";
import type { SpendOutcome } from "@probarion/sdk";
import { seqAnchorId, spendAnchorId } from "./decisions";

// The audit link of one Payables cycle (G4): the address of its decision's card on the vault's proof page. The page
// gives each decision id="seq-N" and, for each on-chain spend bound to it, id="spend-N" (lib/proof/decisions.ts).
// The newest decisions have their full card on the page; an older one shows its summary line, with a link to the
// same page with ?seq=N, where its full card is.

const isId = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** At most nine digits, with no leading zero: a ledger position, never a number JavaScript cannot hold. */
const SEQ_PARAM = /^(0|[1-9][0-9]{0,8})$/;

/** The same page with the full card of decision `seq`, scrolled to it: "?seq=N#seq-N". */
export const fullCardHref = (seq: number): string => `?seq=${seq}#${seqAnchorId(seq)}`;

/** The seq a `?seq=` parameter names, or null for anything else (none, repeated, or not a plain number). */
export function fullCardSeq(param: unknown): number | null {
  return typeof param === "string" && SEQ_PARAM.test(param) ? Number(param) : null;
}

/**
 * `/proof/<vault>#spend-N` for a cycle whose spend the contract created, else `/proof/<vault>#seq-N` by its decision
 * entry in `entries`. Null when the outcome names neither (no spend, and no decision entry in the ledger read). The
 * caller shows it only when the vault's proof page is public.
 */
export function proofAuditHref(
  vault: string,
  entries: readonly LedgerEntry[] | null,
  outcome: Pick<SpendOutcome, "spendId" | "decisionHash">,
): string | null {
  const page = `/proof/${encodeURIComponent(vault)}`;
  if (isId(outcome.spendId)) return `${page}#${spendAnchorId(outcome.spendId)}`;
  const decision = (entries ?? []).find(
    (e) => e.body_hash === outcome.decisionHash && e.body.kind === "decision",
  );
  return decision && isId(decision.body.seq) ? `${page}#${seqAnchorId(decision.body.seq)}` : null;
}
