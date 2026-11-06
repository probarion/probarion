import { type AlertsRun, runAlerts } from "@/lib/alerts/server";
import type { Network } from "@/lib/config";
import { cronAuthorized } from "@/lib/cron";
import { getEnv } from "@/lib/env";
import { json, problem } from "@/lib/http";
import { log } from "@/lib/log";
import { watcherDeps } from "@/lib/watcher/server";
import {
  pingHeartbeat,
  WATCH_BUDGET_MS,
  type WatchRun,
  watchAll,
  watchHealthy,
} from "@/lib/watcher/watch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Alerts are claimed until this long after the route started: `maxDuration` is 60 s and one send can take seconds. */
const ALERTS_DEADLINE_MS = 55_000;
const DISPATCH_FAILED: AlertsRun = { sent: 0, failed: 0, skipped: 0, deferred: 0, error: true };

/** What one network's watch did, as the answer and the log say it: counts and nothing else. */
type WatchCounts = Pick<WatchRun, "tenants" | "inserted" | "errors" | "skipped" | "checkErrors">;

/** The time one of the `remaining` networks not yet run gets from what is left, so an idle network passes its time on. */
function share(left: number, remaining: number): number {
  return Math.max(0, left) / Math.max(1, remaining);
}

interface Done {
  network: Network;
  /** Null when the watch itself could not run (the tenants could not be listed). */
  watch: WatchCounts | null;
  healthy: boolean;
}

/**
 * One watcher run (docs/ops/watcher.md): every tenant of every network this site serves, mainnet first, is read from its
 * cursors into `vault_events`, the tenants looked at longest ago first, and no new tenant is started 40 s into the run.
 * The 40 s are shared: each network gets what is left divided by the networks not yet run, so a network with nothing to
 * do passes its time on. Every network is watched before any alert goes out, and one network failing (its tenants
 * cannot be listed) does not stop the other. The Better Stack heartbeat goes out after the watches, only when every
 * network's watch was healthy (no tenant, or one that was tried and did not fail), so a dead cron or an unreadable chain
 * raises the alarm; a run where a network's watch was not healthy is a 503 that still says what it did. `checkErrors`
 * counts the best-effort checks that failed (a key's allowance, the vault's NEAR): each is a warning in the log, and none
 * is part of health or of the heartbeat. A call without the bearer secret is a 401. The log has the counts and nothing
 * else: no event data, and not the heartbeat address, which carries a token.
 *
 * `vercel.json` runs it once a day, the most the Vercel Hobby plan accepts; the per-minute schedule is a Supabase Cron
 * job the OWNER turns on, and the Payables and Canary routes also watch their own vault as soon as they respond.
 *
 * The owners' alerts (docs/ops/alerts.md) go out after the heartbeat, one network after the other, each until its share
 * of the time left to 55 s after the route started; what the deadline leaves waits for the next run. A dispatch that fails
 * is a log line and `alerts.error` in the answer: it never changes the watch's health, its status or its heartbeat, and
 * it runs after an unhealthy watch too, because the events already recorded are still worth sending.
 */
export async function GET(req: Request) {
  try {
    const env = getEnv();
    if (!cronAuthorized(req, env.CRON_SECRET)) return problem(401, "unauthorized");
    const started = Date.now();
    const networks = env.enabledNetworks;

    // Every network is watched first.
    const done: Done[] = [];
    for (const [i, network] of networks.entries()) {
      const budgetMs = share(WATCH_BUDGET_MS - (Date.now() - started), networks.length - i);
      try {
        const run = await watchAll(watcherDeps(network), budgetMs);
        done.push({
          network,
          watch: {
            tenants: run.tenants,
            inserted: run.inserted,
            errors: run.errors,
            skipped: run.skipped,
            checkErrors: run.checkErrors,
          },
          healthy: watchHealthy(run),
        });
      } catch (error) {
        // The database or a missing setting for this network: the other network's watch still runs.
        log.error("cron.watch_failed", { network, error });
        done.push({ network, watch: null, healthy: false });
      }
    }
    // Nothing could be watched at all: the same failed run (no alerts, no heartbeat) as one network that cannot be read.
    if (done.every((d) => d.watch === null)) return problem(503, "unavailable");

    const healthy = done.every((d) => d.healthy);
    const heartbeat = await pingHeartbeat(env.BETTERSTACK_HEARTBEAT_URL, healthy);

    // Then the alerts, a network at a time, each until its share of what is left to the 55 s.
    const entries: {
      network: Network;
      watch: WatchCounts | { error: true };
      alerts: AlertsRun | null;
    }[] = [];
    for (const [i, d] of done.entries()) {
      let alerts: AlertsRun | null = null;
      if (d.watch !== null) {
        const deadline =
          Date.now() + share(started + ALERTS_DEADLINE_MS - Date.now(), done.length - i);
        // runAlerts does not throw; the catch is for the day somebody changes that, and the watch's answer must stand.
        alerts = await runAlerts(d.network, deadline).catch(() => DISPATCH_FAILED);
      }
      entries.push({ network: d.network, watch: d.watch ?? { error: true }, alerts });
    }
    log.info("cron.watch", { networks: entries, healthy, heartbeat, ms: Date.now() - started });
    return json({ ok: healthy, networks: entries, heartbeat }, healthy ? 200 : 503);
  } catch (error) {
    // The database or a missing setting: a failed run for the cron's log, and never an unhandled 500.
    log.error("cron.watch_failed", { error });
    return problem(503, "unavailable");
  }
}
