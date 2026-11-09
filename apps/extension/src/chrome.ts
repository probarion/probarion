// The few chrome.* APIs the extension uses, typed here rather than with @types/chrome. The code takes a ChromeLike, so
// the tests run it on a fake (test/fake-chrome.ts).

export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface ChromeEvent<F> {
  addListener(listener: F): void;
}

export interface MessageSender {
  id?: string;
  origin?: string;
  url?: string;
  tab?: { id?: number };
}

export interface MenuClick {
  menuItemId: string | number;
  linkUrl?: string;
  pageUrl?: string;
  selectionText?: string;
}

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export interface ChromeLike {
  runtime: {
    id: string;
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: ChromeEvent<
      (message: unknown, sender: MessageSender, sendResponse: (answer: unknown) => void) => boolean
    >;
    onInstalled: ChromeEvent<() => void>;
    onStartup: ChromeEvent<() => void>;
  };
  storage: {
    local: StorageArea;
    session: StorageArea;
    onChanged: ChromeEvent<(changes: Record<string, StorageChange>, area: string) => void>;
  };
  alarms: {
    create(name: string, info: { periodInMinutes: number }): Promise<void>;
    clear(name: string): Promise<boolean>;
    get(name: string): Promise<{ name: string } | undefined>;
    onAlarm: ChromeEvent<(alarm: { name: string }) => void>;
  };
  action: {
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
    openPopup(): Promise<void>;
  };
  contextMenus: {
    create(properties: { id: string; title: string; contexts: string[] }): void;
    removeAll(): Promise<void>;
    onClicked: ChromeEvent<(info: MenuClick) => void>;
  };
  tabs: {
    create(properties: { url: string }): Promise<unknown>;
    query(query: { active: boolean; currentWindow: boolean }): Promise<Array<{ url?: string }>>;
  };
}

/** Chrome's own `chrome` object, seen through ChromeLike. */
export const chromeApi = (): ChromeLike => (globalThis as unknown as { chrome: ChromeLike }).chrome;

/** `fetch` as the extension calls it. The tests pass a fake. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
