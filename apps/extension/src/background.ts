import { ApiError, api, type Inbox, type Paired } from "./api";
import { badgeColor, badgeText } from "./badge";
import {
  type CaptureResult,
  captureSelection,
  captureUrl,
  LINK_ELSEWHERE,
  sameOrigin,
} from "./capture";
import type { ChromeLike, Fetch, MenuClick, MessageSender } from "./chrome";
import { connectUrl, isConnectPage, newNonce, readConnectMessage } from "./connect";
import { isKnownOrigin } from "./origins";
import {
  addNonce,
  type Connection,
  dropConnection,
  getPending,
  loadLocal,
  markExpired,
  putConnection,
  setPending,
  takeNonce,
} from "./storage";

// The extension's jobs (spec §5.4-5.7): the badge and its alarm, the connect handshake, the pairing code, Disconnect
// and the right-click menus. They take a ChromeLike, so the tests run them on a fake. The worker (worker.ts) and the
// popup (popup/main.ts) call them.

export interface Deps {
  chrome: ChromeLike;
  fetch: Fetch;
  now: () => number;
}

export const ALARM = "inbox";
export const PERIOD_MINUTES = 5;
export const MENU_LINK = "probarion-link";
export const MENU_SELECTION = "probarion-selection";

export type InboxState =
  | { kind: "none" }
  | { kind: "expired"; origin: string; connection: Connection }
  | { kind: "ok"; origin: string; connection: Connection; inbox: Inbox }
  | { kind: "error"; origin: string; connection: Connection; text: string };

async function setBadge(d: Deps, text: string): Promise<void> {
  await d.chrome.action.setBadgeBackgroundColor({ color: badgeColor(text) });
  await d.chrome.action.setBadgeText({ text });
}

/**
 * Reads the chosen connection's inbox and sets the badge. A 401, or a token past its end, marks the connection
 * expired and stops the alarm: nothing is asked for it again until the person reconnects. When Probarion can't be
 * reached, the badge stays as it was, or shows "+" while a captured invoice waits unseen.
 */
export async function refresh(d: Deps): Promise<InboxState> {
  const s = await loadLocal(d.chrome);
  const origin = s.selectedOrigin;
  const connection = origin === null ? undefined : s.connections[origin];
  const p = await getPending(d.chrome);
  const pending = p !== null && !p.seen;
  if (origin === null || connection === undefined) {
    await setBadge(d, badgeText({ expired: false, pending, count: 0 }));
    return { kind: "none" };
  }
  const expire = async (): Promise<InboxState> => {
    await markExpired(d.chrome, origin);
    await d.chrome.alarms.clear(ALARM);
    await setBadge(d, "!");
    return { kind: "expired", origin, connection: { ...connection, expired: true } };
  };
  if (connection.expired || Date.parse(connection.expires_at) <= d.now()) return expire();
  try {
    const inbox = await api(origin, d.fetch).inbox(connection.token);
    const count = inbox.counts.awaiting + inbox.counts.held;
    await setBadge(d, badgeText({ expired: false, pending, count }));
    await ensureAlarm(d);
    return { kind: "ok", origin, connection, inbox };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return expire();
    if (pending) await setBadge(d, "+"); // a capture waits, whatever Probarion answers
    const text = error instanceof ApiError ? error.message : "Something went wrong. Try again.";
    return { kind: "error", origin, connection, text };
  }
}

/** Keeps the 5-minute alarm while the chosen connection is live: the badge follows only that one. */
export async function ensureAlarm(d: Deps): Promise<void> {
  const s = await loadLocal(d.chrome);
  const chosen = s.selectedOrigin === null ? undefined : s.connections[s.selectedOrigin];
  if (chosen === undefined || chosen.expired || Date.parse(chosen.expires_at) <= d.now()) {
    await d.chrome.alarms.clear(ALARM);
    return;
  }
  if ((await d.chrome.alarms.get(ALARM)) === undefined) {
    await d.chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES });
  }
}

/** Starts the handshake: a fresh nonce for `origin`, and its /extension page in a new tab. */
export async function startConnect(d: Deps, origin: string): Promise<void> {
  if (!isKnownOrigin(origin)) return;
  const nonce = newNonce();
  await addNonce(d.chrome, nonce, origin, d.now());
  await d.chrome.tabs.create({ url: connectUrl(origin, nonce) });
}

