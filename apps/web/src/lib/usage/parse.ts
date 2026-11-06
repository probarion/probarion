// The shape of what the Usage page reads from the database: `public_usage_metrics` (migration 0009), checked here before
// a number or a word of it reaches the page, so a changed or damaged answer shows "not available" and never a wrong
// figure. An answer for another network than the one asked is refused too: a testnet number must not read as mainnet.
import { isRecord } from "@/lib/canary/format";
import type { Network } from "@/lib/config";
import { SEGMENTS, type SegmentCounts, USAGE_METRICS, type UsageTotal } from "./view";

export interface UsageMetrics {
  network: Network;
  /** Every computed day added up. */
  totals: UsageTotal[];
  /** The last 7 days. */
  recent: UsageTotal[];
  /** Outside Canary visitors: the smaller of the distinct browsers and the distinct addresses. */
  canary_participants: number;
  external_owners: number;
  team_vaults: number;
  pilots: SegmentCounts;
  /** Pilots who agreed in writing to be named. */
  pilot_names: string[];
  /** When the newest row was written, or null before the first run. */
  updated_at: string | null;
}

/** The metrics the page draws: its table's rows, and the token counters behind the unit costs. */
const SHOWN: ReadonlySet<string> = new Set([
  ...USAGE_METRICS.map(([metric]) => metric),
  "nearai_tokens_in",
  "nearai_tokens_out",
]);
const SEGMENT_NAMES: ReadonlySet<string> = new Set(SEGMENTS);

/** A count: a whole number, zero or more. */
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A database numeric arrives as a number, or as a string of one. Zero or more, and finite. */
function toValue(v: unknown): number | null {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The rows of a list, or null when one of them is malformed (a table with a row missing would be a wrong one). A row of
 * a segment or a metric this page does not draw is not malformed: a newer database may have more, and it is left out.
 */
function parseRows(list: unknown): UsageTotal[] | null {
  if (!Array.isArray(list)) return null;
  const out: UsageTotal[] = [];
  for (const row of list) {
    if (!isRecord(row) || typeof row.segment !== "string" || typeof row.metric !== "string")
      return null;
    const value = toValue(row.value);
    if (value === null) return null;
    if (SEGMENT_NAMES.has(row.segment) && SHOWN.has(row.metric)) {
      out.push({ segment: row.segment, metric: row.metric, value });
    }
  }
  return out;
}

function parsePilots(list: unknown): SegmentCounts | null {
  if (!Array.isArray(list)) return null;
  const out: SegmentCounts = { team: 0, external: 0, canary: 0 };
  for (const row of list) {
    if (!isRecord(row) || typeof row.cohort !== "string" || !isCount(row.n)) return null;
    if (row.cohort === "team" || row.cohort === "external" || row.cohort === "canary") {
      out[row.cohort] += row.n;
    }
  }
  return out;
}

function parseNames(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const name of list) {
    if (typeof name !== "string") return null;
    if (name.trim() !== "") out.push(name.trim());
  }
  return out;
}

/** The answer for `network`, or null when it is for another network or anything in it is malformed. */
export function parseUsage(json: unknown, network: Network): UsageMetrics | null {
  if (!isRecord(json) || json.network !== network) return null;
  const { canary_participants, external_owners, team_vaults, updated_at } = json;
  if (!isCount(canary_participants) || !isCount(external_owners) || !isCount(team_vaults))
    return null;
  if (
    updated_at !== null &&
    (typeof updated_at !== "string" || Number.isNaN(Date.parse(updated_at)))
  ) {
    return null;
  }
  const totals = parseRows(json.totals);
  const recent = parseRows(json.recent);
  const pilots = parsePilots(json.pilots);
  const pilot_names = parseNames(json.pilot_names);
  if (totals === null || recent === null || pilots === null || pilot_names === null) return null;
  return {
    network,
    totals,
    recent,
    canary_participants,
    external_owners,
    team_vaults,
    pilots,
    pilot_names,
    updated_at: updated_at ?? null,
  };
}
