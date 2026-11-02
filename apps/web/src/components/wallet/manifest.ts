/**
 * The wallets the console offers, pinned (ruling W-T6-R1).
 *
 * near-connect 0.11.4 downloads its wallet list from `raw.githubusercontent.com/hot-dao/near-selector/
 * refs/heads/main/...` (jsDelivr as a fallback) and refetches every wallet's executor script on every
 * session. Each executor runs in a sandboxed iframe, but the manifest's `permissions.external` lets that
 * script call methods on any dotted path of OUR `window`. A changed manifest could therefore read our
 * origin, rewrite a receiver, or fabricate a "Done" outcome. So we pass the connector our own manifest
 * object (it then never calls `_loadManifest`), and in it:
 *
 * - every executor URL is `https://raw.githubusercontent.com/<org>/<repo>/<40-hex commit>/<file>`: the
 *   bytes behind it can never change. No branch, no query, no other host;
 * - `permissions.external` holds only the injected objects the executor really calls (read from each
 *   executor at the pinned commit), and never `window`, `document`, `location`, `eval`, `fetch`,
 *   `localStorage` or a parent of them;
 * - wallets whose executor is served from a host we cannot pin (their own domain, a feature branch,
 *   a CDN), or needs WalletConnect (we pass no project id), are not offered.
 *
 * Nothing is vendored: browsers load the executors at run time from the immutable URLs. To add or
 * update a wallet, read the new executor, pin its commit here, and update `EXECUTOR_AUDIT` and the
 * expected table in `manifest.test.ts`.
 *
 * Audited on 2026-11-02 against:
 * - hot-dao/near-selector 9cee11c (2026-10-27), manifest 1.1.0
 * - Meteor-Wallet/meteor_wallet_sdk 911f9d6 (2026-10-28), branch data-storage
 * - near/near-connect-ledger a705e63 (2026-05-15)
 */
import type { Network } from "@/lib/config";

export interface CuratedWallet {
  id: string;
  name: string;
  icon: string;
  description: string;
  website: string;
  /** The upstream wallet version plus the first 7 hex of the pinned commit: a new pin is a new cache key. */
  version: string;
  executor: string;
  type: "sandbox";
  platform: Record<string, string>;
  features: Record<string, boolean>;
  permissions: {
    storage?: boolean;
    allowsOpen?: string[];
    external?: string[];
    usb?: boolean;
    hid?: boolean;
    bluetooth?: boolean;
  };
}

export interface CuratedManifest {
  version: string;
  wallets: CuratedWallet[];
}

const PIN = {
  selector: {
    repo: "hot-dao/near-selector",
    sha: "9cee11c04cfd42f5a420688f808d4aca612b5fde",
  },
  meteor: {
    repo: "Meteor-Wallet/meteor_wallet_sdk",
    sha: "911f9d645b912fadbb1af0d0953cba44b005c82f",
  },
  ledger: {
    repo: "near/near-connect-ledger",
    sha: "a705e63c3543982f8d3d788a216e5e5cb53c676d",
  },
} as const;

type Pin = (typeof PIN)[keyof typeof PIN];

const raw = (pin: Pin, path: string): string =>
  `https://raw.githubusercontent.com/${pin.repo}/${pin.sha}/${path}`;
const version = (upstream: string, pin: Pin): string => `${upstream}+${pin.sha.slice(0, 7)}`;

const LEDGER_ICON =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20768.91%20669.35%22%3E%3Cpath%20style%3D%22stroke%3A%23000%22%20d%3D%22M-2.876-2.76h774.662v674.871H-2.876z%22%2F%3E%3Cpath%20d%3D%22M150.057%20422.845v115.877h176.334v-25.698H175.749v-90.179zm443.103%200v90.179H442.519v25.692h176.334V422.845zM326.647%20246.504v176.334h115.872v-23.174H352.34v-153.16zm-176.59-115.877v115.877h25.692v-90.185h150.642v-25.692zm292.462%200v25.692H593.16v90.185h25.693V130.627z%22%20style%3D%22fill%3A%23fff%22%2F%3E%3C%2Fsvg%3E";

