import type { Network } from "@/lib/config";
import type { Db } from "@/lib/db/port";
import { log } from "@/lib/log";
import type { AccessKeyState } from "@/lib/near/reader";

/** The Canary tenant an attempt runs on. */
export interface CanaryTenant {
  tenant_id: string;
  vault_id: string;
  network: Network;
}

export type CanaryTenantCheck =
  | { ok: true; tenant: CanaryTenant }
  | { ok: false; reason: "not_canary" | "other_network" | "public_ledger" };

/**
 * The tenant of `vault` on `network`, when it can take Canary attempts: registered as a Canary tenant, on that network,
 * with a private ledger. The attempt route and the page ask the same question, so the page never shows a form the route
 * would refuse. `at` is the context of the error lines (the route's request id). A failed read is thrown to the caller.
 */
export async function findCanaryTenant(
  db: Db,
  vault: string,
  network: Network,
  at: Record<string, unknown> = {},
): Promise<CanaryTenantCheck> {
  const found = await db.rpc<{
    tenant_id: string;
    vault_id: string;
    network: Network;
    kind: string;
    proof_public: boolean;
  } | null>("tenant_by_vault", { vault_id: vault });
  if (found?.kind !== "canary") return { ok: false, reason: "not_canary" };
  // The network's Canary vault is registered on the other one: a setting gone wrong, not a vault to run an attempt on.
  if (found.network !== network) {
    log.error("canary.vault_on_other_network", { ...at, network });
    return { ok: false, reason: "other_network" };
  }
  // The Canary's ledger must be private: the gullible model quotes what visitors type into signed, append-only entries,
  // and a public ledger would publish that for good (W-T17-R1).
  if (found.proof_public) {
    log.error("canary.public_ledger", { ...at, tenant: found.tenant_id });
    return { ok: false, reason: "public_ledger" };
  }
  return {
    ok: true,
    tenant: { tenant_id: found.tenant_id, vault_id: found.vault_id, network: found.network },
  };
}

/**
 * The gas allowance of the tenant's active ledger key, which pays for the anchor of every attempt: null for a key the
 * chain shows with no limit, 0 when the tenant has no active ledger key or the chain does not show it. The attempt
 * route refuses below CANARY_LIMITS.minLedgerAllowanceYocto, and the page asks the same.
 */
export async function ledgerKeyAllowance(
  keys: () => Promise<readonly { purpose: string; status: string; public_key: string }[]>,
  accessKey: (account: string, publicKey: string) => Promise<AccessKeyState>,
  tenant: CanaryTenant,
): Promise<bigint | null> {
  const key = (await keys()).find((k) => k.purpose === "ledger" && k.status === "active");
  if (!key) return 0n;
  const k = await accessKey(tenant.vault_id, key.public_key);
  if (!k.exists) return 0n;
  return k.allowance === null ? null : BigInt(k.allowance);
}
