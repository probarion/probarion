import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The header's console links stay off /login (site audit P1-7): there they lead to /console, which sends a visitor who
// has not signed in straight back to /login, and the bar's pill outweighs the page's own sign-in button.

const h = vi.hoisted(() => ({ path: "/" as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => h.path }));

import { SiteHeader } from "./SiteHeader";

const render = () => renderToStaticMarkup(createElement(SiteHeader));
const hrefs = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1] ?? "");

beforeEach(() => {
  h.path = "/";
});

describe("the header's console links", () => {
  it("are in the bar and in the phone menu on every other page, and before the path is known", () => {
    for (const path of ["/", "/proof", "/docs", "/console", "/login/x", null]) {
      h.path = path;
      expect(
        hrefs(render()).filter((href) => href === "/console"),
        String(path),
      ).toHaveLength(2);
    }
  });

  it("are left out on /login, in the bar and in the phone menu, and the rest of the header stays", () => {
    for (const path of ["/login", "/login/"]) {
      h.path = path;
      const html = render();
      expect(hrefs(html), path).not.toContain("/console");
      expect(html, path).not.toContain("Open console");
      expect(hrefs(html), path).toContain("/proof");
      expect(html, path).toContain("<details");
    }
  });
});
