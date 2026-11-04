import { isNearAccountId, runChecks, type Snapshot, type VerifyReport } from "@probarion/core";
import type { LedgerStore } from "@probarion/sdk";
import type { Network } from "@/lib/config";
import type { Db } from "@/lib/db/port";
import { memberRole, type TenantKind } from "@/lib/db/tenants";
import { PublicLedgerStore, type PublicVault, SupabaseLedgerStore } from "@/lib/ledger/store";
import { log } from "@/lib/log";
import { ProofEvidenceError } from "./evidence";

export interface SnapshotSource {
  snapshot(): Promise<Snapshot>;
}

export interface ProofDeps {
  /** The chain this deployment reads (`NEAR_NETWORK`). A vault registered for the other one is not served. */
  network: Network;
  /** Anon key: only the public_* functions, which answer for proof_public vaults alone. */
  publicDb: Db;
  /** Service role: used only after the session's membership of the vault is found. */
  serviceDb: Db;
  sessionAccount: string | null;
  makeReader(vault: string, store: LedgerStore): SnapshotSource;
  now?: () => number;
}

export interface ProofOk {
  status: "ok";
  vault: string;
  network: Network;
  kind: TenantKind;
  audience: "public" | "member";
  snapshot: Snapshot;
  report: VerifyReport;
}

export type ProofResult =
  | ProofOk
  | { status: "not_found" }
  /** The checks did not run: the evidence file is malformed, or the chain could not be read. Never a pass. */
  | { status: "error"; reason: "evidence" | "chain"; vault: string; network: Network };

const TTL_MS = 60_000;
/** Bounds the cache: only vaults with a public page or a member's view get here, but keep it small anyway. */
const MAX_ENTRIES = 500;
const NOT_FOUND = { status: "not_found" } as const;
const cache = new Map<string, { at: number; value: ProofOk }>();

export function clearProofCache(): void {
  cache.clear();
}

function remember(key: string, at: number, value: ProofOk): void {
  if (cache.size >= MAX_ENTRIES) {
    for (const [k, v] of cache) if (at - v.at >= TTL_MS) cache.delete(k);
    if (cache.size >= MAX_ENTRIES) cache.clear();
  }
  cache.set(key, { at, value });
}

/**
 * Who may see `vault`, and through which ledger: anyone, through the anon key, when its owner made the proof page
 * public; otherwise only a member of the vault, through the tenant's own ledger. Null for everyone else, and for a
 * vault nobody registered: both look the same, so this says nothing about who is a customer.
 */
async function access(
  deps: ProofDeps,
  vault: string,
): Promise<{
  audience: "public" | "member";
  store: LedgerStore;
  network: Network;
  kind: TenantKind;
} | null> {
  const pub = await deps.publicDb.rpc<PublicVault | null>("public_vault", { vault_id: vault });
  if (pub && pub.vault_id === vault) {
    return {
      audience: "public",
      store: new PublicLedgerStore(deps.publicDb, vault),
      network: pub.network,
      kind: pub.kind,
    };
  }
  if (!deps.sessionAccount) return null;
  const member = await memberRole(deps.serviceDb, vault, deps.sessionAccount);
  if (!member || member.vault_id !== vault) return null;
  return {
    audience: "member",
    store: new SupabaseLedgerStore(deps.serviceDb, member.tenant_id),
    network: member.network,
    kind: member.kind,
  };
}

/**
 * The live checks for `vault`: a fresh snapshot from the read-only Probarion, run through core's `runChecks`, the
 * same function `probarion verify --offline` runs. An id that is not a NEAR account is not looked up at all.
 *
 * Who may see the vault is decided on every call, BEFORE the cache, so a member's view never reaches anyone else and
 * a page its owner made private is hidden at once. Only `ok` results are cached: 60 s per network, vault and audience.
 */
export async function loadProof(deps: ProofDeps, vault: string): Promise<ProofResult> {
  if (!isNearAccountId(vault)) return NOT_FOUND;
  const who = await access(deps, vault);
  if (who === null || who.network !== deps.network) return NOT_FOUND;

  const now = deps.now ?? Date.now;
  const key = `${deps.network}:${vault}:${who.audience}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < TTL_MS) return hit.value;

  let snapshot: Snapshot;
  try {
    snapshot = await deps.makeReader(vault, who.store).snapshot();
  } catch (error) {
    const reason = error instanceof ProofEvidenceError ? "evidence" : "chain";
    log.warn("proof.unavailable", {
      vault,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "error", reason, vault, network: deps.network };
  }
  const report = await runChecks(snapshot, { now: new Date(now()) });
  const value: ProofOk = {
    status: "ok",
    vault,
    network: deps.network,
    kind: who.kind,
    audience: who.audience,
    snapshot,
    report,
  };
  remember(key, now(), value);
  return value;
}
