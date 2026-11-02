import "server-only";
import type { Db } from "@/lib/db/port";
import { type ChainErrorKind, chainErrorKind, type VaultReader } from "@/lib/near/reader";
import type { KeyPurpose, KeyStatus } from "./rules";
import { listKeys } from "./service";

/**
 * What the chain says is left of an active key's gas allowance (IF §4.2). Read from `accessKey`
 * only when the key exists: a missing key (NO_KEY) has `allowance: null` too, and that must never
 * show as "unlimited".
 */
export type AllowanceView =
  | { state: "limited"; yocto: string }
  | { state: "unlimited" }
  | { state: "not_on_chain" }
  | { state: "unavailable"; why?: ChainErrorKind };

/** One row of the keys table. Public data only, copied field by field (never a spread of a DB row). */
export interface KeyView {
  id: string;
  purpose: KeyPurpose;
  public_key: string;
  label: string;
  status: KeyStatus;
  created_at: string;
  activated_at: string | null;
  revoked_at: string | null;
  /** Null for a key that is not active (nothing is read for it). */
  allowance: AllowanceView | null;
  /** The last sync saw the vault register it (null: never read). Remove is offered for every such agent key. */
  registered: boolean | null;
  /** The vault registers it, but its access key was never added (W-T10-R1). */
  stuck: boolean;
}

export interface KeysView {
  keys: KeyView[];
  /** The tenant has an active ledger key (a new one replaces it). */
  ledgerActive: boolean;
}

async function allowanceOf(
  reader: VaultReader,
  vault: string,
  publicKey: string,
): Promise<AllowanceView> {
  try {
    const k = await reader.accessKey(vault, publicKey);
    if (!k.exists) return { state: "not_on_chain" };
    return k.allowance === null ? { state: "unlimited" } : { state: "limited", yocto: k.allowance };
  } catch (error) {
    const why = chainErrorKind(error);
    return why === null ? { state: "unavailable" } : { state: "unavailable", why };
  }
}

/** The keys page's data: the tenant's keys and, for each active one, its allowance on chain. */
export async function loadKeysView(
  db: Db,
  reader: VaultReader,
  member: { tenant_id: string; vault_id: string },
): Promise<KeysView> {
  const rows = await listKeys(db, member.tenant_id);
  const keys = await Promise.all(
    rows.map(
      async (k): Promise<KeyView> => ({
        id: k.id,
        purpose: k.purpose,
        public_key: k.public_key,
        label: k.label,
        status: k.status,
        created_at: k.created_at,
        activated_at: k.activated_at,
        revoked_at: k.revoked_at,
        registered: k.chain_registered,
        stuck: k.chain_registered === true && k.chain_has_key === false,
        allowance:
          k.status === "active" ? await allowanceOf(reader, member.vault_id, k.public_key) : null,
      }),
    ),
  );
  return {
    keys,
    ledgerActive: keys.some((k) => k.purpose === "ledger" && k.status === "active"),
  };
}
