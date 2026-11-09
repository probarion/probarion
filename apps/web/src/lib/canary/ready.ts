import "server-only";
import { unstable_cache } from "next/cache";
import type { Network } from "@/lib/config";
import { serviceDb } from "@/lib/db/clients";
import { listKeys } from "@/lib/keys/service";
import { SupabaseLedgerStore } from "@/lib/ledger/store";
import { log } from "@/lib/log";
import { getReader } from "@/lib/near/server";
import { within } from "@/lib/within";
import { READ_TIMEOUT_MS } from "./board-data";
import { CANARY_LIMITS } from "./limits";
import {
  type CanaryTenant,
  type CanaryTenantCheck,
  findCanaryTenant,
  ledgerKeyAllowance,
} from "./tenant";
import type { Banner } from "./view";

// Whether the live Canary page may show its form: the database and the chain must agree with the settings. The attempt
// route asks the same of every attempt; the page asks once a minute, behind Next's data cache, like the scoreboard
// (board-data.ts). Unlike the scoreboard, a failed read is not cached: it would show a definite "not open yet" for a
// minute after a blip, where the scoreboard only says it could not be read. So a database in trouble is asked once a
// view, each read bounded by READ_TIMEOUT_MS.

export const READINESS_REVALIDATE_S = 60;

/** Ready, or the replay banner that says why not. */
export type Readiness = "ready" | Extract<Banner, "closed" | "full">;

export interface ReadinessDeps {
  tenant(network: Network, vault: string): Promise<CanaryTenantCheck>;
  /** How many entries the tenant's ledger holds. */
  ledgerSize(tenant: CanaryTenant): Promise<number>;
  /** The ledger key's gas allowance, as ledgerKeyAllowance reads it (null: no limit). */
  ledgerAllowance(tenant: CanaryTenant): Promise<bigint | null>;
}

/**
 * Ready when `vault` is a private Canary tenant on `network` whose ledger has room and whose ledger key can pay for
 * anchors; full once the ledger holds CANARY_LIMITS.maxLedgerEntries entries, after which every attempt is closed;
 * otherwise not open. A failed read is thrown, for loadReadiness to answer.
 */
export async function readinessOf(
  deps: ReadinessDeps,
  network: Network,
  vault: string,
): Promise<Readiness> {
  const found = await deps.tenant(network, vault);
  if (!found.ok) return "closed";
  if ((await deps.ledgerSize(found.tenant)) >= CANARY_LIMITS.maxLedgerEntries) return "full";
  const allowance = await deps.ledgerAllowance(found.tenant);
  return allowance !== null && allowance < CANARY_LIMITS.minLedgerAllowanceYocto
    ? "closed"
    : "ready";
}

/** The ledger's size the way the attempt route counts it: the head's sequence number plus one, 0 when empty. */
async function ledgerSize(tenant: CanaryTenant): Promise<number> {
  const head = await new SupabaseLedgerStore(serviceDb(), tenant.tenant_id).head();
  return head === null ? 0 : head.body.seq + 1;
}

/** One answer per network and vault: both are cache key arguments, so one network's answer never serves the other. */
const readReadiness = unstable_cache(
  (network: Network, vault: string): Promise<Readiness> =>
    readinessOf(
      {
        tenant: (n, v) => within(() => findCanaryTenant(serviceDb(), v, n), READ_TIMEOUT_MS),
        ledgerSize: (t) => within(() => ledgerSize(t), READ_TIMEOUT_MS),
        ledgerAllowance: (t) =>
          within(
            () =>
              ledgerKeyAllowance(
                () => listKeys(serviceDb(), t.tenant_id),
                (account, pk) => getReader(t.network).accessKey(account, pk),
                t,
              ),
            READ_TIMEOUT_MS,
          ),
      },
      network,
      vault,
    ),
  ["canary-readiness"],
  { revalidate: READINESS_REVALIDATE_S },
);

/** Whether the Canary of `network`, at `vault`, can take attempts. Not open, with a warning, when it cannot be read. */
export async function loadReadiness(network: Network, vault: string): Promise<Readiness> {
  try {
    return await readReadiness(network, vault);
  } catch (error) {
    // The database, the chain or the cache layer itself: still a page, not a 500.
    log.warn("canary.readiness_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "closed";
  }
}
