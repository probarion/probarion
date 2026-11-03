import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RouteLink } from "./RouteLink";

// A fixed registry, so these tests say how the component behaves whatever pages exist today.
vi.mock("@/lib/routes", () => ({ isBuilt: (route: string) => route !== "/soon" }));

const html = (props: Parameters<typeof RouteLink>[0]) =>
  renderToStaticMarkup(createElement(RouteLink, props));

describe("RouteLink", () => {
  it("is an ordinary link to a page that is built", () => {
    expect(html({ route: "/console", className: "u", children: "Console" })).toBe(
      '<a class="u" href="/console">Console</a>',
    );
  });

  it("links the concrete address when the route is a pattern", () => {
    expect(html({ route: "/console/[vault]", href: "/console/v.near", children: "Vault" })).toBe(
      '<a href="/console/v.near">Vault</a>',
    );
  });

  it("shows a planned page as plain text marked coming soon, with no link", () => {
    const out = html({ route: "/soon", children: "Soon page" });
    expect(out).not.toContain("<a");
    expect(out).not.toContain("href");
    expect(out).toContain("Soon page");
    expect(out).toContain("coming soon");
  });

  it("leaves a planned page out of a menu when asked to hide it", () => {
    expect(html({ route: "/soon", whenPlanned: "hide", children: "Soon page" })).toBe("");
  });
});
