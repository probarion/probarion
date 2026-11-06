import { isDeepStrictEqual } from "node:util";
import type { AnchorView, MandateView, SpendStatus, SpendView } from "@probarion/core";
import type { Network } from "@/lib/config";
import type { Db } from "@/lib/db/port";
import { withLease } from "@/lib/db/tenants";
import { listKeys } from "@/lib/keys/service";
import type { LedgerRow } from "@/lib/ledger/store";
import { log } from "@/lib/log";
import type { AccessKeyState, VaultReader } from "@/lib/near/reader";
import { ALLOWANCE_LOW_ALERT_YOCTO, freeNearYocto, NEAR_LOW_ALERT_YOCTO } from "@/lib/near/runway";

// The watcher (plan 04 Task 20): it reads each vault's chain and ledger from a cursor and writes what it sees into
// `vault_events`, one row per (tenant, event_key). Reading the same thing twice adds nothing, so a run that died
// half way, two runs that overlap and a cursor that moved back are all harmless. The usage page counts these rows
// and the alerts (Task 21) send them. Nothing here sends anything or shows anything.

export interface WatchTenant {
  tenant_id: string;
  vault_id: string;
  network: Network;
  kind: string;
  /** A 0-based position in `list_spends` (not an id: ids start at 1). */
  watch_spend_from: number;
  /** A 0-based position in `list_mandates`. */
  watch_mandate_from: number;
  /** A 0-based position in `list_anchors`. */
  watch_anchor_from: number;
  /** The next ledger seq to read. */
  watch_ledger_seq: number;
}

export interface WatchDeps {
  db: Db;
  reader: VaultReader;
  /** The vault account's `view_account` (the SDK's `RpcClient.viewAccount` in the routes), for its free NEAR. */
  viewAccount(account: string): Promise<{ amount: string; storage_usage: number }>;
  network: Network;
  now(): Date;
}

/** The kinds the `vault_events` check accepts (migration 0001). */
export type VaultEventKind =
  | `spend_${SpendStatus}`
  | "mandate_created"
  | "anchor"
  | "refused_by_contract"
  | "allowance_low"
  | "near_low";

export interface NewEvent {
  tenant_id: string;
  event_key: string;
  kind: VaultEventKind;
  spend_id?: number;
  mandate_id?: number;
  anchor_seq?: number;
  amount?: string;
  code?: string | null;
  tx_hash?: string | null;
  payload?: Record<string, unknown>;
}

export interface WatchRun {
  /** The tenants of this network. */
  tenants: number;
  /** The events that were new. */
  inserted: number;
  /** Tenants whose run threw. */
  errors: number;
  /** Tenants the run did not start because its time was used (the next run starts with them). */
  skipped: number;
}

/** The contract's `list_*` cap, and how many pages of one kind a run reads: a vault with more catches up over runs. */
const PAGE = 100;
const MAX_PAGES = 10;
/** A run starts no new tenant after this long: the route's `maxDuration` is 60 s and one tenant can take several. */
const BUDGET_MS = 40_000;
/** The watch lease: shorter than a Vercel function's life, so a run that died is not waited for. */
const LEASE_SECONDS = 50;
/** Events per `vault_event_insert` call: a first run over a big vault is thousands of them. */
const INSERT_CHUNK = 200;

/** Final spends never change again; held and pending ones do, so they are read again until they are. */
const FINAL: ReadonlySet<SpendStatus> = new Set([
  "paid",
  "burned",
  "failed",
  "rejected",
  "expired",
]);

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** One event per spend and status. `next` is the position of the first spend that is not final (or past them all). */
export function spendEvents(
  tenantId: string,
  spends: SpendView[],
  from: number,
): { events: NewEvent[]; next: number } {
  const events = spends.map(
    (s): NewEvent => ({
      tenant_id: tenantId,
      event_key: `spend:${s.id}:${s.status}`,
      kind: `spend_${s.status}`,
      spend_id: s.id,
      mandate_id: s.mandate_id,
      amount: s.amount,
      // `ref` and `memo` are text the payee or the agent chose: Task 21 treats them as untrusted when it renders.
      payload: {
        destination: s.destination,
        ref: s.ref,
        held_until_ns: s.held_until_ns,
        memo: s.memo,
      },
    }),
  );
  const open = spends.findIndex((s) => !FINAL.has(s.status));
  return { events, next: from + (open === -1 ? spends.length : open) };
}

export function anchorEvents(
  tenantId: string,
  anchors: AnchorView[],
  from: number,
): { events: NewEvent[]; next: number } {
  return {
    events: anchors.map(
      (a): NewEvent => ({
        tenant_id: tenantId,
        event_key: `anchor:${a.seq}`,
        kind: "anchor",
        anchor_seq: a.seq,
        payload: { root: a.root, count: a.count },
      }),
    ),
    next: from + anchors.length,
  };
}

export function mandateEvents(
  tenantId: string,
  mandates: MandateView[],
  from: number,
): { events: NewEvent[]; next: number } {
  return {
    events: mandates.map(
      (m): NewEvent => ({
        tenant_id: tenantId,
        event_key: `mandate:${m.id}`,
        kind: "mandate_created",
        mandate_id: m.id,
        payload: { label: m.label, payee: m.payee },
      }),
    ),
    next: from + mandates.length,
  };
}

