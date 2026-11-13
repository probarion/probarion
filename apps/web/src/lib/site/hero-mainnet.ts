// The hero's mainnet card (HERO.s2): the newest recorded payout that an attested model proposed and the code rules
// allowed, filled from the recorded payouts (mainnet-payout-recorded.json) alone, so the card says only what the record
// holds. The words are in facts.ts; this file picks the payout and fills the braces.
import { type CopyPart, HERO, mainnetTxFact, type TxFact } from "./facts";
import { fill, type Payout, shortAddr, usdc } from "./mainnet-payout";
import { PAYOUTS } from "./mainnet-payout-data";

export interface HeroMainnetView {
  /** The payout's id: the #mainnet stone whose check the card's link starts. */
  payoutId: string;
  aria: string;
  label: string;
  state: string;
  big: string;
  vault: string;
  payee: string;
  arrived: string;
  model: string;
  tx: TxFact;
  read: { label: string; href: string };
  stepsLabel: string;
  steps: string[];
  tee: readonly CopyPart[];
}

/** The decision of a payout that an attested model proposed and the code rules allowed, if it has one. */
export function proposedBy(p: Payout): string | null {
  const e = p.trail.find(
    (x) =>
      x.kind === "decision" &&
      x.verdict === "allow" &&
      x.decidedBy === "model+rules" &&
      x.attested &&
      x.model !== null,
  );
  return e?.model ?? null;
}

/** The card, from the newest payout an attested model proposed; null when no recorded payout was. */
export function heroMainnet(payouts: readonly Payout[] = PAYOUTS): HeroMainnetView | null {
  const p = [...payouts]
    .filter((x) => proposedBy(x) !== null)
    .sort((a, b) => b.pin.at.localeCompare(a.pin.at) || b.spendId - a.spendId)[0];
  if (p === undefined) return null;
  const C = HERO.s2;
  const vars = {
    date: p.date,
    amount: usdc(p.amount),
    received: usdc(p.received),
    payee: shortAddr(p.payee),
    model: proposedBy(p) ?? "",
  };
  return {
    payoutId: p.id,
    aria: C.aria,
    label: fill(C.label, vars),
    state: C.state,
    big: fill(C.big, vars),
    vault: p.vault,
    payee: fill(C.rows.payeeText, vars),
    arrived: fill(C.rows.arrivedText, vars),
    model: fill(C.rows.modelText, vars),
    tx: mainnetTxFact(p.tx.spend.hash),
    read: C.read,
    stepsLabel: C.steps.label,
    steps: C.steps.items.map((s) => fill(s, vars)),
    tee: C.tee,
  };
}