/** Stores the connection and keeps the alarm. It asks Probarion nothing, so the connect page gets its answer at once. */
async function keep(d: Deps, origin: string, p: Paired): Promise<void> {
  await putConnection(d.chrome, origin, {
    network: p.network,
    account: p.account,
    token: p.token,
    expires_at: p.expires_at,
    connected_at: new Date(d.now()).toISOString(),
    expired: false,
  });
  await ensureAlarm(d);
}

/**
 * The content script's connect message. It counts only when it comes from Probarion's /extension page in a tab, by
 * this extension's own content script, with a nonce this extension made for that origin in the last 15 minutes. The
 * nonce is used up whatever the answer.
 */
export async function handleConnect(
  d: Deps,
  message: unknown,
  sender: MessageSender,
): Promise<{ ok: boolean }> {
  if (sender.id !== d.chrome.runtime.id || sender.tab === undefined || !isConnectPage(sender)) {
    return { ok: false };
  }
  const m = readConnectMessage(message, d.now());
  if (m === null) return { ok: false };
  if (!(await takeNonce(d.chrome, m.nonce, sender.origin, d.now()))) return { ok: false };
  // The page waits 3 s for this answer (ConnectPanel extensionTookIt(3000)): no inbox read before it.
  await keep(d, sender.origin, m);
  return { ok: true };
}

/** The pairing-code fallback: the code shown on /extension, traded for a token. Throws the ApiError the popup shows. */
export async function connectWithCode(
  d: Deps,
  origin: string,
  code: string,
  label: string,
): Promise<void> {
  if (!isKnownOrigin(origin)) throw new ApiError(400, "bad_origin", "Choose a Probarion address.");
  await keep(d, origin, await api(origin, d.fetch).pair(code, label));
  await refresh(d);
}

/**
 * Disconnect: ends the token on Probarion, then forgets it here. It forgets it even when Probarion can't be reached;
 * `revoked: false` then tells the popup to say where to end it.
 */
export async function disconnect(d: Deps, origin: string): Promise<{ revoked: boolean }> {
  const connection = (await loadLocal(d.chrome)).connections[origin];
  if (connection === undefined) return { revoked: true };
  let revoked = true;
  if (!connection.expired) {
    try {
      await api(origin, d.fetch).revoke(connection.token);
    } catch (error) {
      revoked = error instanceof ApiError && error.status === 401;
    }
  }
  await dropConnection(d.chrome, origin);
  await ensureAlarm(d);
  await refresh(d);
  return { revoked };
}

export async function installMenus(d: Deps): Promise<void> {
  await d.chrome.contextMenus.removeAll();
  d.chrome.contextMenus.create({
    id: MENU_LINK,
    title: "Send invoice to Probarion",
    contexts: ["link"],
  });
  d.chrome.contextMenus.create({
    id: MENU_SELECTION,
    title: "Send selection as invoice text",
    contexts: ["selection"],
  });
}

/**
 * A right-click on a link or a selection. Chrome lets the popup open only during the click, so it is asked first;
 * the invoice is read meanwhile and handed over through chrome.storage.session, which the popup watches. A link is
 * fetched only on the page's own site, where the click's activeTab grant reaches. When the popup can't open, the
 * badge shows "+" until the popup is opened.
 */
export async function handleMenu(d: Deps, info: MenuClick): Promise<void> {
  if (info.menuItemId !== MENU_LINK && info.menuItemId !== MENU_SELECTION) return;
  // Asked first, inside the click. Where Chrome does not offer openPopup to this extension the call throws: that
  // counts as "did not open", and the badge shows "+".
  let opening: Promise<void>;
  try {
    opening = d.chrome.action.openPopup();
  } catch (error) {
    opening = Promise.reject(error);
  }
  const opened = opening.then(
    () => true,
    () => false,
  );
  await setPending(d.chrome, { state: "reading", started_at: d.now(), seen: false });
  let result: CaptureResult;
  try {
    result =
      info.menuItemId === MENU_SELECTION
        ? captureSelection(info.selectionText ?? "")
        : sameOrigin(info.linkUrl, info.pageUrl)
          ? await captureUrl(info.linkUrl ?? "", d.fetch)
          : { ok: false, text: LINK_ELSEWHERE };
  } catch {
    result = { ok: false, text: LINK_ELSEWHERE };
  }
  const seen = await opened;
  await setPending(
    d.chrome,
    result.ok
      ? { state: "ready", item: result.item, seen }
      : { state: "error", text: result.text, seen },
  );
  if (!seen) await refresh(d);
}
