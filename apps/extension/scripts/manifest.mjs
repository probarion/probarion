// The extension's manifest (spec §5.2), for a release or for a local `next dev` (--dev). test/manifest.test.ts pins it.

/** Where Probarion runs: the hosts the extension may reach, and the only origins its code trusts. */
export const PROD_ORIGINS = Object.freeze([
  "https://probarion.vercel.app",
  "https://probarion.xyz",
  "https://testnet.probarion.xyz",
]);

/** A local `next dev`, in a --dev build only. Never in the store zip. */
export const DEV_ORIGINS = Object.freeze(["http://localhost:3000"]);

/**
 * Hosts the manifest asks for before they serve anything: testnet.probarion.xyz is added when the mainnet factory is
 * live (docs/runbooks/web-deploy.md). The code trusts them, but Connect does not offer them. Remove an origin from
 * this list once it serves Probarion.
 */
export const PLANNED_ORIGINS = Object.freeze(["https://testnet.probarion.xyz"]);

export const PERMISSIONS = Object.freeze(["storage", "contextMenus", "activeTab", "alarms"]);

export const DESCRIPTION =
  "Queue invoices into Probarion and see what waits for your signature. It can't pay or approve.";

const ICONS = { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" };

/** The origins a build trusts. */
export function originsFor(dev) {
  return dev ? [...PROD_ORIGINS, ...DEV_ORIGINS] : [...PROD_ORIGINS];
}

/** The origins Connect offers. */
export function offeredFor(dev) {
  return originsFor(dev).filter((o) => !PLANNED_ORIGINS.includes(o));
}

/** `scheme://host/*`. A match pattern without a port covers every port of the host. */
const hostPattern = (origin) => {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
};

export function manifestFor({ version, dev }) {
  const hosts = [...new Set(originsFor(dev).map(hostPattern))];
  return {
    manifest_version: 3,
    name: dev ? "Probarion (dev)" : "Probarion",
    version,
    description: DESCRIPTION,
    minimum_chrome_version: "127",
    icons: ICONS,
    action: {
      default_title: "Probarion",
      default_popup: "popup.html",
      default_icon: { 16: ICONS[16], 32: ICONS[32] },
    },
    background: { service_worker: "worker.js" },
    permissions: [...PERMISSIONS],
    host_permissions: hosts,
    content_scripts: [
      {
        matches: hosts.map((h) => `${h.slice(0, -2)}/extension*`),
        js: ["content.js"],
        run_at: "document_idle",
      },
    ],
  };
}
