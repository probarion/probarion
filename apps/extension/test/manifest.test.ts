import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEV_ORIGINS,
  manifestFor,
  offeredFor,
  originsFor,
  PLANNED_ORIGINS,
  PROD_ORIGINS,
} from "../scripts/manifest.mjs";
import { DEFAULT_ORIGIN, isKnownOrigin, OFFERED, ORIGINS } from "../src/origins";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
};
const HOSTS = [
  "https://probarion.vercel.app/*",
  "https://probarion.xyz/*",
  "https://testnet.probarion.xyz/*",
];

describe("the manifest", () => {
  const m = manifestFor({ version, dev: false });

  it("asks for exactly four permissions and the three Probarion hosts", () => {
    expect(m.permissions).toEqual(["storage", "contextMenus", "activeTab", "alarms"]);
    expect(m.host_permissions).toEqual(HOSTS);
    expect(JSON.stringify(m)).not.toMatch(/<all_urls>|"tabs"|"scripting"|"cookies"|localhost/);
  });

  it("runs the content script only on the connect page, top frame only", () => {
    // A match pattern covers the path and the query, so `/extension*` would also match /extensions and /extension/x.
    expect(m.content_scripts).toEqual([
      {
        matches: [
          "https://probarion.vercel.app/extension",
          "https://probarion.vercel.app/extension?*",
          "https://probarion.xyz/extension",
          "https://probarion.xyz/extension?*",
          "https://testnet.probarion.xyz/extension",
          "https://testnet.probarion.xyz/extension?*",
        ],
        js: ["content.js"],
        run_at: "document_idle",
      },
    ]);
  });

  it("is Manifest V3 with the package's version and Chrome's default CSP", () => {
    expect(m.manifest_version).toBe(3);
    expect(m.version).toBe("0.1.0");
    expect(m.name).toBe("Probarion");
    expect(m.description.length).toBeLessThanOrEqual(132);
    expect(m.minimum_chrome_version).toBe("127");
    expect(m.background).toEqual({ service_worker: "worker.js" });
    expect(m.action.default_popup).toBe("popup.html");
    expect(Object.keys(m.icons)).toEqual(["16", "32", "48", "128"]);
    expect(m).not.toHaveProperty("content_security_policy");
    expect(m).not.toHaveProperty("externally_connectable");
  });

  it("adds only localhost in a dev build", () => {
    const d = manifestFor({ version, dev: true });
    expect(d.host_permissions).toEqual([...HOSTS, "http://localhost/*"]);
    expect(d.permissions).toEqual(m.permissions);
    expect(d.name).toBe("Probarion (dev)");
  });

  it("trusts in code exactly the origins it asks hosts for", () => {
    expect(ORIGINS).toEqual(PROD_ORIGINS);
    expect(originsFor(false)).toEqual([...PROD_ORIGINS]);
    expect(originsFor(true)).toEqual([...PROD_ORIGINS, ...DEV_ORIGINS]);
    expect(DEFAULT_ORIGIN).toBe("https://probarion.xyz");
    expect(isKnownOrigin("https://probarion.xyz")).toBe(true);
    expect(isKnownOrigin("https://probarion.xyz.evil.example")).toBe(false);
    expect(isKnownOrigin("http://localhost:3000")).toBe(false);
  });

  it("offers on Connect only the addresses that serve Probarion now", () => {
    expect(PLANNED_ORIGINS).toEqual(["https://testnet.probarion.xyz"]);
    expect(offeredFor(false)).toEqual(["https://probarion.vercel.app", "https://probarion.xyz"]);
    expect(offeredFor(true)).toEqual([
      "https://probarion.vercel.app",
      "https://probarion.xyz",
      "http://localhost:3000",
    ]);
    expect(OFFERED).toEqual(offeredFor(false));
    expect(OFFERED).toContain(DEFAULT_ORIGIN);
    expect(isKnownOrigin("https://testnet.probarion.xyz")).toBe(true);
  });
});

describe("the source", () => {
  const files = readdirSync(join(root, "src"), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts"));

  it("builds no HTML from strings and runs no string as code", () => {
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(join(root, "src", f), "utf8");
      expect(text, f).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/,
      );
    }
  });

  it("uses no Node built-in: it runs in Chrome", () => {
    for (const f of files) {
      const text = readFileSync(join(root, "src", f), "utf8");
      expect(text, f).not.toMatch(/from "node:|require\(|\bBuffer\b|\bprocess\./);
    }
  });
});
