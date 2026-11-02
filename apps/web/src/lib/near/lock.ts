import { isTxHash, type TxResult } from "./outcome";
import type { WalletTx } from "./tx";

/**
 * An unconfirmed send locks its button until the owner says they checked the explorer. A reload must
 * not undo that, so the lock is kept in `sessionStorage` (one tab, gone when it closes), keyed by the
 * action. Every access is in a try/catch: storage can be blocked, full or absent, and the page works
 * without it (the lock then lasts as long as the page).
 */
export const LOCK_PREFIX = "probarion:txlock:";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** JSON with sorted keys, so the same action always gives the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The same transaction (receiver, methods, args, gas, deposits; a transfer is just its deposit) is the same action. */
export function actionKey(tx: WalletTx): string {
  return `${LOCK_PREFIX}${canonical([tx.receiverId, tx.actions.map((a) => a.params)])}`;
}

/**
 * A stable name for an action whose transaction is only known after `prepare()`, for example
 * creating the vault `acme.vaults.probarion.near`: `lockKeyFor("create-vault:acme.vaults.probarion.near")`.
 * Pass it as the TxButton's `lockKey`, so the lock is found again after a reload, before anything is
 * prepared.
 */
export function lockKeyFor(action: string): string {
  return `${LOCK_PREFIX}${action}`;
}

export function browserStore(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The stored unconfirmed result for this action, or null (also for anything malformed). */
export function readLock(store: KeyValueStore | null, key: string | null): TxResult | null {
  if (store === null || key === null) return null;
  try {
    const text = store.getItem(key);
    if (text === null) return null;
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null) return null;
    const r = v as Record<string, unknown>;
    if (r.status !== "unknown") return null;
    const hash = r.txHash === null ? null : isTxHash(r.txHash) ? r.txHash : undefined;
    if (hash === undefined) return null;
    return {
      status: "unknown",
      txHash: hash,
      code: typeof r.code === "string" ? r.code : null,
      error: typeof r.error === "string" ? r.error.slice(0, 500) : null,
    };
  } catch {
    return null;
  }
}

/** Keeps an unconfirmed result; any other result ends the lock. */
export function writeLock(store: KeyValueStore | null, key: string | null, r: TxResult): void {
  if (store === null || key === null) return;
  try {
    if (r.status === "unknown") store.setItem(key, JSON.stringify(r));
    else store.removeItem(key);
  } catch {
    // storage is full or blocked: the lock lasts as long as the page
  }
}

export function clearLock(store: KeyValueStore | null, key: string | null): void {
  if (store === null || key === null) return;
  try {
    store.removeItem(key);
  } catch {
    // nothing to clear
  }
}
