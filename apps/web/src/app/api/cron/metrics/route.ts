import { cronAuthorized } from "@/lib/cron";
import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { json, problem } from "@/lib/http";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAY_MS = 86_400_000;

/** A UTC day as YYYY-MM-DD. */
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

interface Run {
  day: string;
  network: string;
  rows: number;
}

/**
 * The daily run of the usage numbers (vercel.json): it computes yesterday, which is complete by now, and today, which
 * is still going, for the network this app runs on. Each run replaces that day's rows, so a second run does no harm.
 * The page also refreshes its own numbers when they are an hour old (lib/usage/data.ts), so this is the floor and not
 * the only way they move. A call without the bearer secret is a 401. The log has the counts of rows and nothing else.
 */
export async function GET(req: Request) {
  try {
    const env = getEnv();
    if (!cronAuthorized(req, env.CRON_SECRET)) return problem(401, "unauthorized");
    const now = Date.now();
    const days = [utcDay(now - DAY_MS), utcDay(now)];
    const db = serviceDb();
    const results: Run[] = [];
    for (const day of days) {
      results.push(await db.rpc<Run>("metrics_compute", { network: env.NEAR_NETWORK, day }));
    }
    log.info("cron.metrics", {
      network: env.NEAR_NETWORK,
      days,
      rows: results.map((r) => r.rows),
    });
    return json({ ok: true, network: env.NEAR_NETWORK, results });
  } catch (error) {
    // The database or a missing setting: a failed run for the cron's log, and never an unhandled 500.
    log.error("cron.metrics_failed", { error });
    return problem(503, "unavailable");
  }
}
