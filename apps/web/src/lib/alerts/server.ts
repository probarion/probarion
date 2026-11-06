import "server-only";
import { appOrigin } from "@/lib/config";
import { subkey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { type DispatchResult, dispatchAlerts, type Senders } from "./dispatch";
import { resendSender } from "./email";
import { stopLinks } from "./stop";
import { sendTelegram } from "./telegram";

/** The channels this deployment can send on: a provider with no token or key here has no sender. */
export function alertSenders(): Senders {
  const env = getEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  return {
    telegram: token ? (chatId, text) => sendTelegram(token, chatId, text) : null,
    email: env.RESEND_API_KEY ? resendSender(env.RESEND_API_KEY) : null,
  };
}

export type AlertsRun = DispatchResult & { error: boolean };

/**
 * One dispatch for this deployment, until `deadline` (epoch ms). It never throws and never reports more than counts: the
 * watcher's route and kicks call it after the watch, and a failure here must not change the watch's health or its
 * heartbeat. A failure is logged (`alerts.dispatch_failed`) and answered as `error: true` with zero counts.
 */
export async function runAlerts(deadline: number): Promise<AlertsRun> {
  try {
    const origin = appOrigin();
    const result = await dispatchAlerts({
      db: serviceDb(),
      senders: alertSenders(),
      network: getEnv().NEAR_NETWORK,
      origin,
      stopLinks: async (id) => stopLinks(origin, await subkey("alerts"), id),
      deadline,
    });
    return { ...result, error: false };
  } catch (error) {
    log.error("alerts.dispatch_failed", { error });
    return { sent: 0, failed: 0, skipped: 0, deferred: 0, error: true };
  }
}
