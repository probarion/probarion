import { getEnv } from "@/lib/env";
import { HEALTH_CACHE_MS, SERVICE } from "@/lib/health";
import { json } from "@/lib/http";
import { log } from "@/lib/log";
import { softRequestNetwork } from "@/lib/network";

export const dynamic = "force-dynamic";

/**
 * When this instance last logged a settings failure as an error, which the console bridge turns into a Sentry event.
 * Anyone can call this route, so a broken deployment reports it at most once per 30 s per instance; the repeats are
 * warnings, which stay in the logs and spend no Sentry quota.
 */
let settingsReportedAt = Number.NEGATIVE_INFINITY;

/**
 * Liveness for the uptime monitor: 200 when this deployment can read its settings, else 503 `settings` (the log line
 * names the variable; the body names nothing). The network is the address's, so a monitor per address also catches a
 * wrong APP_ORIGIN_<NET>. It calls no other service.
 */
export async function GET(): Promise<Response> {
  const base = {
    service: SERVICE,
    network: await softRequestNetwork(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || null,
    time: new Date().toISOString(),
  };
  try {
    getEnv();
  } catch (error) {
    const now = Date.now();
    if (now - settingsReportedAt >= HEALTH_CACHE_MS) {
      settingsReportedAt = now;
      log.error("health.settings_invalid", { error });
    } else {
      log.warn("health.settings_invalid", { error });
    }
    return json({ ok: false, ...base, detail: "settings" }, 503);
  }
  return json({ ok: true, ...base });
}
