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

const countOf = (inbox: Inbox): number => inbox.counts.awaiting + inbox.counts.held;

/**
 * Whether a captured invoice waits that the popup hasn't shown. It is read just before the badge is set, after the inbox
 * read: an open popup page may have shown the invoice meanwhile.
 */
async function unseen(d: Deps): Promise<boolean> {
  const p = await getPending(d.chrome);
  return p !== null && !p.seen;
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
  if (origin === null || connection === undefined) {
    await setBadge(d, badgeText({ expired: false, pending: await unseen(d), count: 0 }));
    return { kind: "none" };
  }
  const expire = async (): Promise<InboxState> => {
    // Only the connection that got the 401 ends. If a reconnect stored a new token for this address meanwhile, that
    // one is read instead.
    if (!(await markExpired(d.chrome, origin, connection.token))) return refresh(d);
    await d.chrome.alarms.clear(ALARM);
    await setBadge(d, "!");
    return { kind: "expired", origin, connection: { ...connection, expired: true } };
  };
  if (connection.expired || Date.parse(connection.expires_at) <= d.now()) return expire();
  try {
    const inbox = await api(origin, d.fetch).inbox(connection.token);
    await setBadge(
      d,
      badgeText({ expired: false, pending: await unseen(d), count: countOf(inbox) }),
    );
    await ensureAlarm(d);
    return { kind: "ok", origin, connection, inbox };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return expire();
    await ensureAlarm(d); // the connection is live: a person who chose it while Probarion was down gets the alarm back
    if (await unseen(d)) await setBadge(d, "+"); // a capture waits, whatever Probarion answers
    const text = error instanceof ApiError ? error.message : "Something went wrong. Try again.";
    return { kind: "error", origin, connection, text };
  }
}

/**
 * The badge once the popup has shown the captured invoice on `state`'s screen: the count of that inbox, so a "+" set
 * while the invoice waited unseen goes. Nothing changes while another capture waits unseen, or when the chosen
 * connection is no longer the one on the screen (refresh sets the badge for that one).
 */
