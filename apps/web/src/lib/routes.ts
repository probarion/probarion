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
 * /security and /usage are in FOOTER_NAV only:
 * with them, the header's links do not fit in the bar at 1120 px.
 * The footer still lists Usage with the product pages (FOOTER_PRODUCT in lib/site/facts.ts).
 */
export const SITE_NAV: readonly NavItem[] = [
  { route: "/console", label: "Console" },
  { route: "/proof", label: "Proof" },
  { route: "/canary", label: "Canary" },
  { route: "/docs", label: "Docs" },
  { route: "/status", label: "Status" },
];

export const FOOTER_NAV: readonly NavItem[] = [
  { route: "/terms", label: "Terms" },
  { route: "/privacy", label: "Privacy" },
  { route: "/security", label: "Security" },
  { route: "/usage", label: "Usage" },
  { route: "/status", label: "Status" },
];

/** The tabs of a vault's console, as the path after `/console/<vault>`. */
export const VAULT_TABS: readonly { path: string; label: string }[] = [
  { path: "", label: "Overview" },
  { path: "/mandates", label: "Mandates" },
  { path: "/keys", label: "Keys" },
  { path: "/payables", label: "Payables" },
  { path: "/topup", label: "Top-up" },
  { path: "/alerts", label: "Alerts" },
];
