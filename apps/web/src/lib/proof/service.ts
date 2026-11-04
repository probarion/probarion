import { isNearAccountId, runChecks, type Snapshot, type VerifyReport } from "@probarion/core";
import { LedgerError, type LedgerStore } from "@probarion/sdk";
import type { Network } from "@/lib/config";
import { type Db, DbError } from "@/lib/db/port";
import { memberRole, type TenantKind } from "@/lib/db/tenants";
import { PublicLedgerStore, type PublicVault, SupabaseLedgerStore } from "@/lib/ledger/store";
import { log } from "@/lib/log";
import { ProofEvidenceError } from "./evidence";
import { proofIndexTarget } from "./view";

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
  /**
   * The checks did not run: the evidence file is malformed, the vault ledger could not be read from the database,
   * or its chain data could not be read. Never a pass.
   */
  | { status: "error"; reason: ProofErrorReason; vault: string; network: Network };

export type ProofErrorReason = "evidence" | "ledger" | "chain";

const TTL_MS = 60_000;
/** Bounds the cache: only vaults with a public page or a member's view get here, but keep it small anyway. */
const MAX_ENTRIES = 500;
const NOT_FOUND = { status: "not_found" } as const;
const cache = new Map<string, { at: number; value: ProofOk }>();
/** Gathers under way, by cache key: visitors who arrive while one runs share it instead of starting their own. */
const inFlight = new Map<string, Promise<ProofResult>>();

export function clearProofCache(): void {
  cache.clear();
  inFlight.clear();
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

/** Why a gather failed, for the page: the evidence file, the ledger in the database, or else the chain. */
function errorReason(error: unknown): ProofErrorReason {
  if (error instanceof ProofEvidenceError) return "evidence";
  if (error instanceof LedgerError || error instanceof DbError) return "ledger";
  return "chain";
}

/** One gather and its checks. Only an `ok` result is stored in the cache. */
async function gather(
  deps: ProofDeps,
  vault: string,
  who: NonNullable<Awaited<ReturnType<typeof access>>>,
  key: string,
  now: () => number,
): Promise<ProofResult> {
  let snapshot: Snapshot;
  try {
    snapshot = await deps.makeReader(vault, who.store).snapshot();
  } catch (error) {
    const reason = errorReason(error);
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

/**
 * The live checks for `vault`: a fresh snapshot from the read-only Probarion, run through core's `runChecks`, the
 * same function `probarion verify --offline` runs. An id that is not a NEAR account is not looked up at all.
 *
 * Who may see the vault is decided on every call, BEFORE the cache, so a member's view never reaches anyone else and
 * a page its owner made private is hidden at once. Only `ok` results are cached: 60 s per network, vault and audience.
 * Visitors who miss the cache while a gather for the same key is under way wait for that one, so many cold requests
 * cost one snapshot. The cache is per server instance: another instance, or a request after 60 s, gathers anew.
 */
export async function loadProof(deps: ProofDeps, vault: string): Promise<ProofResult> {
  if (!isNearAccountId(vault)) return NOT_FOUND;
  const who = await access(deps, vault);
  if (who === null || who.network !== deps.network) return NOT_FOUND;

  const now = deps.now ?? Date.now;
  const key = `${deps.network}:${vault}:${who.audience}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < TTL_MS) return hit.value;
  const running = inFlight.get(key);
  if (running !== undefined) return running;

  const job = gather(deps, vault, who, key, now).finally(() => {
    if (inFlight.get(key) === job) inFlight.delete(key);
  });
  inFlight.set(key, job);
  return job;
}

/**
 * Where `/proof` with no vault goes: the demo vault's page, but only when that vault's proof page is public on this
 * deployment's network. Otherwise null, and `/proof` explains how to open a vault instead of answering 404. An id that
 * is not a NEAR account is not looked up.
 */
export async function publicDemoTarget(
  deps: Pick<ProofDeps, "publicDb" | "network">,
  demoVault: string | null,
): Promise<string | null> {
  const target = proofIndexTarget(demoVault);
  if (target === null || demoVault === null) return null;
  const pub = await deps.publicDb.rpc<PublicVault | null>("public_vault", { vault_id: demoVault });
  return pub && pub.vault_id === demoVault && pub.network === deps.network ? target : null;
}
