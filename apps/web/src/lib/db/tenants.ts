import type { Network } from "@/lib/config";
import { log } from "@/lib/log";
import { type Db, toDbError } from "./port";

export type TenantKind = "team" | "external" | "canary";
export type MemberRole = "owner" | "approver" | "viewer";

export interface TenantListItem {
  tenant_id: string;
  vault_id: string;
  network: Network;
  kind: TenantKind;
  display_name: string;
  role: MemberRole;
}

export interface MemberTenant extends TenantListItem {
  owner_account: string;
  zero_retention: boolean;
  proof_public: boolean;
}

export interface RegisterTenantInput {
  vaultId: string;
  network: Network;
  kind: TenantKind;
  displayName: string;
  owner: string;
  approvers: string[];
}

export function memberRole(db: Db, vaultId: string, account: string): Promise<MemberTenant | null> {
  return db.rpc<MemberTenant | null>("member_role", { vault_id: vaultId, account });
}

export function memberTenants(db: Db, account: string): Promise<TenantListItem[]> {
  return db.rpc<TenantListItem[]>("member_tenants", { account });
}

export function registerTenant(db: Db, t: RegisterTenantInput): Promise<{ tenant_id: string }> {
  return db.rpc("tenant_register", {
    vault_id: t.vaultId,
    network: t.network,
    kind: t.kind,
    display_name: t.displayName,
    owner_account: t.owner,
    approvers: t.approvers,
  });
}

export function setTenantSettings(
  db: Db,
  tenantId: string,
  s: { zeroRetention?: boolean; proofPublic?: boolean },
): Promise<{ zero_retention: boolean; proof_public: boolean }> {
  return db.rpc("tenant_settings_set", {
    tenant_id: tenantId,
    zero_retention: s.zeroRetention ?? null,
    proof_public: s.proofPublic ?? null,
  });
}

/** What `tenant_lease` answers: `until` (the fencing token) is set exactly when the lease was granted. */
type LeaseGrant = { acquired: true; until: string } | { acquired: false; until: null };

/**
 * Serialises Payables/Canary cycles per tenant so the ledger never forks (Review Focus #2).
 *
 * The lease lasts `seconds` and then expires on its own, so a crashed worker never blocks a tenant for good.
 * It is fenced: the grant carries an `until` timestamp, and the release only clears the lease with that exact
 * `until`. A worker that overran its lease therefore cannot, on finishing, free the lease of the worker that
 * took the tenant over; it logs `lease.expired_before_release` instead (the work took longer than `seconds`,
 * so two workers may have overlapped, and `seconds` is too short for this job).
 *
 * The lease is released afterwards, whether the work returned or threw. A failed release is logged and
 * swallowed: the lease expires by itself, and throwing here would hide the work's result (a payment may
 * already have gone out) or replace the work's own error.
 */
export async function withLease<T>(
  db: Db,
  tenantId: string,
  kind: "process" | "watch",
  seconds: number,
  fn: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const lease = await db.rpc<LeaseGrant>("tenant_lease", { tenant_id: tenantId, kind, seconds });
  if (!lease.acquired) return { acquired: false };
  try {
    return { acquired: true, value: await fn() };
  } finally {
    try {
      const done = await db.rpc<{ released: boolean }>("tenant_release", {
        tenant_id: tenantId,
        kind,
        until: lease.until,
      });
      if (!done.released) {
        log.warn("lease.expired_before_release", { tenant_id: tenantId, kind });
      }
    } catch (e) {
      const err = toDbError(e);
      // "db_error" says nothing on its own, so it travels with the database's text (the logger scrubs it).
      log.warn("lease.release_failed", {
        tenant_id: tenantId,
        kind,
        code: err.code,
        ...(err.code === "db_error" ? { error: err.message } : {}),
      });
    }
  }
}
