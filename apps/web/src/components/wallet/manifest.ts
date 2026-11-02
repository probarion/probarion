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
 *   executor at the pinned commit), and only from an exact allowlist (`ALLOWED_EXTERNAL_ENTITIES`):
 *   `meteorCom`, `meteorComV2`, `nightly.near`. Anything else is refused, so `window`, `document`,
 *   `location`, `eval`, `fetch`, `localStorage` and every way to reach them can never be added;
 * - icons are our own files under `public/wallets` (or an svg data URI), never a third-party image host
 *   (W-T6-R2); see `ICON_AUDIT` for where each came from;
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

/**
 * Meteor's logo as an svg data URI (percent-encoded, byte for byte the file in ICON_AUDIT): an svg file
 * under public/ would be linted as code, and a data URI cannot be swapped by editing a hosted file.
 */
const METEOR_ICON =
  "data:image/svg+xml,%3Csvg%20data-name%3D%22Layer%201%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20xmlns%3Axlink%3D%22http%3A%2F%2Fwww.w3.org%2F1999%2Fxlink%22%20viewBox%3D%220%200%20400.04%20400.04%22%3E%0A%20%20%3Cdefs%3E%0A%20%20%20%20%3ClinearGradient%20id%3D%22a%22%20x1%3D%22215.39%22%20y1%3D%22239.47%22%20x2%3D%22382.38%22%20y2%3D%22239.47%22%20gradientTransform%3D%22translate(-122.96%20-148.16)%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22.07%22%20stop-color%3D%22%230f0f36%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22.76%22%20stop-color%3D%22%23232371%22%2F%3E%0A%20%20%20%20%3C%2FlinearGradient%3E%0A%20%20%20%20%3ClinearGradient%20id%3D%22b%22%20x1%3D%22285.49%22%20y1%3D%22335.04%22%20x2%3D%22469.44%22%20y2%3D%22335.04%22%20gradientTransform%3D%22translate(-78.4%20-231.71)%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%22%20stop-color%3D%22%230f0f36%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22.8%22%20stop-color%3D%22%23232371%22%2F%3E%0A%20%20%20%20%3C%2FlinearGradient%3E%0A%20%20%20%20%3ClinearGradient%20id%3D%22c%22%20x1%3D%22298.99%22%20y1%3D%22428.49%22%20x2%3D%22366.74%22%20y2%3D%22428.49%22%20gradientTransform%3D%22translate(.74%20-227.54)%22%20xlink%3Ahref%3D%22%23a%22%2F%3E%0A%20%20%20%20%3ClinearGradient%20id%3D%22d%22%20x1%3D%2236.6%22%20y1%3D%22332.92%22%20x2%3D%22431.62%22%20y2%3D%22332.92%22%20gradientTransform%3D%22rotate(-45%2058.56%20313.83)%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23479ff5%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22.22%22%20stop-color%3D%22%23405ee5%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22.35%22%20stop-color%3D%22%23523bda%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22.43%22%20stop-color%3D%22%235a55ce%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22.56%22%20stop-color%3D%22%235a55ce%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22.76%22%20stop-color%3D%22%233b3cbb%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%22.87%22%20stop-color%3D%22%23171e9b%22%2F%3E%0A%20%20%20%20%20%20%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23171e9b%22%2F%3E%0A%20%20%20%20%3C%2FlinearGradient%3E%0A%20%20%3C%2Fdefs%3E%0A%20%20%3Cpath%20d%3D%22M105%2065.29h128.39a26%2026%200%200%201%2026%2026%2026%2026%200%200%201-26%2026H105a12.54%2012.54%200%200%201-12.57-12.49v-27A12.54%2012.54%200%200%201%20105%2065.29Z%22%20transform%3D%22rotate(-45%20175.92%2091.31)%22%20fill%3D%22url(%23a)%22%2F%3E%0A%20%20%3Cpath%20d%3D%22M220.2%2076.74h144.24A26.59%2026.59%200%200%201%20391%20103.33a26.59%2026.59%200%200%201-26.59%2026.59H220.2a13.11%2013.11%200%200%201-13.11-13.11v-27a13.11%2013.11%200%200%201%2013.11-13.07Z%22%20transform%3D%22rotate(-45%20299.06%20103.33)%22%20fill%3D%22url(%23b)%22%2F%3E%0A%20%20%3Crect%20x%3D%22299.73%22%20y%3D%22176.9%22%20width%3D%2267.75%22%20height%3D%2248.08%22%20rx%3D%2224.04%22%20transform%3D%22rotate(-45%20333.6%20200.95)%22%20fill%3D%22url(%23c)%22%2F%3E%0A%20%20%3Cpath%20d%3D%22m339.09%2099.35-64.8%2064.8a25.5%2025.5%200%200%201-36.05%200%2025.49%2025.49%200%200%201%200-36L252%20114.37c8.68-8.69%209.33-22.93.81-31.77a22.3%2022.3%200%200%200-31.81-.29l-60.82%2060.83a25.49%2025.49%200%200%201-36%200%2025.5%2025.5%200%200%201%200-36.06l20.26-20.27a22.31%2022.31%200%200%200-.3-31.83c-8.84-8.52-23.08-7.86-31.76.82l-55%2055c-.26.25-.48.53-.72.79A163.53%20163.53%200%200%200%20287.8%20342.86l-.2-.2c.26-.24.53-.46.79-.72l97.09-97.09c8.68-8.68%209.34-22.92.81-31.76a22.31%2022.31%200%200%200-31.83-.3s18.18-18.15-9.8%209.86a23.25%2023.25%200%200%201-32.9%200%2023.25%2023.25%200%200%201%200-32.9l59.39-59.39a22.31%2022.31%200%200%200-.3-31.83c-8.85-8.53-23.08-7.86-31.76.82Z%22%20fill%3D%22url(%23d)%22%2F%3E%0A%20%20%3Crect%20x%3D%2262.59%22%20y%3D%2294.34%22%20width%3D%2250.97%22%20height%3D%2225.49%22%20rx%3D%2212.74%22%20transform%3D%22rotate(-45%2088.07%20107.1)%22%20fill%3D%22%23a4a1ef%22%2F%3E%0A%20%20%3Ccircle%20cx%3D%22124.11%22%20cy%3D%2271.04%22%20r%3D%2212.74%22%20fill%3D%22%23c2bffc%22%2F%3E%0A%20%20%3Crect%20x%3D%22208.62%22%20y%3D%2289.84%22%20width%3D%2238.23%22%20height%3D%2225.49%22%20rx%3D%2212.74%22%20transform%3D%22rotate(-45%20227.74%20102.58)%22%20fill%3D%22%23786bee%22%2F%3E%0A%3C%2Fsvg%3E%0A";

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
      icon: "/wallets/hot-wallet.png",
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
        // Read from hotwallet.js at the pinned commit (`window.selector.open(...)`, the only opener):
        // - https://download.hot-labs.org?hotconnector           (get the extension)
        // - https://t.me/hot_wallet/app?startapp=hotcall-<id>    (Telegram)
        // - https://app.hot-labs.org/link?hotcall-<id>           (universal link, and the Android fallback)
        // - intent://hotcall-<id>#Intent;scheme=hotwallet;package=app.herewallet.hot;...;end (Android)
        // The last has a different host on every request (<id> is a hash of the request), and
        // near-connect compares the host exactly, so `intent://` cannot be narrowed to a host. ACCEPTED:
        // it lets this commit-pinned executor open an Android intent link from a user tap, nothing
        // more. The old entries nobody opens (hotwallet://, the app stores, wallet.near.org,
        // hot-labs.org/wallet) are gone.
        allowsOpen: [
          "https://download.hot-labs.org",
          "https://t.me/hot_wallet/app",
          "https://app.hot-labs.org/link",
          "intent://",
        ],
        external: [],
      },
    },
    {
      id: "meteor-wallet",
      name: "Meteor Wallet",
      icon: METEOR_ICON,
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
      icon: "/wallets/mynearwallet.png",
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
      icon: "/wallets/nightly-wallet.webp",
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
 * Where each wallet icon came from. They are images, not code; each was fetched once on 2026-11-02
 * (Meteor's from its commit-pinned URL, the other three from the wallet's own host), checked for its
 * file signature (PNG, WEBP) or, for the svg, for scripts, handlers and external references, and
 * committed: the PNG and WEBP as files under `public/wallets` (`file`), Meteor's svg as the data URI
 * `METEOR_ICON` (no `file`). Ledger's icon is the svg data URI from its upstream manifest, not audited
 * here. The tests compare the sha256 of what is in the repo with the record, so a changed image fails.
 */
export const ICON_AUDIT: Record<
  string,
  { file?: string; source: string; bytes: number; sha256: string }
> = {
  "hot-wallet": {
    file: "hot-wallet.png",
    source: "https://app.hot-labs.org/images/hot/hot-icon.png",
    bytes: 45296,
    sha256: "3390b7e4e15fed4122572898712bdf4c6ede862e36150203deecacc4f8bbe5ae",
  },
  "meteor-wallet": {
    source:
      "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/911f9d645b912fadbb1af0d0953cba44b005c82f/assets/meteor-logo-svg.svg",
    bytes: 2816,
    sha256: "9c3981ca59212248e09d37011c07492bf1e19d7d55b9210213af3be6079a05ae",
  },
  mynearwallet: {
    file: "mynearwallet.png",
    source:
      "https://storage.herewallet.app/upload/d0544304123d10518af961a15d5722ff1cef7abf62155f830e6d733e41f7da4b.png",
    bytes: 11051,
    sha256: "f907c2e6d0971cd6cb458e9d62519eea58083064af886176837f80763346db24",
  },
  "nightly-wallet": {
    file: "nightly-wallet.webp",
    source:
      "https://storage.herewallet.app/upload/6947eb5c14c65a715fb49a08e5937dcecc994bf224b3869b9878bd7a7db068f9.webp",
    bytes: 12226,
    sha256: "6947eb5c14c65a715fb49a08e5937dcecc994bf224b3869b9878bd7a7db068f9",
  },
  // ledger: an svg data URI inside the manifest (from the upstream manifest), no file
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
 * The only `permissions.external` entities any wallet may have, exactly. An executor can call any
 * method of the object an entity names (`obj[key](...args)` on our `window`), so this is a list of
 * what is allowed, not of what is forbidden: nothing else can be added by mistake, however it is
 * spelled. Each is an object a wallet extension injects, read from the executor that uses it.
 */
export const ALLOWED_EXTERNAL_ENTITIES: readonly string[] = [
  "meteorCom",
  "meteorComV2",
  "nightly.near",
];

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
  "intent:",
  "meteorwallet:",
  "meteorwalletdev:",
]);
const PINNED_PATH = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40}\/[A-Za-z0-9_./-]+$/;
const LOCAL_ICON = /^\/wallets\/[a-z0-9-]+\.(?:png|svg|webp)$/;
const SVG_DATA_URI = /^data:image\/svg\+xml,[A-Za-z0-9%._~!*'()-]+$/;

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
            if (typeof entity !== "string" || !ALLOWED_EXTERNAL_ENTITIES.includes(entity)) {
              problems.push(
                `${name}: external ${JSON.stringify(entity)} is not on the allowlist (${ALLOWED_EXTERNAL_ENTITIES.join(", ")})`,
              );
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

    // No third-party image host (it would see every visitor who opens the selector): an icon is one of
    // our own files under /wallets, or an svg data URI.
    if (typeof w.icon !== "string" || !(LOCAL_ICON.test(w.icon) || SVG_DATA_URI.test(w.icon))) {
      problems.push(
        `${name}: icon must be one of ours (/wallets/<name>.png|svg|webp) or an svg data URI`,
      );
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
