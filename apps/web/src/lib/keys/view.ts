import "server-only";
import { type ChainReads, codeIdentity } from "@/lib/console/vaults";
import type { Db } from "@/lib/db/port";
import { log } from "@/lib/log";
import { type ChainErrorKind, chainErrorKind, type VaultReader } from "@/lib/near/reader";
import { type KeyPurpose, type KeyStatus, type VaultCode, vaultCodeOf } from "./rules";
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
  /**
   * The owner discarded it, yet the last sync saw it pass the full activation check: registered, with
   * exactly the access key the vault adds (W-T10-R2, W-T10-R3). Keep is offered only then, so it is
   * never offered when it would refuse.
   */
  discardedOnChain: boolean;
}

export interface KeysView {
  keys: KeyView[];
  /** The tenant has an active ledger key (a new one replaces it). */
  ledgerActive: boolean;
  /** The vault's ledger key is stuck: registered, its access key never added (W-T10-R1). */
  ledgerStuck: boolean;
  /**
   * What the vault's code can do about a stuck ledger key (W-T10-R3). Read only while the ledger key
   * is stuck (else `unknown`, and unused): on `old` code a new ledger key can never land, on `current`
   * code setting one recovers.
   */
  vaultCode: VaultCode;
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

/** The vault's code, from its account's code identity; `unknown` when it cannot be read. */
export async function readVaultCode(
  chain: Pick<ChainReads, "viewAccount"> | undefined,
  vault: string,
): Promise<VaultCode> {
  if (!chain) return "unknown";
  try {
    return vaultCodeOf(codeIdentity(await chain.viewAccount(vault)));
  } catch (error) {
    log.warn("keys.vault_code_unreadable", { vault, kind: chainErrorKind(error) ?? "unknown" });
    return "unknown";
  }
}

/**
 * The keys page's data: the tenant's keys, the allowance of each active one, and, while the ledger key
 * is stuck, what the vault's code can do about it (`chain` reads the vault account).
 */
export async function loadKeysView(
  db: Db,
  reader: VaultReader,
  member: { tenant_id: string; vault_id: string },
  chain?: Pick<ChainReads, "viewAccount">,
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
        discardedOnChain:
          k.discarded_at !== null && k.chain_registered === true && k.chain_scoped === true,
        allowance:
          k.status === "active" ? await allowanceOf(reader, member.vault_id, k.public_key) : null,
      }),
    ),
  );
  const ledgerStuck = keys.some((k) => k.purpose === "ledger" && k.stuck);
  return {
    keys,
    ledgerActive: keys.some((k) => k.purpose === "ledger" && k.status === "active"),
    ledgerStuck,
    vaultCode: ledgerStuck ? await readVaultCode(chain, member.vault_id) : "unknown",
  };
}
