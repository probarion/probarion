// The recorded mainnet payouts (mainnet-payout-recorded.json, written by scripts/record-mainnet-payout.ts) for the
// server render: what the #mainnet section shows with no JavaScript and no network. The client component takes a
// payout and its recorded outcomes as props, so this module and the JSON stay out of its bundle.
import {
  type CheckOutcome,
  evaluateAll,
  type Payout,
  type RecordedFile,
  recordedReads,
  type Tally,
  tally,
} from "./mainnet-payout";
import recordedJson from "./mainnet-payout-recorded.json";

export const RECORDED = recordedJson as unknown as RecordedFile;

/** One per mainnet payout to Base in docs/mainnet-proof.json, from the oldest. The section maps this array. */
export const PAYOUTS: readonly Payout[] = RECORDED.payouts.map((r) => r.payout);

export interface RecordedRun {
  payout: Payout;
  /** The seven checks on the recorded reads, in CHECKS order. */
  outcomes: CheckOutcome[];
  tally: Tally;
  /** When the recorder read the chain, ISO. */
  recordedAt: string;
}

export const RECORDED_RUNS: readonly RecordedRun[] = RECORDED.payouts.map((r) => {
  const outcomes = evaluateAll(recordedReads(r), r.payout);
  return { payout: r.payout, outcomes, tally: tally(outcomes), recordedAt: RECORDED.recordedAt };
});
