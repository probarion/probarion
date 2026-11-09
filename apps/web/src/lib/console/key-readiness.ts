import type { Read } from "@/lib/console/vaults";
import type { Db } from "@/lib/db/port";
import { listKeys } from "@/lib/keys/service";
import { log } from "@/lib/log";

/**
 * Whether the console holds an active agent key and an active ledger key for the tenant: what Payables needs before
 * it runs an invoice (a key only becomes active once Keys sees it on the vault). A failed read is a failed read,
 * never "no keys".
 */
export async function readKeyReadiness(
  db: Db,
  tenantId: string,
): Promise<Read<{ agent: boolean; ledger: boolean }>> {
  try {
    const active = (await listKeys(db, tenantId)).filter((k) => k.status === "active");
    return {
      ok: true,
      value: {
        agent: active.some((k) => k.purpose === "agent"),
        ledger: active.some((k) => k.purpose === "ledger"),
      },
    };
  } catch {
    log.warn("console.read_failed", { what: "agent_key_list", tenant: tenantId });
    return { ok: false, kind: "error" };
  }
}
