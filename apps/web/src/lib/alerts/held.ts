import type { Db } from "@/lib/db/port";
import { log } from "@/lib/log";

/**
 * Whether a confirmed alert of the tenant sends a message when a spend is held for approval (site audit P1-18). The
 * overview's held card offers "Get a message next time" when none does. A failed read answers false: one link too
 * many costs less than an approval nobody hears about.
 */
export async function heldAlertIsOn(db: Db, tenantId: string): Promise<boolean> {
  try {
    const subs = await db.rpc<{ kinds: string[]; verified_at: string | null }[]>(
      "alert_subscriptions_list",
      { tenant_id: tenantId, full: false },
    );
    return subs.some((s) => s.verified_at !== null && s.kinds.includes("spend_held"));
  } catch {
    log.warn("console.read_failed", { what: "alert_subscriptions_list", tenant: tenantId });
    return false;
  }
}
