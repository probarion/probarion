import "server-only";
import { after } from "next/server";
import { runAlerts } from "@/lib/alerts/server";
import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { getReader, getRpc } from "@/lib/near/server";
import { type WatchDeps, watchTenantById } from "./watch";

/** The watcher's inputs for this deployment: the service database, the chain reader, the app's network. */
export function watcherDeps(): WatchDeps {
  return {
    db: serviceDb(),
    reader: getReader(),
    viewAccount: (account) => getRpc().viewAccount(account),
    network: getEnv().NEAR_NETWORK,
    now: () => new Date(),
  };
}

/** How long a kick may keep claiming alerts once its watch is over: it shares the function's time with the request. */
const KICK_ALERTS_MS = 10_000;

/**
 * Watches one tenant as soon as the response in flight has been sent, so an app-driven change (a Payables cycle, a
 * Canary attempt) reaches `vault_events`, and the owner's alerts, within seconds instead of at the next scheduled run.
 * The alerts are dispatched after the watch, for every vault and not only this one, whether or not the watch worked
 * (what is already recorded is worth sending), until 10 s have passed; the rest waits for the next run. Called from a
 * route once it is sure to run the cycle. It never throws and never fails the request: the watch and the alerts are best
 * effort, and the scheduled run (docs/ops/watcher.md) covers whatever they missed.
 */
export function kickWatcher(tenantId: string): void {
  try {
    after(async () => {
      try {
        await watchTenantById(watcherDeps(), tenantId);
      } catch (error) {
        log.warn("watch.kick_failed", { tenant: tenantId, error });
      }
      // One dispatch for the whole network, not only this vault: it is a global job hung off a per-vault request, and it
      // is safe, because every alert is claimed before it is sent, so two dispatches never send one twice.
      // runAlerts does not throw; the catch is for the day somebody changes that.
      await runAlerts(Date.now() + KICK_ALERTS_MS).catch(() => undefined);
    });
  } catch (error) {
    // after() throws outside a request scope; the request itself must not fail because of it.
    log.warn("watch.kick_failed", { tenant: tenantId, error });
  }
}
