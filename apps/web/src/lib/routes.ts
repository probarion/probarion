/**
 * Pages the site links to before they exist. A link to one of them renders as plain "coming soon" text
 * (or is left out of a menu), so nothing a visitor can click answers 404. When a task builds a page,
 * delete its line here: test/deploy.test.ts fails until you do, and the link goes live on its own.
 * Patterns are `src/app` routes, so `[vault]` stands for any vault.
 */
export const PLANNED_ROUTES: readonly string[] = [];

/** False while the page is planned and not yet built. */
export function isBuilt(route: string): boolean {
  return !PLANNED_ROUTES.includes(route);
}

export interface NavItem {
  route: string;
  label: string;
}

/**
 * /security, /usage and /status are in FOOTER_NAV only:
 * with them, the header's links do not fit in the bar at 1241 px, where it first shows them.
 * The footer still lists Usage and System status with the product pages (FOOTER_PRODUCT in lib/site/facts.ts).
 * Two items are sections of the landing page: the mainnet payouts second, and the status board as What works.
 */
export const SITE_NAV: readonly NavItem[] = [
  { route: "/console", label: "Console" },
  { route: "/#mainnet", label: "Mainnet" },
  { route: "/proof", label: "Proof" },
  { route: "/canary", label: "Canary" },
  { route: "/docs", label: "Docs" },
  { route: "/#status", label: "What works" },
];

export const FOOTER_NAV: readonly NavItem[] = [
  { route: "/terms", label: "Terms" },
  { route: "/privacy", label: "Privacy" },
  { route: "/security", label: "Security" },
  { route: "/usage", label: "Usage" },
  { route: "/status", label: "System status" },
];

/**
 * The tabs of a vault's console, as the path after `/console/<vault>`, in the order a first payment needs them: the
 * agent's key before a mandate, money in the vault before an invoice.
 */
export const VAULT_TABS: readonly { path: string; label: string; isNew?: boolean }[] = [
  { path: "", label: "Overview" },
  { path: "/keys", label: "Keys" },
  // The user's own AI agent, keys made on its machine: the other way to the same first payment as Keys.
  { path: "/agent", label: "Agent (MCP)", isNew: true },
  { path: "/mandates", label: "Mandates" },
  { path: "/topup", label: "Top-up" },
  { path: "/payables", label: "Payables" },
  { path: "/alerts", label: "Alerts" },
];
