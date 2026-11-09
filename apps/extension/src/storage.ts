import { type Captured, readCaptured } from "./capture";
import type { ChromeLike } from "./chrome";
import { isKnownOrigin } from "./origins";

// What the extension keeps (spec §5.3).
// - chrome.storage.local: the connections by origin, and the chosen origin.
// - chrome.storage.session (memory only, gone when Chrome closes): the pending connect nonces and the captured
//   invoice that waits for the popup.

export type Network = "testnet" | "mainnet";

export interface Connection {
  network: Network;
  account: string;
  token: string;
  expires_at: string;
  connected_at: string;
  /** Set on a 401, or once `expires_at` passes: the badge shows "!" and the alarm stops until a reconnect. */
  expired: boolean;
}

export interface LocalState {
  connections: Record<string, Connection>;
  selectedOrigin: string | null;
}

/** The layout of chrome.storage.local. A version that changes it raises this and teaches `migrate` the old one. */
export const SCHEMA = 1;

export const TOKEN_RE = /^pbx_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_RE = /^(?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)*$/;

export const isNetwork = (v: unknown): v is Network => v === "testnet" || v === "mainnet";
export const isAccount = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT_RE.test(v);
export const isTime = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));

export const field = (o: unknown, key: string): unknown =>
  typeof o === "object" && o !== null ? (o as Record<string, unknown>)[key] : undefined;

/** A stored connection, or null when any part of it is not what this version writes. */
export function readConnection(raw: unknown): Connection | null {
  const network = field(raw, "network");
  const account = field(raw, "account");
  const token = field(raw, "token");
  const expires = field(raw, "expires_at");
  const connected = field(raw, "connected_at");
  if (!isNetwork(network) || !isAccount(account) || !isTime(expires) || !isTime(connected))
    return null;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  return {
    network,
    account,
    token,
    expires_at: expires,
    connected_at: connected,
    expired: field(raw, "expired") === true,
  };
}

/**
 * chrome.storage.local as this version reads it: schema 1, and a connection stored without `expired` reads as not
 * expired. A connection that doesn't parse, or is for an origin this build doesn't trust, is dropped. A newer
 * version's layout is not guessed at: it reads as empty, and the person connects again.
 */
export function migrate(raw: Record<string, unknown>): LocalState {
  if (raw.schema !== undefined && raw.schema !== SCHEMA)
    return { connections: {}, selectedOrigin: null };
  const connections: Record<string, Connection> = {};
  if (typeof raw.connections === "object" && raw.connections !== null) {
    for (const [origin, value] of Object.entries(raw.connections)) {
      const c = readConnection(value);
      if (c !== null && isKnownOrigin(origin)) connections[origin] = c;
    }
  }
  const chosen = raw.selectedOrigin;
  const selectedOrigin =
    typeof chosen === "string" && Object.hasOwn(connections, chosen)
      ? chosen
      : (Object.keys(connections)[0] ?? null);
  return { connections, selectedOrigin };
}

/**
 * One read-modify-write of chrome.storage at a time. The worker and the popup share this lock (one extension origin).
 * Where a context has no Web Locks (a store preview page), the job runs as is.
 */
async function locked<T>(job: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  return locks === undefined ? job() : await locks.request("probarion:storage", () => job());
}

export async function loadLocal(c: ChromeLike): Promise<LocalState> {
  return migrate(await c.storage.local.get(["schema", "connections", "selectedOrigin"]));
}

async function saveLocal(c: ChromeLike, s: LocalState): Promise<void> {
  await c.storage.local.set({
    schema: SCHEMA,
    connections: s.connections,
    selectedOrigin: s.selectedOrigin,
  });
}

/** Stores the connection for `origin` and makes it the chosen one. */
export async function putConnection(
  c: ChromeLike,
  origin: string,
  connection: Connection,
): Promise<void> {
  return locked(async () => {
    const s = await loadLocal(c);
    s.connections[origin] = connection;
    s.selectedOrigin = origin;
    await saveLocal(c, s);
  });
}