/**
 * Kept, and why:
 * - HOT Wallet: the most used NEAR wallet (mainnet). `external` (Telegram bridges, only for use inside a
 *   Telegram Mini App) is dropped: every call to them is in a try/catch that falls back to a plain popup.
 * - Meteor Wallet: mainnet and testnet, browser extension and web. `meteorCom` and `meteorComV2` are the
 *   objects its extension injects, and the only ones its executor calls.
 * - MyNearWallet: the web wallet, no `external`.
 * - Nightly Wallet: browser extension, mainnet and testnet. Calls only `nightly.near`.
 * - Ledger: hardware signing, which an owner of a value-moving vault should have. USB, HID and Bluetooth
 *   are device-chooser permissions of the sandboxed frame (no access to our page); it has no `external`.
 *
 * Dropped:
 * - Intear, NEAR Mobile, Trezu, Ethereum Wallets: the executor is served from the wallet's own domain
 *   (`wallet.intear.tech`, `*.peersyst.tech`, `trezu.app`, `evm-on-near.dev`), which cannot be pinned.
 * - Hana: pinned to a feature branch of a third-party fork. OKX: a second injected-object wallet we do
 *   not need. NEAR CLI: developer tooling.
 * - Wallet Connect and Unity: need WalletConnect, and we pass no project id.
 */
export const CURATED_MANIFEST: CuratedManifest = {
  version: `1.1.0+${PIN.selector.sha.slice(0, 7)}`,
  wallets: [
    {
      id: "hot-wallet",
      name: "HOT Wallet",
      icon: "https://app.hot-labs.org/images/hot/hot-icon.png",
      description:
        "Secure Multichain wallet. Manage assets, refuel gas, and mine $HOT on any device with HOT Wallet",
      website: "https://hot-labs.org/wallet",
      version: version("1.0.4", PIN.selector),
      executor: raw(PIN.selector, "repository/hotwallet.js"),
      type: "sandbox",
      platform: {
        android: "https://play.google.com/store/apps/details?id=app.herewallet.hot&hl=en",
        ios: "https://apps.apple.com/us/app/hot-wallet/id6740916148",
        chrome:
          "https://chromewebstore.google.com/detail/hot-wallet/mpeengabcnhhjjgleiodimegnkpcenbk",
        firefox: "https://addons.mozilla.org/en-US/firefox/addon/hot-wallet",
        tga: "https://t.me/hot_wallet/app",
      },
      features: {
        signMessage: true,
        signInWithoutAddKey: true,
        signAndSendTransaction: true,
        signAndSendTransactions: true,
        signInAndSignMessage: true,
        signDelegateActions: true,
        signInWithFunctionCallKey: true,
      },
      permissions: {
        storage: true,
        allowsOpen: [
          "https://download.hot-labs.org",
          "https://hot-labs.org/wallet",
          "https://t.me/hot_wallet/app",
          "https://app.hot-labs.org/link",
          "https://play.google.com",
          "https://apps.apple.com",
          "hotwallet://",
          "intent://",
          "https://wallet.near.org",
        ],
        external: [],
      },
    },
    {
      id: "meteor-wallet",
      name: "Meteor Wallet",
      icon: raw(PIN.meteor, "assets/meteor-logo-svg.svg"),
      description:
        "The most simple and secure wallet to manage your crypto, access DeFi, and explore Web3",
      website: "https://meteorwallet.app/",
      version: version("1.1.1", PIN.meteor),
      executor: raw(PIN.meteor, "storage/meteor-near-connect-latest.js"),
      type: "sandbox",
      platform: {
        web: "https://wallet.meteorwallet.app",
        chrome:
          "https://chromewebstore.google.com/detail/meteor-wallet/pcndjhkinnkaohffealmlmhaepkpmgkb",
        android: "https://play.google.com/store/apps/details?id=app.meteorwallet.v2",
        ios: "https://apps.apple.com/us/app/meteor-wallet/id6739558223",
      },
      features: {
        signMessage: true,
        signInWithoutAddKey: true,
        signInAndSignMessage: true,
        signAndSendTransaction: true,
        signAndSendTransactions: true,
        signInWithFunctionCallKey: true,
        signDelegateActions: true,
        mainnet: true,
        testnet: true,
      },
      permissions: {
        storage: true,
        allowsOpen: [
          "https://chromewebstore.google.com",
          "https://wallet.meteorwallet.app",
          "https://meteorwallet.app",
          "meteorwallet://",
          "meteorwalletdev://",
        ],
        external: ["meteorCom", "meteorComV2"],
      },
    },
    {
      id: "mynearwallet",
      name: "MyNearWallet",
      icon: "https://storage.herewallet.app/upload/d0544304123d10518af961a15d5722ff1cef7abf62155f830e6d733e41f7da4b.png",
      description: "Web wallet for NEAR.",
      website: "https://mynearwallet.com",
      version: version("1.0.0", PIN.selector),
      executor: raw(PIN.selector, "repository/mnw.js"),
      type: "sandbox",
      platform: { web: "https://app.mynearwallet.com" },
      features: {
        signMessage: true,
        signInWithoutAddKey: true,
        signInAndSignMessage: true,
        signInWithFunctionCallKey: true,
        signAndSendTransaction: true,
        signAndSendTransactions: true,
      },
      permissions: {
        storage: true,
        allowsOpen: ["https://app.mynearwallet.com"],
      },
    },
    {
      id: "nightly-wallet",
      name: "Nightly Wallet",
      icon: "https://storage.herewallet.app/upload/6947eb5c14c65a715fb49a08e5937dcecc994bf224b3869b9878bd7a7db068f9.webp",
      description: "Surf through the multichain Metaverse with Nightly",
      website: "https://nightly.app",
      version: version("1.0.0", PIN.selector),
      executor: raw(PIN.selector, "repository/nightly.js"),
      type: "sandbox",
      platform: {
        chrome: "https://chromewebstore.google.com/detail/nightly/fiikommddbeccaoicoejoniammnalkfa",
      },
      features: {
        signMessage: true,
        signInWithoutAddKey: true,
        signInAndSignMessage: true,
        signInWithFunctionCallKey: true,
        signAndSendTransaction: true,
        signAndSendTransactions: true,
        testnet: true,
      },
      permissions: {
        storage: true,
        external: ["nightly.near"],
        allowsOpen: [
          "https://nightly.app",
          "https://chromewebstore.google.com/detail/nightly/fiikommddbeccaoicoejoniammnalkfa",
        ],
      },
    },
    {
      id: "ledger",
      name: "Ledger",
      icon: LEDGER_ICON,
      description: "Sign transactions using hardware Ledger devices",
      website: "https://ledger.com",
      version: version("1.0.0", PIN.ledger),
      executor: raw(PIN.ledger, "ledger-executor.js"),
      type: "sandbox",
      platform: {},
      features: {
        signMessage: true,
        signInWithoutAddKey: true,
        signInAndSignMessage: true,
        signInWithFunctionCallKey: true,
        signAndSendTransaction: true,
        signAndSendTransactions: true,
        signDelegateActions: true,
        mainnet: true,
        testnet: true,
      },
      permissions: { storage: true, usb: true, hid: true, bluetooth: true },
    },
  ],
};

