import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CURATED_MANIFEST,
  type CuratedManifest,
  connectorOptions,
  type DataStorage,
  DEBUG_WALLETS_KEY,
  EXECUTOR_AUDIT,
  FORBIDDEN_EXTERNAL_SEGMENTS,
  GuardedStorage,
  hardenConnector,
  pinnedUrlProblem,
  validateManifest,
} from "./manifest";

const clone = (): CuratedManifest => structuredClone(CURATED_MANIFEST);
const SHA = "9cee11c04cfd42f5a420688f808d4aca612b5fde";
const GOOD = `https://raw.githubusercontent.com/hot-dao/near-selector/${SHA}/repository/hotwallet.js`;

/** The manifest with wallet 0 changed by `edit`, and what the validator says about it. */
function problemsAfter(edit: (w: CuratedManifest["wallets"][number]) => void): string[] {
  const m = clone();
  const first = m.wallets[0];
  if (first === undefined) throw new Error("no wallet");
  edit(first);
  return validateManifest(m);
}

describe("the curated wallet manifest (W-T6-R1)", () => {
  it("passes its own validator", () => {
    expect(validateManifest(CURATED_MANIFEST)).toEqual([]);
  });

  it("offers exactly these wallets, with these pinned executors", () => {
    expect(CURATED_MANIFEST.wallets.map((w) => [w.id, w.executor])).toEqual([
      [
        "hot-wallet",
        `https://raw.githubusercontent.com/hot-dao/near-selector/${SHA}/repository/hotwallet.js`,
      ],
      [
        "meteor-wallet",
        "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/911f9d645b912fadbb1af0d0953cba44b005c82f/storage/meteor-near-connect-latest.js",
      ],
      [
        "mynearwallet",
        `https://raw.githubusercontent.com/hot-dao/near-selector/${SHA}/repository/mnw.js`,
      ],
      [
        "nightly-wallet",
        `https://raw.githubusercontent.com/hot-dao/near-selector/${SHA}/repository/nightly.js`,
      ],
      [
        "ledger",
        "https://raw.githubusercontent.com/near/near-connect-ledger/a705e63c3543982f8d3d788a216e5e5cb53c676d/ledger-executor.js",
      ],
    ]);
  });

  it("gives every wallet only the injected objects its executor calls", () => {
    // Read from each executor at its pinned commit (see manifest.ts): `selector.external("<entity>", ...)`.
    expect(
      Object.fromEntries(CURATED_MANIFEST.wallets.map((w) => [w.id, w.permissions.external ?? []])),
    ).toEqual({
      "hot-wallet": [], // upstream asked for the Telegram bridges: only used inside a Mini App, always in try/catch
      "meteor-wallet": ["meteorCom", "meteorComV2"],
      mynearwallet: [],
      "nightly-wallet": ["nightly.near"],
      ledger: [],
    });
  });

  it("has an audit record (size and sha256) for every offered wallet, and nothing else", () => {
    expect(Object.keys(EXECUTOR_AUDIT).sort()).toEqual(
      CURATED_MANIFEST.wallets.map((w) => w.id).sort(),
    );
    for (const a of Object.values(EXECUTOR_AUDIT)) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.bytes).toBeGreaterThan(0);
    }
  });

  it("makes a new pin a new cache key: every version ends in the pinned commit's first 7 hex", () => {
    for (const w of CURATED_MANIFEST.wallets) {
      const sha = w.executor.split("/")[5];
      expect(w.version.endsWith(`+${sha?.slice(0, 7)}`), w.id).toBe(true);
    }
  });

  it("serialises with no branch, no jsDelivr and no raw URL that is not a commit", () => {
    const text = JSON.stringify(CURATED_MANIFEST);
    expect(text).not.toMatch(/refs\/heads|jsdelivr/i);
    for (const url of text.match(/https:\/\/raw\.githubusercontent\.com\/[^"]+/g) ?? []) {
      expect(pinnedUrlProblem(url), url).toBeNull();
    }
  });

  it("asks for no WalletConnect, clipboard or location permission", () => {
    for (const w of CURATED_MANIFEST.wallets) {
      expect(
        Object.keys(w.permissions)
          .sort()
          .filter(
            (k) => !["storage", "allowsOpen", "external", "usb", "hid", "bluetooth"].includes(k),
          ),
        w.id,
      ).toEqual([]);
    }
  });
});

