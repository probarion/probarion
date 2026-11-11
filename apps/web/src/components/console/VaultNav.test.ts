import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The vault's tabs say which one is open (site audit P1-21): to the eye with an ink underline, and to a screen
// reader with aria-current="page".

const h = vi.hoisted(() => ({ path: "/" as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => h.path }));

import { isCurrentTab, VaultNav } from "./VaultNav";

const VAULT = "acme.vaults.probarion.testnet";
const BASE = `/console/${VAULT}`;
const render = () => renderToStaticMarkup(createElement(VaultNav, { vault: VAULT }));
/** The `<a>` tags that carry aria-current, as their text. */
const current = (html: string) =>
  [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)]
    .filter((m) => /\saria-current="page"/.test(m[1] ?? ""))
    .map((m) => (m[2] ?? "").replace(/<[^>]+>/g, ""));

beforeEach(() => {
  h.path = BASE;
});

describe("isCurrentTab", () => {
  it("matches the overview only on the vault's own address", () => {
    expect(isCurrentTab(BASE, BASE, "")).toBe(true);
    expect(isCurrentTab(`${BASE}/`, BASE, "")).toBe(true);
    expect(isCurrentTab(`${BASE}/keys`, BASE, "")).toBe(false);
  });

  it("matches a tab on its address and on the pages under it", () => {
    expect(isCurrentTab(`${BASE}/payables`, BASE, "/payables")).toBe(true);
    expect(isCurrentTab(`${BASE}/payables/42`, BASE, "/payables")).toBe(true);
    expect(isCurrentTab(`${BASE}/payablesx`, BASE, "/payables")).toBe(false);
    expect(isCurrentTab(`${BASE}/keys`, BASE, "/payables")).toBe(false);
  });

  it("matches nothing without a path, or on another vault", () => {
    expect(isCurrentTab(null, BASE, "")).toBe(false);
    expect(isCurrentTab("/console/other.testnet/keys", BASE, "/keys")).toBe(false);
  });
});

describe("VaultNav", () => {
  it("marks the open tab, and only that one", () => {
    expect(current(render())).toEqual(["Overview"]);
    h.path = `${BASE}/mandates`;
    expect(current(render())).toEqual(["Mandates"]);
    h.path = `${BASE}/payables/7`;
    expect(current(render())).toEqual(["Payables"]);
  });

  it("links the Agent (MCP) tab after Keys, marks it open on its page, and its new badge is not read out", () => {
    const html = render();
    const keys = html.indexOf(`href="${BASE}/keys"`);
    const agent = html.indexOf(`href="${BASE}/agent"`);
    const mandates = html.indexOf(`href="${BASE}/mandates"`);
    expect(keys).toBeGreaterThan(-1);
    expect(agent).toBeGreaterThan(keys);
    expect(mandates).toBeGreaterThan(agent);
    expect(html).toMatch(
      /Agent \(MCP\)<span aria-hidden="true"[^>]*text-gold-ink[^>]*>new<\/span>/,
    );
    expect([...html.matchAll(/>new<\/span>/g)]).toHaveLength(1);
    h.path = `${BASE}/agent`;
    expect(current(render())).toEqual(["Agent (MCP)new"]);
    h.path = `${BASE}/keys`;
    expect(current(render())).toEqual(["Keys"]);
  });

  it("marks no tab on a page that is not one of them, and never the proof page link", () => {
    h.path = "/console";
    expect(current(render())).toEqual([]);
    h.path = `/proof/${VAULT}`;
    expect(current(render())).toEqual([]);
  });

  it("gives the open tab the ink underline, and every tab a 44px target", () => {
    h.path = `${BASE}/keys`;
    const html = render();
    const tags = [...html.matchAll(/<a\b([^>]*)>/g)].map((m) => m[1] ?? "");
    expect(tags.length).toBeGreaterThan(1);
    for (const tag of tags) expect(tag).toMatch(/class="[^"]*\bmin-h-11\b/);
    const open = tags.filter((t) => t.includes('aria-current="page"'));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatch(/class="[^"]*\bborder-ink\b/);
    expect(open[0]).toMatch(/class="[^"]*\btext-ink\b/);
    for (const t of tags.filter((t) => !t.includes("aria-current"))) {
      expect(t).toMatch(/class="[^"]*\bborder-transparent\b/);
      expect(t).toMatch(/class="[^"]*\btext-mute\b/);
    }
  });

  it("is labelled as the vault's navigation", () => {
    expect(render()).toMatch(/<nav\b[^>]*aria-label="Vault"/);
  });

  it("is one row that scrolls sideways on a phone, so the open tab's underline always sits on the hairline", () => {
    const html = render();
    const cls = /<nav\b[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    const nav = cls.replaceAll("&amp;", "&").split(/\s+/);
    expect(nav).toContain("overflow-x-auto");
    expect(nav).not.toContain("flex-wrap");
    // no scrollbar drawn over the hairline: the cut-off last tab shows there is more
    expect(nav).toEqual(
      expect.arrayContaining(["[scrollbar-width:none]", "[&::-webkit-scrollbar]:hidden"]),
    );
    for (const m of html.matchAll(/<a\b[^>]*class="([^"]*)"/g)) {
      expect((m[1] ?? "").split(/\s+/)).toEqual(
        expect.arrayContaining(["shrink-0", "whitespace-nowrap"]),
      );
    }
  });

  it("gives every tab the same weight, so switching tabs does not move the others", () => {
    h.path = `${BASE}/keys`;
    const weights = [...render().matchAll(/<a\b[^>]*class="([^"]*)"/g)].map(
      (m) => (m[1] ?? "").match(/\bfont-(?:medium|semibold|bold)\b/)?.[0] ?? "",
    );
    expect(new Set(weights).size).toBe(1);
  });
});
