import { cronAuthorized } from "@/lib/cron";
import { getEnv } from "@/lib/env";
import { json, problem } from "@/lib/http";
import { log } from "@/lib/log";
import { watcherDeps } from "@/lib/watcher/server";
import { pingHeartbeat, watchAll, watchHealthy } from "@/lib/watcher/watch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One watcher run (docs/ops/watcher.md): every tenant of the network the app runs on is read from its cursors into
 * `vault_events`, the tenants looked at longest ago first, and no new tenant is started 40 s in. The Better Stack
 * heartbeat goes out after a healthy run (no tenant, or one that was tried and did not fail), so a dead cron or an
 * unreadable chain raises the alarm; a run where every tenant that was tried failed is a 503 that still says what it
 * did. A call without the bearer secret is a 401. The log has the counts and nothing else: no event data, and not the
 * heartbeat address, which carries a token.
 *
 * `vercel.json` runs it once a day, the most the Vercel Hobby plan accepts; the per-minute schedule is a Supabase Cron
 * job the OWNER turns on, and the Payables and Canary routes also watch their own vault as soon as they respond.
 */
export async function GET(req: Request) {
  try {
    const env = getEnv();
    if (!cronAuthorized(req, env.CRON_SECRET)) return problem(401, "unauthorized");
    const started = Date.now();
    const run = await watchAll(watcherDeps());
    const watch = {
      tenants: run.tenants,
      inserted: run.inserted,
      errors: run.errors,
      skipped: run.skipped,
    };
    const healthy = watchHealthy(run);
    const heartbeat = await pingHeartbeat(env.BETTERSTACK_HEARTBEAT_URL, healthy);
    log.info("cron.watch", {
      network: env.NEAR_NETWORK,
      ...watch,
      healthy,
      heartbeat,
      ms: Date.now() - started,
    });
    return json({ ok: healthy, network: env.NEAR_NETWORK, watch, heartbeat }, healthy ? 200 : 503);
  } catch (error) {
    // The database or a missing setting: a failed run for the cron's log, and never an unhandled 500.
    log.error("cron.watch_failed", { error });
    return problem(503, "unavailable");
  }
}
