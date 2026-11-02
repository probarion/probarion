import "server-only";
import type { AgentView, VaultConfig } from "@probarion/core";
import { KeyPair, type KeyPairString } from "near-api-js";
import { openAgentSecret, sealAgentSecret } from "@/lib/crypto/secrets";
import type { Db } from "@/lib/db/port";
import { log } from "@/lib/log";
import { type AccessKeyState, chainErrorKind, type VaultReader } from "@/lib/near/reader";
import {
  type ChainView,
  type KeyCheck,
  type KeyPurpose,
  type KeyStatus,
  nextStatus,
  scopeProblem,
} from "./rules";

export type { KeyCheck, KeyPurpose, KeyStatus } from "./rules";

// Spec §11: Probarion generates the agent and ledger keys on its server. The secret is sealed before it is
// stored and is opened only in server memory, by the cycles that sign with it (Payables / Canary, Tasks 13
// and 17). The owner only ever sees, and signs `add_agent` / `set_ledger_key` with, the PUBLIC key.

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
  chain_checked_at: string | null;
  /** Ever registered or with an access key. A pending key never seen on chain may be handed out again. */
  chain_seen: boolean;
}

/** What a key generator must give: a public key and the `ed25519:<secret>` text (near-api-js `KeyPair`). */
export type Keygen = () => { getPublicKey(): { toString(): string }; toString(): string };

/** A new pending key for the tenant. Returns only the row id and the public key. */
export async function generateKey(
  db: Db,
  master: Uint8Array,
  i: { tenantId: string; purpose: KeyPurpose; label: string; createdBy: string },
  keygen: Keygen = () => KeyPair.fromRandom("ed25519"),
): Promise<{ id: string; publicKey: string }> {
  const kp = keygen();
  const publicKey = kp.getPublicKey().toString();
  const sealed = await sealAgentSecret(master, kp.toString());
  const { id } = await db.rpc<{ id: string }>("agent_key_insert", {
    tenant_id: i.tenantId,
    purpose: i.purpose,
    public_key: publicKey,
    secret_ciphertext: sealed.ciphertext,
    secret_nonce: sealed.nonce,
    key_version: sealed.key_version,
    label: i.label,
    created_by: i.createdBy,
  });
  log.info("keys.generated", { tenant: i.tenantId, purpose: i.purpose, public_key: publicKey });
  return { id, publicKey };
}

/** A pending key younger than this, never seen on chain, is handed out again instead of a new one. */
export const PENDING_REUSE_SECONDS = 24 * 3600;

/**
 * The key to offer the owner for `purpose` (W-T10-R1). It is the newest pending key of that purpose
 * that is under 24 h old and was never seen on chain, which also takes the new label. Only when no
 * such key exists is a new one generated. Each cancelled wallet prompt therefore no longer leaves
 * another sealed key behind.
 */
export async function reuseOrGenerateKey(
  db: Db,
  master: Uint8Array,
  i: { tenantId: string; purpose: KeyPurpose; label: string; createdBy: string },
  keygen?: Keygen,
): Promise<{ id: string; publicKey: string; reused: boolean }> {
  const reused = await db.rpc<{ id: string; public_key: string } | null>(
    "agent_key_reuse_pending",
    {
      tenant_id: i.tenantId,
      purpose: i.purpose,
      label: i.label,
      max_age_seconds: PENDING_REUSE_SECONDS,
    },
  );
  if (reused) {
    log.info("keys.reused_pending", {
      tenant: i.tenantId,
      purpose: i.purpose,
      public_key: reused.public_key,
    });
    return { id: reused.id, publicKey: reused.public_key, reused: true };
  }
  return { ...(await generateKey(db, master, i, keygen)), reused: false };
}

/** Owner only (the caller checks): a pending key is set aside, pending -> removed. Anything else is left. */
export function discardKey(
  db: Db,
  tenantId: string,
  id: string,
): Promise<{ id: string; status: KeyStatus; changed: boolean }> {
  return db.rpc("agent_key_discard", { tenant_id: tenantId, id });
}

export function listKeys(db: Db, tenantId: string): Promise<KeyRow[]> {
  return db.rpc<KeyRow[]>("agent_key_list", { tenant_id: tenantId });
}

/** Thrown when a decrypted secret is not the secret of the row's public key. It carries no key material. */
export class KeyMismatchError extends Error {
  constructor() {
    super("key_mismatch: the stored secret does not belong to its public key");
    this.name = "KeyMismatchError";
  }
}

/**
 * The tenant's active key for `purpose`, opened: `secret` is `"ed25519:<secret>"` (IF §9 `agentKey` /
 * `ledgerKey`). Null when there is no active key. Server code only (the Payables / Canary cycles): never
 * return it from an action or a route, never log it.
 *
 * A secret that opens but belongs to another public key (a ciphertext written to the wrong row) is
 * refused, so a key can never sign under a name it does not have.
 */
export async function loadActiveSecret(
  db: Db,
  master: Uint8Array,
  tenantId: string,
  purpose: KeyPurpose,
): Promise<{ publicKey: string; secret: string } | null> {
  const row = await db.rpc<{
    public_key: string;
    secret_ciphertext: string;
    secret_nonce: string;
  } | null>("agent_key_secret", { tenant_id: tenantId, purpose });
  if (!row) return null;
  const secret = await openAgentSecret(master, row);
  let derived: string;
  try {
    derived = KeyPair.fromString(secret as KeyPairString)
      .getPublicKey()
      .toString();
  } catch {
    throw new KeyMismatchError();
  }
  if (!secret.startsWith("ed25519:") || derived !== row.public_key) throw new KeyMismatchError();
  return { publicKey: row.public_key, secret };
}

