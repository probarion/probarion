import "server-only";
import type { Network } from "@/lib/config";
import { subkey } from "@/lib/crypto/server";
import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { originFor } from "@/lib/network";
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
 * One dispatch for one network, until `deadline` (epoch ms). It never throws and never reports more than counts: the
 * watcher's route and kicks call it after the watch, and a failure here must not change the watch's health or its
 * heartbeat. A failure is logged (`alerts.dispatch_failed`) and answered as `error: true` with zero counts.
 *
 * Every link in a message (the console's and the stop link) is on `originFor(network)`, the address that network is
 * served at. A network this site does not serve has no address to link to, so nothing is sent for it: its alerts wait
 * until it is served (the routes only ever call this for a network they serve).
 */
export async function runAlerts(network: Network, deadline: number): Promise<AlertsRun> {
  try {
    const origin = originFor(network, getEnv());
    if (origin === null) {
      log.warn("alerts.network_not_served", { network });
      return { sent: 0, failed: 0, skipped: 0, deferred: 0, error: false };
    }
    const result = await dispatchAlerts({
      db: serviceDb(),
      senders: alertSenders(),
      network,
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
