// What the Usage page shows, as plain functions of the numbers the database gives: the table of counts (all time, with
// the last 7 days beside each), and the unit costs. Nothing here reads a setting or the database.

export type Segment = "team" | "external" | "canary";
export const SEGMENTS: readonly Segment[] = ["team", "external", "canary"];

export interface UsageTotal {
  segment: Segment | string;
  metric: string;
  /** A database numeric can arrive as a string. */
  value: number | string;
}

/** The rows of the table, in the order of the page: [metric, label, shown under the row above it]. */
export const USAGE_METRICS = [
  ["vaults", "Vaults", false],
  ["mandates", "Mandates signed", false],
  ["spends_paid", "Payments made", false],
  ["cross_chain_payouts", "of which cross-chain (Base)", true],
  ["held", "Held for approval", false],
  ["refused_by_code", "Refused by code", false],
  ["refused_by_contract", "Refused on chain", false],
  ["canary_attempts", "Canary attempts", false],
  ["canary_raw_attempts", "Canary attempts sent straight to the contract", false],
  ["model_decisions", "Model decisions", false],
] as const satisfies readonly (readonly [string, string, boolean])[];

export type SegmentCounts = Record<Segment, number>;

export interface UsageRow {
  metric: string;
  label: string;
  /** Drawn under the row above it: a part of that row, not a row of its own. */
  indent: boolean;
  team: number;
  external: number;
  canary: number;
  /** The same three counts for the last 7 days. */
  week: SegmentCounts;
}

/** The sum of a segment's rows for a metric: zero when it has none. */
const sum = (totals: readonly UsageTotal[], segment: Segment, metric: string): number =>
  totals.reduce(
    (n, t) => (t.segment === segment && t.metric === metric ? n + Number(t.value) : n),
    0,
  );

const counts = (totals: readonly UsageTotal[], metric: string): SegmentCounts => ({
  team: sum(totals, "team", metric),
  external: sum(totals, "external", metric),
  canary: sum(totals, "canary", metric),
});

/** Every metric in three separate columns, zero-filled, each with its last 7 days (`recent`, zero when not given). */
export function buildUsageTable(
  totals: readonly UsageTotal[],
  recent: readonly UsageTotal[] = [],
): UsageRow[] {
  return USAGE_METRICS.map(([metric, label, indent]) => ({
    metric,
    label,
    indent,
    ...counts(totals, metric),
    week: counts(recent, metric),
  }));
}

export interface PerDecision {
  tokensPerDecision: number | null;
  usdPerDecision: number | null;
}

/**
 * Model tokens per model decision, from what the model reported, and the dollar cost only when a price is given.
 * A segment with no model decision has neither, and neither has one whose decisions came with no tokens measured:
 * nothing measured is not zero tokens.
 */
export function perDecision(
  totals: readonly UsageTotal[],
  segment: Segment,
  price: { inputPerMTok: number; outputPerMTok: number; model?: string; source?: string } | null,
): PerDecision {
  const v = (metric: string) => sum(totals, segment, metric);
  const decisions = v("model_decisions");
  const tin = v("nearai_tokens_in");
  const tout = v("nearai_tokens_out");
  if (decisions === 0 || tin + tout === 0) return { tokensPerDecision: null, usdPerDecision: null };
  return {
    tokensPerDecision: (tin + tout) / decisions,
    usdPerDecision: price
      ? (tin * price.inputPerMTok + tout * price.outputPerMTok) / 1e6 / decisions
      : null,
  };
}
