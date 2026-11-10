import {
  ALARM,
  type Deps,
  ensureAlarm,
  handleMenu,
  installMenus,
  onConnectMessage,
  refresh,
} from "./background";
import { chromeApi } from "./chrome";

// The service worker. Chrome stops it when idle and starts it again for an event, so every listener is added here at
// the top level, and nothing is kept in memory between events: the state is in chrome.storage.

const deps = (): Deps => ({
  chrome: chromeApi(),
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
});
const c = chromeApi();

c.runtime.onInstalled.addListener(() => {
  void installMenus(deps())
    .then(() => ensureAlarm(deps()))
    .then(() => refresh(deps()));
});

c.runtime.onStartup.addListener(() => {
  void ensureAlarm(deps()).then(() => refresh(deps()));
});

c.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void refresh(deps());
});

c.contextMenus.onClicked.addListener((info) => {
  void handleMenu(deps(), info);
});

c.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const m = message as { type?: unknown; message?: unknown } | null;
  if (typeof m !== "object" || m === null || m.type !== "probarion:connect") return false;
  // The answer to the page goes first, then the inbox read and the rest (background.ts onConnectMessage).
  void onConnectMessage(deps(), m.message, sender, sendResponse);
  return true; // the answer comes later
});
