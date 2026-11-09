/**
 * The code tab a reader picked last ("TypeScript", "Shell"), kept in localStorage. Every access is in a try/catch:
 * storage can be blocked, full or absent, and the page works without it.
 */
const KEY = "probarion:docs:code-tab";

/** Sent on window when a reader picks a tab, so every CodeTabs on the page follows. */
export const CODE_TAB_EVENT = "probarion:docs-code-tab";

function browserStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readCodeTab(store: Storage | null = browserStore()): string | null {
  try {
    return store?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeCodeTab(label: string, store: Storage | null = browserStore()): void {
  try {
    store?.setItem(KEY, label);
  } catch {
    // storage is full or blocked: the choice lasts as long as the page
  }
}