/**
 * What was read at the pinned commit: the executor's size and sha256, so a reviewer can fetch the URL
 * and compare. (The connector cannot check a hash itself; the commit in the URL is what pins the bytes.)
 */
export const EXECUTOR_AUDIT: Record<string, { bytes: number; sha256: string }> = {
  "hot-wallet": {
    bytes: 654109,
    sha256: "3139b7ae6930ec7625e464c9f0827c6c00b1999999b605634f9151735ac24d6c",
  },
  "meteor-wallet": {
    bytes: 2002734,
    sha256: "e527150a5cc190826d6f5076098baebb9d666e5d39d30d36b7dcb54ce649df3a",
  },
  mynearwallet: {
    bytes: 1219902,
    sha256: "428055aeb7ea018f2e041babf0bfeb33fcf1f0a69b7865e9887a17b9e6f559ca",
  },
  "nightly-wallet": {
    bytes: 1205035,
    sha256: "6e769f105fb30d37501439287ec901b4d858a503ab195e2e99c06c172c5b5d48",
  },
  ledger: {
    bytes: 116018,
    sha256: "e3b4569f91aa57fe0c4217c4b0cc394a991f582ae7961fb60b0abed5ade51729",
  },
};

// ---------------------------------------------------------------------------------------------
// Validation: run in the unit tests, and again before a connector is built (fail closed).
// ---------------------------------------------------------------------------------------------

/**
 * Path segments of an `external` entity that must never appear: the executor can call any method of the
 * object an entity names (`obj[key](...args)`), so `window`, `document`, a way to reach them (`self`,
 * `top`, `parent`, `opener`, `frames`, `globalThis`), storage, network or code-running globals are out.
 */