describe("the validator refuses what must never ship", () => {
  it.each([
    [
      "a branch (refs/heads)",
      `https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/hotwallet.js`,
      /branch|refs\/heads/,
    ],
    [
      "a bare branch name",
      "https://raw.githubusercontent.com/hot-dao/near-selector/main/repository/hotwallet.js",
      /commit|branch/,
    ],
    [
      "a short sha",
      "https://raw.githubusercontent.com/hot-dao/near-selector/9cee11c/repository/hotwallet.js",
      /commit/,
    ],
    [
      "a 39-hex sha",
      `https://raw.githubusercontent.com/hot-dao/near-selector/${SHA.slice(1)}/repository/hotwallet.js`,
      /commit/,
    ],
    [
      "an upper-case sha",
      `https://raw.githubusercontent.com/hot-dao/near-selector/${SHA.toUpperCase()}/repository/hotwallet.js`,
      /commit/,
    ],
    ["a query string", `${GOOD}?nonce=1`, /query/],
    ["a fragment", `${GOOD}#x`, /query|fragment/],
    ["http", GOOD.replace("https:", "http:"), /https/],
    [
      "jsDelivr",
      `https://cdn.jsdelivr.net/gh/hot-dao/near-selector@${SHA}/repository/hotwallet.js`,
      /raw\.githubusercontent\.com/,
    ],
    [
      "the wallet's own domain",
      "https://wallet.intear.tech/near-selector.js",
      /raw\.githubusercontent\.com/,
    ],
    [
      "github.com",
      `https://github.com/hot-dao/near-selector/raw/${SHA}/repository/hotwallet.js`,
      /raw\.githubusercontent\.com/,
    ],
    [
      "a look-alike host",
      `https://raw.githubusercontent.com.evil.example/hot-dao/near-selector/${SHA}/repository/hotwallet.js`,
      /raw\.githubusercontent\.com/,
    ],
    [
      "credentials in the URL",
      `https://raw.githubusercontent.com@evil.example/hot-dao/near-selector/${SHA}/x.js`,
      /raw\.githubusercontent\.com|credentials/,
    ],
    ["a port", `https://raw.githubusercontent.com:8443/hot-dao/near-selector/${SHA}/x.js`, /port/],
    [
      "a .. segment",
      `https://raw.githubusercontent.com/hot-dao/near-selector/${SHA}/../../evil/x/${SHA}/x.js`,
      /\.\. or encoded/,
    ],
    [
      "an encoded slash",
      `https://raw.githubusercontent.com/hot-dao/near-selector/${SHA}/repository%2f..%2fx.js`,
      /\.\. or encoded/,
    ],
    [
      "a backslash",
      `https://raw.githubusercontent.com/hot-dao/near-selector/${SHA}/repository\\hotwallet.js`,
      /\.\. or encoded/,
    ],
    ["a relative path", "/repository/hotwallet.js", /not a URL/],
    ["nothing", "", /not a URL/],
  ])("an executor on %s", (_name, executor, why) => {
    const problems = problemsAfter((w) => {
      w.executor = executor;
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(why);
  });

  it.each([
    "window",
    "document",
    "location",
    "eval",
    "fetch",
    "localStorage",
    "sessionStorage",
    "navigator",
    "self",
    "top",
    "parent",
    "opener",
    "frames",
    "globalThis",
    "history",
    "window.document",
    "window.location.href",
    "document.cookie",
    "top.location",
    "parent.window",
    "self.fetch",
    "nightly.constructor",
    "meteorCom.__proto__",
    "meteorCom.prototype",
    "Window",
    "DOCUMENT",
    "a.eval",
    "XMLHttpRequest",
    "WebSocket",
    "indexedDB",
  ])("an external entity %s", (entity) => {
    const problems = problemsAfter((w) => {
      w.permissions.external = ["nightly.near", entity];
    });
    expect(problems.join("\n"), entity).toMatch(/external/);
  });

  it.each(["", ".", "a..b", "a.", ".a", "a b", "a-b", "a[0]", "a()", "1a", "a;b"])(
    "an external entity that is not a plain dotted name: %j",
    (entity) => {
      const problems = problemsAfter((w) => {
        w.permissions.external = [entity];
      });
      expect(problems.join("\n")).toMatch(/dotted name/);
    },
  );

  it("an external list that is not a list, or holds a non-string", () => {
    expect(
      problemsAfter(
        (w) => ((w.permissions as Record<string, unknown>).external = "nightly.near"),
      ).join(),
    ).toMatch(/list/);
    expect(
      problemsAfter((w) => ((w.permissions as Record<string, unknown>).external = [5])).join(),
    ).toMatch(/dotted name/);
  });

  it.each(["walletConnect", "clipboardRead", "clipboardWrite", "location", "anything"])(
    "a %s permission",
    (key) => {
      const problems = problemsAfter((w) => {
        (w.permissions as Record<string, unknown>)[key] = true;
      });
      expect(problems.join("\n")).toMatch(new RegExp(`permission "${key}" is not allowed`));
    },
  );

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "blob:https://x/y",
    "file:///etc/passwd",
    "http://example.com",
    "about:blank",
    "ftp://x",
    "https://localhost:3000",
    "https://127.0.0.1",
    "not a url",
  ])("an allowsOpen target %s", (target) => {
    const problems = problemsAfter((w) => {
      w.permissions.allowsOpen = [target];
    });
    expect(problems.join("\n")).toMatch(/allowsOpen/);
  });

  it("a non-sandbox wallet, a missing version pin, a duplicate id, an icon off https", () => {
    expect(problemsAfter((w) => ((w as { type: string }).type = "injected")).join()).toMatch(
      /sandbox/,
    );
    expect(problemsAfter((w) => (w.version = "1.0.4")).join()).toMatch(/version/);
    const dup = clone();
    const [first, second] = dup.wallets;
    if (first && second) second.id = first.id;
    expect(validateManifest(dup).join()).toMatch(/duplicate id/);
    expect(problemsAfter((w) => (w.icon = "http://x/y.png")).join()).toMatch(/icon/);
    expect(problemsAfter((w) => (w.icon = "javascript:alert(1)")).join()).toMatch(/icon/);
  });

  it("a branch or jsDelivr URL hidden in any other field", () => {
    expect(
      problemsAfter(
        (w) =>
          (w.icon =
            "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/main/assets/x.svg"),
      ).join(),
    ).toMatch(/\$\.wallets\[0\]\.icon/);
    expect(problemsAfter((w) => (w.website = "https://cdn.jsdelivr.net/gh/x/y")).join()).toMatch(
      /jsDelivr/,
    );
    expect(problemsAfter((w) => (w.platform.web = "https://x/refs/heads/main")).join()).toMatch(
      /refs\/heads/,
    );
  });

  it("a manifest that is not { version, wallets[] }", () => {
    for (const bad of [null, [], {}, { version: "1", wallets: "x" }, { wallets: [] }]) {
      expect(validateManifest(bad), JSON.stringify(bad)).not.toEqual([]);
    }
    expect(validateManifest({ version: "1", wallets: [5] }).join()).toMatch(/not an object/);
  });

  it("covers the globals the executor could reach through an external entity", () => {
    for (const name of ["window", "document", "location", "eval", "fetch", "localstorage"]) {
      expect(FORBIDDEN_EXTERNAL_SEGMENTS.has(name), name).toBe(true);
    }
  });
});

