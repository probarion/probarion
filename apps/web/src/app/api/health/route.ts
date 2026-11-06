import { getEnv } from "@/lib/env";
import { SERVICE } from "@/lib/health";
import { json } from "@/lib/http";
import { log } from "@/lib/log";
import { softRequestNetwork } from "@/lib/network";

export const dynamic = "force-dynamic";

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
    log.error("health.settings_invalid", { error });
    return json({ ok: false, ...base, detail: "settings" }, 503);
  }
  return json({ ok: true, ...base });
}
