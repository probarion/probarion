import type { ChromeLike, StorageArea, StorageChange } from "../src/chrome";

/** A ChromeLike that keeps everything in memory and records what the code did with it. */
export interface FakeChrome extends ChromeLike {
  data: { local: Map<string, unknown>; session: Map<string, unknown> };
  badge: { text: string; color: string | null };
  alarmsSet: Map<string, number>;
  menus: Array<{ id: string; title: string; contexts: string[] }>;
  opened: string[];
  popupOpens: number;
  popupFails: boolean;
  activeUrl: string | undefined;
}

/** What chrome.storage keeps and returns: a JSON copy, so a caller's later change never reaches the store. */
const json = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function area(
  store: Map<string, unknown>,
  fire: (changes: Record<string, StorageChange>) => void,
): StorageArea {
  const keysOf = (k: string | string[]) => (typeof k === "string" ? [k] : k);
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keysOf(keys)) if (store.has(k)) out[k] = json(store.get(k));
      return out;
    },
    async set(items) {
      const changes: Record<string, StorageChange> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: store.get(k), newValue: v };
        store.set(k, json(v));
      }
      fire(changes);
    },
    async remove(keys) {
      const changes: Record<string, StorageChange> = {};
      for (const k of keysOf(keys)) {
        if (!store.has(k)) continue;
        changes[k] = { oldValue: store.get(k) };
        store.delete(k);
      }
      fire(changes);
    },
  };
}

export function fakeChrome(): FakeChrome {
  const changed: Array<(changes: Record<string, StorageChange>, area: string) => void> = [];
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const inert = { addListener: () => {} };
  const c: FakeChrome = {
    data: { local, session },
    badge: { text: "", color: null },
    alarmsSet: new Map(),
    menus: [],
    opened: [],
    popupOpens: 0,
    popupFails: false,
    activeUrl: undefined,
    runtime: {
      id: "testextensionid",
      getURL: (path) => `chrome-extension://testextensionid/${path}`,
      sendMessage: async () => undefined,
      onMessage: inert,
      onInstalled: inert,
      onStartup: inert,
    },
    storage: {
      local: area(local, (ch) => {
        for (const f of changed) f(ch, "local");
      }),
      session: area(session, (ch) => {
        for (const f of changed) f(ch, "session");
      }),
      onChanged: { addListener: (f) => changed.push(f) },
    },
    alarms: {
      create: async (name, info) => {
        c.alarmsSet.set(name, info.periodInMinutes);
      },
      clear: async (name) => c.alarmsSet.delete(name),
      get: async (name) => (c.alarmsSet.has(name) ? { name } : undefined),
      onAlarm: inert,
    },
    action: {
      setBadgeText: async ({ text }) => {
        c.badge.text = text;
      },
      setBadgeBackgroundColor: async ({ color }) => {
        c.badge.color = color;
      },
      openPopup: async () => {
        c.popupOpens += 1;
        if (c.popupFails) throw new Error("Could not find an active browser window.");
      },
    },
    contextMenus: {
      create: (p) => {
        c.menus.push(p);
      },
      removeAll: async () => {
        c.menus.length = 0;
      },
      onClicked: inert,
    },
    tabs: {
      create: async ({ url }) => {
        c.opened.push(url);
        return {};
      },
      query: async () => [{ url: c.activeUrl }],
    },
  };
  return c;
}