describe("pinnedUrlProblem", () => {
  it("accepts a commit-pinned raw URL", () => {
    expect(pinnedUrlProblem(GOOD)).toBeNull();
  });

  it("says why, in the check that applies first", () => {
    const at = (path: string) => `https://raw.githubusercontent.com/${path}`;
    expect(pinnedUrlProblem("not a url")).toBe("is not a URL");
    expect(pinnedUrlProblem(GOOD.replace("https:", "http:"))).toBe("is not https");
    expect(pinnedUrlProblem("https://example.com/a/b/c.js")).toBe(
      "is on example.com, not raw.githubusercontent.com",
    );
    expect(pinnedUrlProblem(`${GOOD}?nonce=1`)).toBe("has a query or fragment");
    expect(pinnedUrlProblem(`${GOOD}#x`)).toBe("has a query or fragment");
    expect(
      pinnedUrlProblem(at("hot-dao/near-selector/refs/heads/main/repository/hotwallet.js")),
    ).toBe("names a branch");
    expect(pinnedUrlProblem(at("hot-dao/near-selector/main/repository/hotwallet.js"))).toBe(
      "names a branch",
    );
    expect(pinnedUrlProblem(at(`hot-dao/near-selector/${SHA}/../x.js`))).toBe(
      "has a .. or encoded path segment",
    );
    expect(pinnedUrlProblem(at("hot-dao/near-selector/9cee11c/repository/hotwallet.js"))).toBe(
      "is not <org>/<repo>/<40-hex commit>/<file>",
    );
    expect(
      pinnedUrlProblem(`https://raw.githubusercontent.com:8443/hot-dao/near-selector/${SHA}/x.js`),
    ).toBe("has a port or credentials");
  });
});