export const FORBIDDEN_EXTERNAL_SEGMENTS: ReadonlySet<string> = new Set([
  "window",
  "self",
  "top",
  "parent",
  "opener",
  "frames",
  "globalthis",
  "global",
  "document",
  "location",
  "history",
  "navigator",
  "localstorage",
  "sessionstorage",
  "indexeddb",
  "caches",
  "cookiestore",
  "eval",
  "function",
  "fetch",
  "xmlhttprequest",
  "websocket",
  "eventsource",
  "importscripts",
  "settimeout",
  "setinterval",
  "postmessage",
  "open",
  "constructor",
  "prototype",
  "__proto__",
  "__defineGetter__",
  "__lookupGetter__",
]);

const ALLOWED_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  "storage",
  "allowsOpen",
  "external",
  "usb",
  "hid",
  "bluetooth",
]);
const ALLOWED_OPEN_PROTOCOLS: ReadonlySet<string> = new Set([
  "https:",
  "hotwallet:",
  "intent:",
  "meteorwallet:",
  "meteorwalletdev:",
]);
const EXTERNAL_ENTITY = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const PINNED_PATH = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40}\/[A-Za-z0-9_./-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** Every string inside a JSON-like value, with its path for the error message. */
function* strings(value: unknown, path = "$"): Generator<[string, string]> {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* strings(item, `${path}[${i}]`);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) yield* strings(item, `${path}.${key}`);
  }
}

