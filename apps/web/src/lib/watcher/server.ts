import "server-only";
import { after } from "next/server";
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

/**
 * Watches one tenant as soon as the response in flight has been sent, so an app-driven change (a Payables cycle, a
 * Canary attempt) reaches `vault_events`, and the owner's alerts, within seconds instead of at the next scheduled run.
 * Called from a route once it is sure to run the cycle. It never throws and never fails the request: the watch is
 * best effort, and the scheduled run (docs/ops/watcher.md) covers whatever it missed.
 */
export function kickWatcher(tenantId: string): void {
  try {
    after(async () => {
      try {
        await watchTenantById(watcherDeps(), tenantId);
      } catch (error) {
        log.warn("watch.kick_failed", { tenant: tenantId, error });
      }
    });
  } catch (error) {
    // after() throws outside a request scope; the request itself must not fail because of it.
    log.warn("watch.kick_failed", { tenant: tenantId, error });
  }
}