describe("the debug-wallet switch matches the installed near-connect 0.11.4", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const lib = readFileSync(
    resolve(root, "node_modules/@hot-labs/near-connect/build/NearConnector.js"),
    "utf8",
  );
  const pkg = JSON.parse(
    readFileSync(resolve(root, "node_modules/@hot-labs/near-connect/package.json"), "utf8"),
  ) as { version: string };

  it("is written against this exact version (re-read the connector when it changes)", () => {
    expect(pkg.version).toBe("0.11.4");
  });

  it("the key we guard is the key the connector reads and writes debug wallets under", () => {
    expect(DEBUG_WALLETS_KEY).toBe("debug-wallets");
    expect(lib).toContain(`this.storage.get("${DEBUG_WALLETS_KEY}")`);
    expect(lib).toContain(`this.storage.set("${DEBUG_WALLETS_KEY}"`);
  });

  it("a manifest passed as an object is used as it is: the connector never fetches one from GitHub or jsDelivr", () => {
    // the fetch happens only when the option is missing or a string
    expect(lib).toMatch(/options\?\.manifest == null \|\| typeof options\.manifest === "string"/);
    expect(lib).toMatch(/else \{\s*this\.manifest = options\?\.manifest/);
  });

  it("the connector adds debug wallets through this.registerDebugWallet, which we shadow", () => {
    expect(lib).toMatch(
      /onAddDebugManifest:\s*async\s*\(wallet\)\s*=>\s*this\.registerDebugWallet\(wallet\)/,
    );
    expect(lib).toContain("this.registerDebugWallet(wallet)"); // the stored ones, too
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const calls: string[] = [];
  const storage: DataStorage = {
    async get(key) {
      calls.push(`get ${key}`);
      return data.get(key) ?? null;
    },
    async set(key, value) {
      calls.push(`set ${key}`);
      data.set(key, value);
    },
    async remove(key) {
      calls.push(`remove ${key}`);
      data.delete(key);
    },
  };
  return { storage, data, calls };
}

describe("debug wallets are turned off", () => {
  it("never reads stored debug wallets back, and never saves or removes them", async () => {
    const { storage, data, calls } = memoryStorage({
      [DEBUG_WALLETS_KEY]: '[{"id":"evil","executor":"https://evil.example/x.js"}]',
      "selected-wallet": "meteor-wallet",
    });
    const g = new GuardedStorage(storage);
    expect(await g.get(DEBUG_WALLETS_KEY)).toBeNull();
    await g.set(DEBUG_WALLETS_KEY, "[{}]");
    await g.remove(DEBUG_WALLETS_KEY);
    expect(data.get(DEBUG_WALLETS_KEY)).toBe(
      '[{"id":"evil","executor":"https://evil.example/x.js"}]',
    );
    expect(calls).toEqual([]); // the inner storage was never touched for that key
  });

  it("passes every other key straight through", async () => {
    const { storage, data } = memoryStorage({ "selected-wallet": "meteor-wallet" });
    const g = new GuardedStorage(storage);
    expect(await g.get("selected-wallet")).toBe("meteor-wallet");
    await g.set("selected-wallet", "ledger");
    expect(data.get("selected-wallet")).toBe("ledger");
    await g.remove("selected-wallet");
    expect(data.has("selected-wallet")).toBe(false);
  });

  it("hardenConnector shadows registerDebugWallet on the instance, even though the prototype has one", async () => {
    class Fake {
      registered: unknown[] = [];
      async registerDebugWallet(json: unknown) {
        this.registered.push(json);
        return json;
      }
      // what the selector popup does: it calls through `this`
      popupAdd(json: unknown) {
        return this.registerDebugWallet(json);
      }
    }
    const c = hardenConnector(new Fake());
    await expect(c.popupAdd("{}")).rejects.toThrow(/debug wallet is turned off/);
    await expect(c.registerDebugWallet({})).rejects.toThrow(/turned off/);
    expect(c.registered).toEqual([]);
    expect(() => {
      (c as { registerDebugWallet: unknown }).registerDebugWallet = () => Promise.resolve();
    }).toThrow();
  });
});

describe("connectorOptions", () => {
  const { storage } = memoryStorage();

  it("hands the connector its own copy of the manifest, so it cannot change ours", () => {
    const options = connectorOptions("testnet", storage);
    expect(options.manifest).toEqual(CURATED_MANIFEST);
    expect(options.manifest).not.toBe(CURATED_MANIFEST);
    expect(options.manifest.wallets[0]).not.toBe(CURATED_MANIFEST.wallets[0]);
    // what NearConnector does to the manifest it is given:
    options.manifest.wallets = [];
    expect(CURATED_MANIFEST.wallets).toHaveLength(5);
  });

  it("refuses to build a connector from a manifest that does not pass the validator", () => {
    const bad = clone();
    const first = bad.wallets[0];
    if (first === undefined) throw new Error("no wallet");
    first.executor =
      "https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/hotwallet.js";
    expect(() => connectorOptions("testnet", storage, bad)).toThrow(
      /wallet manifest refused.*branch/,
    );
    const open = clone();
    const w = open.wallets[1];
    if (w === undefined) throw new Error("no wallet");
    w.permissions.external = ["meteorCom", "window"];
    expect(() => connectorOptions("mainnet", storage, open)).toThrow(/reaches window/);
  });

  it("passes the network, turns auto-connect off, and wraps the storage", async () => {
    const options = connectorOptions("mainnet", storage);
    expect(options.network).toBe("mainnet");
    expect(options.autoConnect).toBe(false);
    expect(options.storage).toBeInstanceOf(GuardedStorage);
    expect(await options.storage.get(DEBUG_WALLETS_KEY)).toBeNull();
  });
});
