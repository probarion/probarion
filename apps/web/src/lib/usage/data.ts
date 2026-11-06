import "server-only";
import { unstable_cache } from "next/cache";
import type { Network } from "@/lib/config";
import { publicDb, serviceDb } from "@/lib/db/clients";
import { log } from "@/lib/log";
import { within } from "@/lib/within";
import { parseUsage, type UsageMetrics } from "./parse";

// What the Usage page reads from the database, behind Next's data cache.
//
// The read and the refresh live in the same cache entry (a minute), so the refresh runs at most about once a minute
// however many people look, and in practice about once an hour: it runs only when the network was last computed more
// than an hour ago (its run record, metrics_runs). A refresh that fails (no service key in a preview, a timeout, an
// error) shows what exists. A read that fails is cached too, as an absent answer, for the same minute: a database in
// trouble is asked once a minute, not once a view.
//
// The parsing is outside the cache, so that a reader of this file never sees a stale shape. Nothing here throws: a
// read that fails, hangs past `READ_TIMEOUT_MS` or is lost by the cache layer itself is a null, with a warning, and
// so is an answer the page cannot show (`usage.malformed`: the message and the network, never the answer).

export const USAGE_REVALIDATE_S = 60;
/** The numbers are refreshed when the network was last computed longer ago than this, or never. */
export const STALE_AFTER_MS = 60 * 60_000;
/** How long one step may take. The page waits on it, so a hung database must not hold a visitor for long. */
export const READ_TIMEOUT_MS = 5000;
/** The "last 7 days" beside each total. */
const RECENT_DAYS = 7;

const warn = (msg: string, error: unknown) =>
  log.warn(msg, { error: error instanceof Error ? error.message : String(error) });

/** Older than `STALE_AFTER_MS`, or never computed. An answer that is not an answer is not judged: the parser refuses it. */
function isStale(raw: unknown, now: number): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const updated = (raw as { updated_at?: unknown }).updated_at;
  if (typeof updated !== "string") return true;
  const at = Date.parse(updated);
  return Number.isNaN(at) || now - at > STALE_AFTER_MS;
}

const read = (network: Network): Promise<unknown> =>
  within(
    () => publicDb().rpc<unknown>("public_usage_metrics", { network, days: RECENT_DAYS }),
    READ_TIMEOUT_MS,
  );

/** Computes today for `network`, then reads again: one step with one time limit. */
const refresh = (network: Network): Promise<unknown> =>
  within(async () => {
    const day = new Date().toISOString().slice(0, 10);
    await serviceDb().rpc("metrics_compute", { network, day });
    return publicDb().rpc<unknown>("public_usage_metrics", { network, days: RECENT_DAYS });
  }, READ_TIMEOUT_MS);

/** The raw answer, refreshed when it is stale, or null when it could not be read. */
const readUsage = unstable_cache(
  async (network: Network): Promise<unknown> => {
    try {
      const first = await read(network);
      if (!isStale(first, Date.now())) return first;
      try {
        return await refresh(network);
      } catch (error) {
        warn("usage.refresh_failed", error);
        return first;
      }
    } catch (error) {
      warn("usage.unavailable", error);
      return null;
    }
  },
  ["usage-metrics"],
  { revalidate: USAGE_REVALIDATE_S },
);

/** The usage numbers of `network`, or null when they cannot be read or are malformed. Never throws. */
export async function loadUsage(network: Network): Promise<UsageMetrics | null> {
  try {
    const raw = await readUsage(network);
    const usage = parseUsage(raw, network);
    // An answer that is there and cannot be shown: a shape, or a network, that drifted. It is logged, so that a drift
    // after a deploy is seen. A read that failed (a null answer) already said so.
    if (raw !== null && usage === null) {
      log.warn("usage.malformed", {
        network,
        reason: "the answer is malformed or is for another network",
      });
    }
    return usage;
  } catch (error) {
    // The cache layer itself failed (its own storage, not the database): still a page, not a 500.
    warn("usage.unavailable", error);
    return null;
  }
}
