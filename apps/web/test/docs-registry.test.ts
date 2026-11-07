import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  docsHref,
  findPage,
  mdHref,
  neighbours,
  PAGES,
  pathFromSlug,
  sectionOf,
  sidebarGroups,
  slugParams,
  tabOf,
  visibleTabs,
} from "@/lib/docs/registry";
import { DOCS_DIR } from "@/lib/docs/source";
import { AUDIENCES, DOC_NETWORKS, DOC_TYPES, FEATURE_STATUSES, SECTIONS } from "@/lib/docs/types";
import { DOCS_DIR_TEST, mdxPaths, ROOT } from "./docs-helpers";

describe("the docs registry", () => {
  it("has one MDX file per page and one page per MDX file", () => {
    expect(PAGES.map((p) => p.path).sort()).toEqual(mdxPaths());
  });

  it("reads MDX from the same folder the tests walk", () => {
    expect(DOCS_DIR).toBe(DOCS_DIR_TEST.replace(/[\\/]$/, ""));
  });

  it("keeps paths unique, lowercase, one section deep, in section order", () => {
    const paths = PAGES.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(PAGES[0]?.path).toBe("");
    const order = PAGES.slice(1).map((p) => {
      expect(p.path).toMatch(/^[a-z]+\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
      const section = sectionOf(p.path);
      expect(section, p.path).not.toBeNull();
      return SECTIONS.indexOf(section ?? "start");
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("gives every page a description of 50 to 160 characters, a lede and a title", () => {
    for (const p of PAGES) {
      expect(p.description.length, p.path).toBeGreaterThanOrEqual(50);
      expect(p.description.length, p.path).toBeLessThanOrEqual(160);
      expect(p.title.trim(), p.path).not.toBe("");
      expect(p.lede.trim(), p.path).not.toBe("");
    }
  });

  it("uses only registry words for type, audience, status and network", () => {
    for (const p of PAGES) {
      expect(DOC_TYPES, p.path).toContain(p.type);
      expect(p.audiences.length, p.path).toBeGreaterThan(0);
      expect(new Set(p.audiences).size, p.path).toBe(p.audiences.length);
      for (const a of p.audiences) expect(AUDIENCES, p.path).toContain(a);
      if (p.status !== undefined) expect(FEATURE_STATUSES, p.path).toContain(p.status);
      if (p.network !== undefined) expect(DOC_NETWORKS, p.path).toContain(p.network);
      expect(p.locale).toBe("en");
      expect(p.phase, p.path).toBe(1);
    }
  });

  it("gives every tutorial and how-to a feature status", () => {
    for (const p of PAGES.filter((x) => x.type === "tutorial" || x.type === "how-to")) {
      expect(p.status, p.path).toBeDefined();
    }
  });

  it("only the home is a hub", () => {
    expect(PAGES.filter((p) => p.type === "hub").map((p) => p.path)).toEqual([""]);
  });

  it("records a real reviewed date and sources that exist in the repo", () => {
    for (const p of PAGES) {
      expect(p.reviewed, p.path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${p.reviewed}T00:00:00Z`).toISOString().slice(0, 10), p.path).toBe(
        p.reviewed,
      );
      expect(p.sources.length, p.path).toBeGreaterThan(0);
      for (const s of p.sources) expect(existsSync(join(ROOT, s)), `${p.path}: ${s}`).toBe(true);
    }
  });
});

describe("registry helpers", () => {
  it("round-trip a path through the catch-all's params", () => {
    for (const { slug } of slugParams()) expect(findPage(pathFromSlug(slug))).toBeDefined();
    expect(pathFromSlug()).toBe("");
    expect(pathFromSlug(undefined)).toBe("");
    expect(pathFromSlug(["concepts", "payment-checks"])).toBe("concepts/payment-checks");
  });

  it("build page and twin addresses", () => {
    expect(docsHref("")).toBe("/docs");
    expect(docsHref("concepts/payment-checks")).toBe("/docs/concepts/payment-checks");
    expect(mdHref("")).toBe("/docs.md");
    expect(mdHref("concepts/payment-checks")).toBe("/docs/concepts/payment-checks.md");
  });

  it("list only sections that have pages, and chain the pager in reading order", () => {
    for (const g of sidebarGroups()) expect(g.pages.length).toBeGreaterThan(0);
    const first = PAGES[1];
    if (first) expect(neighbours(first.path).prev?.path).toBe("");
    expect(neighbours("no/such")).toEqual({});
  });

  it("put each page under one tab and show only tabs whose page exists", () => {
    for (const p of PAGES.slice(1)) expect(tabOf(p), p.path).not.toBeNull();
    for (const t of visibleTabs()) expect(findPage(t.path)).toBeDefined();
  });
});