/**
 * A refusal by the contract, counted as /usage counts it (migration 0009): a `payment` entry whose contract answered
 * `refused`, with a transaction hash. An outcome that is `unknown` or `failed` also carries a code and a hash and is
 * not a refusal, and a spend a dry run stopped has no hash. `next` is past every entry read, refusal or not.
 */
export function refusalEvents(
  tenantId: string,
  rows: LedgerRow[],
  from: number,
): { events: NewEvent[]; next: number } {
  const events: NewEvent[] = [];
  for (const r of rows) {
    const c = r.body.contract;
    if (r.kind !== "payment" || c?.status !== "refused" || !c.tx_hash) continue;
    events.push({
      tenant_id: tenantId,
      event_key: `refused:${r.seq}`,
      kind: "refused_by_contract",
      mandate_id: r.body.mandate_id ?? undefined,
      amount: r.body.amount ?? undefined,
      code: c.code,
      tx_hash: c.tx_hash,
      payload: { request_id: r.body.request_id },
    });
  }
  const last = rows[rows.length - 1];
  return { events, next: last === undefined ? from : last.seq + 1 };
}

/** An agent or ledger key whose allowance is under 0.2 NEAR, once per key and UTC day. None for a key the chain lacks or that is unlimited. */
export function allowanceEvent(
  tenantId: string,
  key: { public_key: string; purpose: string },
  state: AccessKeyState,
  now: Date,
): NewEvent | null {
  if (!state.exists || state.allowance === null) return null;
  if (BigInt(state.allowance) >= ALLOWANCE_LOW_ALERT_YOCTO) return null;
  return {
    tenant_id: tenantId,
    event_key: `allowance_low:${key.public_key}:${utcDay(now)}`,
    kind: "allowance_low",
    payload: { public_key: key.public_key, purpose: key.purpose, allowance: state.allowance },
  };
}

/** The vault's free NEAR (balance minus the storage stake) under 0.05 NEAR, once per UTC day. */
export function nearLowEvent(
  tenantId: string,
  account: { amount: string; storage_usage: number },
  now: Date,
): NewEvent | null {
  const free = freeNearYocto(account);
  if (free >= NEAR_LOW_ALERT_YOCTO) return null;
  return {
    tenant_id: tenantId,
    event_key: `near_low:${utcDay(now)}`,
    kind: "near_low",
    payload: { free_yocto: free.toString() },
  };
}

/**
 * Reads a list view from position `from`, page after page while a page is full, and at most MAX_PAGES pages. A node
 * that ignores `from_index` answers the same page again, and cursors counted over that would run past the end of the
 * list and skip what comes next: it is an error (as in the SDK's `pageAll`), and nothing is written.
 */
async function readPages<T>(
  what: string,
  from: number,
  read: (from: number, limit: number) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  let previous: T[] = [];
  for (let n = 0; n < MAX_PAGES; n++) {
    const page = await read(from + out.length, PAGE);
    if (
      page.length > 0 &&
      previous.length > 0 &&
      isDeepStrictEqual(previous[0], page[0]) &&
      isDeepStrictEqual(previous.at(-1), page.at(-1))
    ) {
      throw new Error(`${what}: page ${n} repeats page ${n - 1}: the node ignores from_index`);
    }
    out.push(...page);
    if (page.length < PAGE) break;
    previous = page;
  }
  return out;
}

/**
 * A check that must not stop the vault's spends from being recorded: a key whose allowance cannot be read, or a
 * vault account that cannot be viewed, is logged and tried again next run. (If the chain is down the reads that
 * must succeed fail too, and the tenant is an error.)
 */
async function bestEffort(
  check: "allowance" | "near_low",
  t: WatchTenant,
  fn: () => Promise<NewEvent[]>,
): Promise<NewEvent[]> {
  try {
    return await fn();
  } catch (error) {
    log.warn("watch.check_failed", { tenant: t.tenant_id, vault: t.vault_id, check, error });
    return [];
  }
}

/** allowance_low for the tenant's active keys, and near_low for the vault: the events that come from the chain's state, not its lists. */
async function stateEvents(deps: WatchDeps, t: WatchTenant): Promise<NewEvent[]> {
  const now = deps.now();
  const [allowance, nearLow] = await Promise.all([
    bestEffort("allowance", t, async () => {
      // Every purpose is a scoped function-call key on the vault that burns allowance: the agent key on its spends, the
      // ledger key on its anchors.
      const active = (await listKeys(deps.db, t.tenant_id)).filter((k) => k.status === "active");
      const states = await Promise.all(
        active.map((k) => deps.reader.accessKey(t.vault_id, k.public_key)),
      );
      return active.flatMap((k, i) => {
        const state = states[i];
        const e = state === undefined ? null : allowanceEvent(t.tenant_id, k, state, now);
        return e === null ? [] : [e];
      });
    }),
    bestEffort("near_low", t, async () => {
      const e = nearLowEvent(t.tenant_id, await deps.viewAccount(t.vault_id), now);
      return e === null ? [] : [e];
    }),
  ]);
  return [...allowance, ...nearLow];
}

