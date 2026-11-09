import "server-only";
import type { Db } from "@/lib/db/port";
import type { KeyPurpose, KeyStatus } from "./rules";

// The tenant's keys as metadata: what a page or a check reads without opening any key. The extension's queue reads
// keys through this module and never loads service.ts, which opens them.

/** A key as agent_key_list returns it: metadata only, never the sealed columns. */
export interface KeyRow {
  id: string;
  tenant_id: string;
  purpose: KeyPurpose;
  public_key: string;
  label: string;
  status: KeyStatus;
  /** A rotation counter (1 when sealed, +1 per re-seal), not the id of a master. */
  key_version: number;
  created_by: string;
  created_at: string;
  activated_at: string | null;
  revoked_at: string | null;
  /** What the last sync saw: the vault registers it (null = never read). */
  chain_registered: boolean | null;
  /** What the last sync saw: its access key exists (null = never read). */
  chain_has_key: boolean | null;
  /** What the last sync saw: the access key is exactly the one the vault adds (null = never read). */
  chain_scoped: boolean | null;
  chain_checked_at: string | null;
  /** Ever registered or with an access key. A pending key never seen on chain may be handed out again. */
  chain_seen: boolean;
  /** When the owner discarded it (null: never). A sync never makes a discarded key active. */
  discarded_at: string | null;
}

export function listKeys(db: Db, tenantId: string): Promise<KeyRow[]> {
  return db.rpc<KeyRow[]>("agent_key_list", { tenant_id: tenantId });
}