type Read<T> = { ok: true; value: T } | { ok: false };

async function read<T>(
  what: string,
  tenantId: string,
  f: () => Promise<T>,
  publicKey?: string,
): Promise<Read<T>> {
  try {
    return { ok: true, value: await f() };
  } catch (error) {
    // The kind only: an SDK error's text is already URL-redacted, but nothing here needs it.
    log.warn("keys.chain_unreadable", {
      tenant: tenantId,
      read: what,
      ...(publicKey ? { public_key: publicKey } : {}),
      kind: chainErrorKind(error) ?? "unknown",
    });
    return { ok: false };
  }
}

function logScope(
  tenantId: string,
  k: KeyRow,
  key: AccessKeyState,
  vault: string,
  status: "pending" | "active",
): void {
  const problem = scopeProblem(k.purpose, vault, key);
  if (problem === null || problem === "missing") return;
  const fields = {
    tenant: tenantId,
    public_key: k.public_key,
    purpose: k.purpose,
    problem,
    kind: key.kind,
    receiver: key.receiverId,
    methods: key.methodNames,
  };
  if (status === "pending") log.warn("keys.scope_mismatch", fields);
  else log.error("keys.active_scope_changed", fields);
}

/** At most this many `view_access_key` reads in flight in one sync (W-T10-R1). */
export const SYNC_READ_CONCURRENCY = 4;

/** `f` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  f: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await f(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Brings each key's status in line with the chain (Task 10 ruling, W-T10-R1).
 *
 * A key becomes active only through the one full check: the chain shows exactly the key the vault
 * hands out (a plain FunctionCall key, receiver the vault, methods exactly [spend] / [anchor]) AND the
 * vault registers it (list_agents for an agent key; get_config().ledger_key for the ledger key). That
 * holds for a pending key and for a revoked or removed one (so a lagging node's NO_KEY never sticks).
 * An active key becomes `removed` on a definite NO_KEY, and `revoked` when the vault no longer
 * registers it or its permission changed. A read that fails leaves the key as it is.
 *
 * What each readable key looked like is stored (agent_key_observe): the page offers Remove for every
 * agent key the vault registers, and shows a key the vault registers without its access key as stuck.
 * Every status write is compare-and-set on the status this call read, so two syncs never fight.
 */
export async function syncKeyStatuses(
  db: Db,
  reader: VaultReader,
  tenant: { tenant_id: string; vault_id: string },
): Promise<{ keys: KeyRow[]; checks: KeyCheck[] }> {
  const vault = tenant.vault_id;
  const all = await listKeys(db, tenant.tenant_id);
  // Only the views a key needs: an unreadable get_config must not stop an agent key's check, nor
  // list_agents a ledger key's.
  const none = <T>(): Promise<Read<T>> => Promise.resolve({ ok: false });
  const agentsRead: Promise<Read<AgentView[]>> = all.some((k) => k.purpose === "agent")
    ? read("list_agents", tenant.tenant_id, () => reader.listAgents(vault))
    : none();
  const configRead: Promise<Read<VaultConfig>> = all.some((k) => k.purpose === "ledger")
    ? read("get_config", tenant.tenant_id, () => reader.getConfig(vault))
    : none();
  const [agents, config, keys] = await Promise.all([
    agentsRead,
    configRead,
    mapLimit(all, SYNC_READ_CONCURRENCY, (k) =>
      read(
        "view_access_key",
        tenant.tenant_id,
        () => reader.accessKey(vault, k.public_key),
        k.public_key,
      ),
    ),
  ]);

  const views: ChainView[] = all.map((k, i) => {
    const key = keys[i];
    if (key?.ok && k.purpose === "agent" && agents.ok) {
      return {
        readable: true,
        registered: agents.value.some((a) => a.public_key === k.public_key),
        key: key.value,
      };
    }
    if (key?.ok && k.purpose === "ledger" && config.ok) {
      return {
        readable: true,
        registered: config.value.ledger_key === k.public_key,
        key: key.value,
      };
    }
    return { readable: false };
  });
  const observed = all.flatMap((k, i) => {
    const v = views[i];
    return v?.readable ? [{ id: k.id, registered: v.registered, has_key: v.key.exists }] : [];
  });
  if (observed.length > 0) {
    await db.rpc("agent_key_observe", { tenant_id: tenant.tenant_id, keys: observed });
  }

  const checks: KeyCheck[] = [];
  for (const [i, k] of all.entries()) {
    const view = views[i] ?? { readable: false };
    if (view.readable && (k.status === "pending" || k.status === "active")) {
      logScope(tenant.tenant_id, k, view.key, vault, k.status);
    }
    const verdict = nextStatus(k, vault, view);
    let to = verdict.to;
    if (to !== k.status) {
      const r = await db.rpc<{ status: KeyStatus; changed: boolean }>("agent_key_set_status", {
        tenant_id: tenant.tenant_id,
        id: k.id,
        from: k.status,
        status: to,
      });
      to = r.status;
      log.info("keys.status_changed", {
        tenant: tenant.tenant_id,
        public_key: k.public_key,
        from: k.status,
        to: r.status,
        reason: verdict.reason,
        changed: r.changed,
      });
    }
    checks.push({
      id: k.id,
      public_key: k.public_key,
      purpose: k.purpose,
      from: k.status,
      to,
      reason: verdict.reason,
    });
  }
  return { keys: await listKeys(db, tenant.tenant_id), checks };
}