/** `null` when `url` is a commit-pinned raw.githubusercontent.com file, else the reason it is not. */
export function pinnedUrlProblem(url: string): string | null {
  const u = parseUrl(url);
  if (u === null) return "is not a URL";
  if (u.protocol !== "https:") return "is not https";
  if (u.hostname !== "raw.githubusercontent.com")
    return `is on ${u.hostname}, not raw.githubusercontent.com`;
  if (u.port !== "" || u.username !== "" || u.password !== "") return "has a port or credentials";
  if (u.search !== "" || u.hash !== "") return "has a query or fragment";
  if (url.includes("refs/heads") || /\/(?:main|master|HEAD)\//.test(u.pathname))
    return "names a branch";
  // The URL parser resolves `..` and decodes nothing, so look at the text as written.
  if (/\.\.|%2e|%2f|%5c|\\/i.test(url)) return "has a .. or encoded path segment";
  if (!PINNED_PATH.test(u.pathname)) return "is not <org>/<repo>/<40-hex commit>/<file>";
  return null;
}

/** Every reason this manifest is not safe to hand to the connector. Empty when it is. */
export function validateManifest(manifest: unknown): string[] {
  const problems: string[] = [];
  if (
    !isRecord(manifest) ||
    !Array.isArray(manifest.wallets) ||
    typeof manifest.version !== "string"
  ) {
    return ["manifest must be { version, wallets[] }"];
  }
  const ids = new Set<string>();
  for (const [i, w] of manifest.wallets.entries()) {
    const at = `wallets[${i}]`;
    if (!isRecord(w)) {
      problems.push(`${at} is not an object`);
      continue;
    }
    const id = typeof w.id === "string" ? w.id : "";
    const name = id === "" ? at : id;
    if (id === "") problems.push(`${at} has no id`);
    else if (ids.has(id)) problems.push(`${name}: duplicate id`);
    ids.add(id);
    if (w.type !== "sandbox") problems.push(`${name}: type must be "sandbox"`);

    if (typeof w.executor !== "string") problems.push(`${name}: executor is missing`);
    else {
      const why = pinnedUrlProblem(w.executor);
      if (why !== null) problems.push(`${name}: executor ${why}`);
    }

    if (typeof w.version !== "string" || !/\+[0-9a-f]{7}$/.test(w.version)) {
      problems.push(`${name}: version must end in +<7 hex of the pinned commit>`);
    }

    const p = w.permissions;
    if (!isRecord(p)) problems.push(`${name}: permissions is missing`);
    else {
      for (const key of Object.keys(p)) {
        if (!ALLOWED_PERMISSION_KEYS.has(key))
          problems.push(`${name}: permission "${key}" is not allowed`);
      }
      if (p.external !== undefined) {
        if (!Array.isArray(p.external)) problems.push(`${name}: external must be a list`);
        else {
          for (const entity of p.external) {
            if (typeof entity !== "string" || !EXTERNAL_ENTITY.test(entity)) {
              problems.push(
                `${name}: external entity ${JSON.stringify(entity)} is not a dotted name`,
              );
              continue;
            }
            for (const segment of entity.split(".")) {
              if (FORBIDDEN_EXTERNAL_SEGMENTS.has(segment.toLowerCase())) {
                problems.push(`${name}: external "${entity}" reaches ${segment}`);
              }
            }
          }
        }
      }
      if (p.allowsOpen !== undefined) {
        if (!Array.isArray(p.allowsOpen)) problems.push(`${name}: allowsOpen must be a list`);
        else {
          for (const target of p.allowsOpen) {
            const u = typeof target === "string" ? parseUrl(target) : null;
            if (u === null || !ALLOWED_OPEN_PROTOCOLS.has(u.protocol)) {
              problems.push(`${name}: allowsOpen ${JSON.stringify(target)} is not an allowed link`);
            } else if (u.protocol === "https:" && /^(?:localhost|127\.|\[)/.test(u.hostname)) {
              problems.push(`${name}: allowsOpen ${JSON.stringify(target)} is a local address`);
            }
          }
        }
      }
    }

    if (typeof w.icon === "string" && !/^(?:https:\/\/|data:image\/svg\+xml,)/.test(w.icon)) {
      problems.push(`${name}: icon must be https or an svg data URI`);
    }
  }

  // Anywhere in the manifest: no branch URL, no CDN fallback, and any raw.githubusercontent URL is pinned.
  for (const [path, text] of strings(manifest)) {
    if (text.startsWith("data:")) continue;
    if (text.includes("refs/heads")) problems.push(`${path}: names a branch (refs/heads)`);
    if (/jsdelivr/i.test(text)) problems.push(`${path}: uses jsDelivr`);
    if (/^https?:\/\/raw\.githubusercontent\.com\//i.test(text)) {
      const why = pinnedUrlProblem(text);
      if (why !== null) problems.push(`${path}: ${why}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The connector: our manifest, no debug wallets, no auto-connect.
// ---------------------------------------------------------------------------------------------

/** near-connect's own storage interface (build/helpers/storage.d.ts). */
export interface DataStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** near-connect keeps user-added "debug wallets" under this key (NearConnector.js: registerDebugWallet). */
export const DEBUG_WALLETS_KEY = "debug-wallets";

/**
 * near-connect 0.11.4 has no option to turn debug wallets off. A debug wallet is a manifest the user
 * pastes into the selector, with an executor URL and permissions of their choosing. This storage never
 * reads one back and never saves one, so none survives a reload; `hardenConnector` blocks adding one.
 */
export class GuardedStorage implements DataStorage {
  constructor(private readonly inner: DataStorage) {}
  get(key: string): Promise<string | null> {
    return key === DEBUG_WALLETS_KEY ? Promise.resolve(null) : this.inner.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    if (key !== DEBUG_WALLETS_KEY) await this.inner.set(key, value);
  }
  async remove(key: string): Promise<void> {
    if (key !== DEBUG_WALLETS_KEY) await this.inner.remove(key);
  }
}

/** The connector calls `this.registerDebugWallet` from its selector popup: shadow it on the instance. */
export function hardenConnector<T extends object>(connector: T): T {
  Object.defineProperty(connector, "registerDebugWallet", {
    value: async (): Promise<never> => {
      throw new Error("Adding a debug wallet is turned off");
    },
    writable: false,
    configurable: false,
  });
  return connector;
}

/**
 * Options for `new NearConnector(...)`. The connector reassigns `manifest.wallets` and sets fields on
 * the wallet objects, so it gets its own copy. `autoConnect` is off: it only serves wallets that embed
 * the dapp in an iframe (`near-wallet-injected` messages, which the connector does not origin-check),
 * and the console cannot be framed (`X-Frame-Options: DENY`).
 */
export function connectorOptions(
  network: Network,
  storage: DataStorage,
  manifest: CuratedManifest = CURATED_MANIFEST,
) {
  // Fail closed: a manifest that does not pass is never handed to the connector.
  const problems = validateManifest(manifest);
  if (problems.length > 0) throw new Error(`wallet manifest refused: ${problems.join("; ")}`);
  return {
    network,
    manifest: structuredClone(manifest),
    storage: new GuardedStorage(storage),
    autoConnect: false,
  };
}
