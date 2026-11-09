import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import { VaultNav } from "@/components/console/VaultNav";
import { FOOTER_NAV, isBuilt, PLANNED_ROUTES, SITE_NAV, VAULT_TABS } from "./routes";

const hrefs = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1] ?? "");

describe("route registry", () => {
  it("treats only a planned route as not built", () => {
    for (const route of PLANNED_ROUTES) expect(isBuilt(route)).toBe(false);
    expect(isBuilt("/console")).toBe(true);
    expect(new Set(PLANNED_ROUTES).size).toBe(PLANNED_ROUTES.length);
  });

  it("keeps its menus free of duplicates", () => {
    expect(new Set(SITE_NAV.map((i) => i.route)).size).toBe(SITE_NAV.length);
    expect(new Set(FOOTER_NAV.map((i) => i.route)).size).toBe(FOOTER_NAV.length);
    expect(new Set(VAULT_TABS.map((t) => t.path)).size).toBe(VAULT_TABS.length);
  });

  it("orders a vault's tabs the way a first payment needs them: keys before mandates, money before invoices (audit P1-8)", () => {
    expect(VAULT_TABS.map((t) => t.label)).toEqual([
      "Overview",
      "Keys",
      "Mandates",
      "Top-up",
      "Payables",
      "Alerts",
    ]);
  });
});

describe("the Usage page", () => {
  it("is in the footer as Usage, and is built: neither planned nor still called /open", () => {
    expect(FOOTER_NAV).toContainEqual({ route: "/usage", label: "Usage" });
    expect(SITE_NAV.map((i) => i.route)).not.toContain("/usage");
    expect(isBuilt("/usage")).toBe(true);
    expect([...SITE_NAV, ...FOOTER_NAV].map((i) => i.route)).not.toContain("/open");
    expect(PLANNED_ROUTES).not.toContain("/open");
    expect(PLANNED_ROUTES).not.toContain("/usage");
  });
});

describe("the docs", () => {
  it("are in the site menu as Docs, right after the Canary", () => {
    expect(SITE_NAV).toContainEqual({ route: "/docs", label: "Docs" });
    const routes = SITE_NAV.map((i) => i.route);
    expect(routes.indexOf("/docs")).toBe(routes.indexOf("/canary") + 1);
    expect(isBuilt("/docs")).toBe(true);
  });
});

describe("rendered pages link only to pages that are built", () => {
  const planned = (href: string) =>
    PLANNED_ROUTES.some((r) => {
      const re = new RegExp(`^${r.replace(/\[[^\]]+\]/g, "[^/]+")}$`);
      return re.test(href);
    });

  it("on the landing page", () => {
    const out = renderToStaticMarkup(createElement(Home));
    expect(hrefs(out)).toContain("/console");
    expect(hrefs(out).filter(planned)).toEqual([]);
  });

  it("in a vault's tab bar", () => {
    const out = renderToStaticMarkup(
      createElement(VaultNav, { vault: "demo.vaults.probarion.near" }),
    );
    const links = hrefs(out);
    expect(links).toContain("/console/demo.vaults.probarion.near");
    expect(links).toContain("/console/demo.vaults.probarion.near/keys");
    expect(links.filter(planned)).toEqual([]);
  });
});