export async function dropConnection(c: ChromeLike, origin: string): Promise<void> {
  return locked(async () => {
    const s = await loadLocal(c);
    delete s.connections[origin];
    if (s.selectedOrigin === origin) s.selectedOrigin = Object.keys(s.connections)[0] ?? null;
    await saveLocal(c, s);
  });
}

export async function markExpired(c: ChromeLike, origin: string): Promise<void> {
  return locked(async () => {
    const s = await loadLocal(c);
    const connection = s.connections[origin];
    if (connection === undefined || connection.expired) return;
    s.connections[origin] = { ...connection, expired: true };
    await saveLocal(c, s);
  });
}

export async function selectOrigin(c: ChromeLike, origin: string): Promise<void> {
  return locked(async () => {
    const s = await loadLocal(c);
    if (!Object.hasOwn(s.connections, origin)) return;
    s.selectedOrigin = origin;
    await saveLocal(c, s);
  });
}

export const NONCE_TTL_MS = 15 * 60_000;
const MAX_NONCES = 5;

type Nonces = Record<string, { origin: string; created_at: number }>;

function liveNonces(raw: unknown, now: number): Nonces {
  const out: Nonces = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [nonce, v] of Object.entries(raw)) {
    const origin = field(v, "origin");
    const at = field(v, "created_at");
    if (typeof origin !== "string" || typeof at !== "number") continue;
    if (at <= now && now - at < NONCE_TTL_MS) out[nonce] = { origin, created_at: at };
  }
  return out;
}

/** Remembers a connect nonce for `origin`. Only the newest five stay pending. */
export async function addNonce(
  c: ChromeLike,
  nonce: string,
  origin: string,
  now: number,
): Promise<void> {
  return locked(async () => {
    const nonces = liveNonces((await c.storage.session.get("nonces")).nonces, now);
    nonces[nonce] = { origin, created_at: now };
    const newest = Object.entries(nonces)
      .sort((a, b) => b[1].created_at - a[1].created_at)
      .slice(0, MAX_NONCES);
    await c.storage.session.set({ nonces: Object.fromEntries(newest) });
  });
}

/** Whether `nonce` was pending for `origin` and under 15 minutes old. It is used up either way. */
export async function takeNonce(
  c: ChromeLike,
  nonce: string,
  origin: string,
  now: number,
): Promise<boolean> {
  return locked(async () => {
    const nonces = liveNonces((await c.storage.session.get("nonces")).nonces, now);
    const hit = Object.hasOwn(nonces, nonce) ? nonces[nonce] : undefined;
    delete nonces[nonce];
    await c.storage.session.set({ nonces });
    return hit !== undefined && hit.origin === origin;
  });
}

/**
 * The invoice a menu click or the popup captured, waiting to be sent. `seen` is whether the popup has shown it:
 * while it hasn't, the badge shows "+".
 */
export type Pending =
  | { state: "reading"; started_at: number; seen: boolean }
  | { state: "ready"; item: Captured; seen: boolean }
  | { state: "error"; text: string; seen: boolean };

export function readPending(raw: unknown): Pending | null {
  const state = field(raw, "state");
  const seen = field(raw, "seen") === true;
  if (state === "reading") {
    const at = field(raw, "started_at");
    return typeof at === "number" && Number.isFinite(at) ? { state, started_at: at, seen } : null;
  }
  if (state === "ready") {
    const item = readCaptured(field(raw, "item"));
    return item === null ? null : { state, item, seen };
  }
  if (state === "error") {
    const text = field(raw, "text");
    return typeof text === "string" && text.length <= 300 ? { state, text, seen } : null;
  }
  return null;
}

export async function getPending(c: ChromeLike): Promise<Pending | null> {
  return readPending((await c.storage.session.get("pending")).pending);
}

export async function setPending(c: ChromeLike, p: Pending): Promise<void> {
  await c.storage.session.set({ pending: p });
}

export async function clearPending(c: ChromeLike): Promise<void> {
  await c.storage.session.remove("pending");
}