/**
 * One tenant, under its watch lease: read from the cursors, write the events, move the cursors. The events are written
 * first, so a failure in between leaves the cursors where they were and the next run writes nothing twice.
 *
 * The lease is 50 s. A run that outlives it can overlap the next one; it then writes a cursor that is never beyond what
 * IT read, which at worst moves the cursor back past rows the other run recorded, and those are read again and skipped
 * by their keys. A cursor can never skip rows that were not seen.
 */
export async function watchTenant(
  deps: WatchDeps,
  t: WatchTenant,
): Promise<{ inserted: number; skipped?: "busy" }> {
  const r = await withLease(deps.db, t.tenant_id, "watch", LEASE_SECONDS, async () => {
    const [spends, anchors, mandates, ledger] = await Promise.all([
      readPages("list_spends", t.watch_spend_from, (f, l) =>
        deps.reader.listSpends(t.vault_id, f, l),
      ),
      readPages("list_anchors", t.watch_anchor_from, (f, l) =>
        deps.reader.listAnchors(t.vault_id, f, l),
      ),
      readPages("list_mandates", t.watch_mandate_from, (f, l) =>
        deps.reader.listMandates(t.vault_id, f, l),
      ),
      // At most 500 entries; the rest is read from the cursor on the next run.
      deps.db.rpc<LedgerRow[]>("ledger_since", {
        tenant_id: t.tenant_id,
        from_seq: t.watch_ledger_seq,
      }),
    ]);
    const s = spendEvents(t.tenant_id, spends, t.watch_spend_from);
    const a = anchorEvents(t.tenant_id, anchors, t.watch_anchor_from);
    const m = mandateEvents(t.tenant_id, mandates, t.watch_mandate_from);
    const l = refusalEvents(t.tenant_id, ledger, t.watch_ledger_seq);
    const found = [
      ...s.events,
      ...a.events,
      ...m.events,
      ...l.events,
      ...(await stateEvents(deps, t)),
    ];
    let inserted = 0;
    for (let i = 0; i < found.length; i += INSERT_CHUNK) {
      const done = await deps.db.rpc<{ inserted: number }>("vault_event_insert", {
        events: found.slice(i, i + INSERT_CHUNK),
      });
      inserted += done.inserted;
    }
    await deps.db.rpc("tenant_watch_cursor_set", {
      tenant_id: t.tenant_id,
      spend_from: s.next,
      mandate_from: m.next,
      anchor_from: a.next,
      ledger_seq: l.next,
    });
    return inserted;
  });
  return r.acquired ? { inserted: r.value } : { inserted: 0, skipped: "busy" };
}

/** One tenant by id, for the kick after a request that changed its vault (Payables, Canary). */
export async function watchTenantById(
  deps: WatchDeps,
  tenantId: string,
): Promise<{ inserted: number; skipped?: "busy" }> {
  const [t] = await deps.db.rpc<WatchTenant[]>("tenants_for_watch", {
    network: deps.network,
    tenant_id: tenantId,
  });
  return t ? watchTenant(deps, t) : { inserted: 0 };
}

/**
 * Every tenant of the network, the ones looked at longest ago first. A tenant that throws is logged and does not stop
 * the others; it is marked as looked at (no cursor moves), so a vault that keeps failing goes to the back of the queue
 * instead of using up every run. No new tenant is started 40 s into the run; `skipped` counts those, and they go first
 * next time.
 */
export async function watchAll(deps: WatchDeps): Promise<WatchRun> {
  const tenants = await deps.db.rpc<WatchTenant[]>("tenants_for_watch", { network: deps.network });
  const started = deps.now().getTime();
  let inserted = 0;
  let errors = 0;
  let skipped = 0;
  for (const [i, t] of tenants.entries()) {
    if (deps.now().getTime() - started >= BUDGET_MS) {
      skipped = tenants.length - i;
      break;
    }
    try {
      inserted += (await watchTenant(deps, t)).inserted;
    } catch (error) {
      errors++;
      log.error("watch.tenant_failed", { tenant: t.tenant_id, vault: t.vault_id, error });
      await deps.db
        .rpc("tenant_watch_cursor_set", { tenant_id: t.tenant_id })
        .catch((e: unknown) => {
          log.warn("watch.touch_failed", { tenant: t.tenant_id, error: e });
        });
    }
  }
  return { tenants: tenants.length, inserted, errors, skipped };
}

/** A run is healthy when no tenant was due, or at least one tenant it tried did not fail: the chain was reached. */
export function watchHealthy(r: WatchRun): boolean {
  return r.tenants === 0 || r.errors < r.tenants - r.skipped;
}

/**
 * Better Stack heartbeat (IF §14 v2): pinged after a healthy run, so a cron that died, or a chain that cannot be read,
 * raises an alarm. Not configured, or not healthy: no request. A failed request is `false`, never an error.
 */
export async function pingHeartbeat(
  url: string | null,
  healthy: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!url || !healthy) return false;
  try {
    return (await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}