export async function badgeShown(d: Deps, state: InboxState): Promise<void> {
  if (state.kind !== "ok" || (await unseen(d))) return;
  const s = await loadLocal(d.chrome);
  const chosen = s.selectedOrigin === state.origin ? s.connections[state.origin] : undefined;
  if (chosen === undefined || chosen.expired || chosen.token !== state.connection.token) return;
  await setBadge(d, badgeText({ expired: false, pending: false, count: countOf(state.inbox) }));
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

/**
 * Stores the connection and keeps the alarm. It asks Probarion nothing, so the connect page gets its answer at once.
 * Answers with the token it replaced when the address already had a different one, whatever state that was in.
 */
async function keep(d: Deps, origin: string, p: Paired): Promise<string | null> {
  const replaced = await putConnection(d.chrome, origin, {
    network: p.network,
    account: p.account,
    token: p.token,
    expires_at: p.expires_at,
    connected_at: new Date(d.now()).toISOString(),
    expired: false,
  });
  await ensureAlarm(d);
  return replaced !== undefined && replaced.token !== p.token ? replaced.token : null;
}

/**
 * Ends, on Probarion, a token this extension no longer holds because a new connection replaced it, so that no live
 * token is left that the person can neither see nor end from the extension. Best effort: when Probarion can't be
 * reached the new connection stands, and the old token still ends at its 30-day end or from the Browser extension page.
 * The answer is ignored, so a 401 changes nothing; a token made on the other network, if any, is not reachable from here
 * (see disconnect).
 */
async function endReplaced(d: Deps, origin: string, token: string | null): Promise<void> {
  if (token === null) return;
  try {
    await api(origin, d.fetch).revoke(token);
  } catch {
    // see above
  }
}

/**
 * The content script's connect message, and what follows it. The message counts only when it comes from Probarion's
 * /extension page in a tab, by this extension's own content script, with a nonce this extension made for that origin in
 * the last 15 minutes. The nonce is used up whatever the answer.
 *
 * The page waits 3 s for the answer (ConnectPanel extensionTookIt(3000)), so `sendResponse` comes first and nothing
 * that asks Probarion comes before it. After it: the token this connection replaced is ended, and the inbox is read for
 * the badge (the 5-minute alarm is the fallback). Nothing after the answer can fail the connection.
 */
export async function onConnectMessage(
  d: Deps,
  message: unknown,
  sender: MessageSender,
  sendResponse: (answer: { ok: boolean }) => void,
): Promise<void> {
  let origin: string | null = null;
  let replaced: string | null = null;
  try {
    if (sender.id === d.chrome.runtime.id && sender.tab !== undefined && isConnectPage(sender)) {
      const m = readConnectMessage(message, d.now());
      if (m !== null && (await takeNonce(d.chrome, m.nonce, sender.origin, d.now()))) {
        replaced = await keep(d, sender.origin, m);
        origin = sender.origin;
      }
    }
  } catch {
    origin = null; // it could not be stored: the page is told it was not taken
  }
  sendResponse({ ok: origin !== null });
  if (origin === null) return;
  await Promise.all([endReplaced(d, origin, replaced), refresh(d).catch(() => {})]);
}

/** The pairing-code fallback: the code shown on /extension, traded for a token. Throws the ApiError the popup shows. */
export async function connectWithCode(
  d: Deps,
  origin: string,
  code: string,
  label: string,
): Promise<void> {
  if (!isKnownOrigin(origin)) throw new ApiError(400, "bad_origin", "Choose a Probarion address.");
  const replaced = await keep(d, origin, await api(origin, d.fetch).pair(code, label));
  await Promise.all([endReplaced(d, origin, replaced), refresh(d)]);
}

/**
 * Disconnect: ends the token on Probarion, then forgets it here. It forgets it even when Probarion can't be reached;
 * `revoked: false` then tells the popup to say where to end it. A connection marked expired here is sent the revoke too,
 * since its token can still be live on this address. A 401 counts as ended. The server answers the same 401 for a token
 * that is dead and for one made on the other network, so the extension cannot tell them apart: a token from the other
 * network, if any, is not reachable from here. It is ended on the Browser extension page of its own address, or it
 * expires after 30 days. The connection is forgotten only while it still holds the token that was ended: one stored
 * during the revoke (it can take 15 s) is kept.
 */
export async function disconnect(d: Deps, origin: string): Promise<{ revoked: boolean }> {
  const connection = (await loadLocal(d.chrome)).connections[origin];
  if (connection === undefined) return { revoked: true };
  let revoked = true;
  try {
    await api(origin, d.fetch).revoke(connection.token);
  } catch (error) {
    revoked = error instanceof ApiError && error.status === 401;
  }
  await dropConnection(d.chrome, origin, connection.token);
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
 * fetched only on the page's own site, where the click's activeTab grant reaches. The invoice is stored unseen
 * whether the popup opened or not: the popup marks it seen once its Send section shows it. An open popup can be on
 * Connect, an expired connection or an error, where the invoice is not shown, so until then the badge shows "+".
 */
export async function handleMenu(d: Deps, info: MenuClick): Promise<void> {
  if (info.menuItemId !== MENU_LINK && info.menuItemId !== MENU_SELECTION) return;
  // Asked first, inside the click. Where Chrome does not offer openPopup to this extension the call throws, and where
  // it can't open the popup it rejects: the badge then shows "+" until the person clicks the icon.
  try {
    d.chrome.action.openPopup().catch(() => {});
  } catch {
    // see above
  }
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
  await setPending(
    d.chrome,
    result.ok
      ? { state: "ready", item: result.item, seen: false }
      : { state: "error", text: result.text, seen: false },
  );
  // refresh reads the capture after the inbox, so a popup that showed it meanwhile gets the count, not "+".
  await refresh(d);
}
