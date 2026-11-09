import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Root, RootContent } from "mdast";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArchitectureView } from "@/components/docs/ArchitectureDiagram";
import { ChangelogView, renderMdast } from "@/components/docs/Changelog";
import { RefTableView } from "@/components/docs/RefTable";
import { generatedAnchors } from "@/lib/docs/anchors";
import { ARCHITECTURE, type Architecture, edgeLine, layoutProblems } from "@/lib/docs/architecture";
import {
  changelogAnchors,
  changelogHeadings,
  changelogTree,
  rewriteLink,
} from "@/lib/docs/changelog";
import { mdxToMarkdown } from "@/lib/docs/markdown";
import { parseMdx } from "@/lib/docs/mdast";
import { REF_TABLES, refAnchors, refTable } from "@/lib/docs/ref";
import { type RefTable, ROW_ID } from "@/lib/docs/ref/types";
import { ROOT } from "./docs-helpers";

const ORIGIN = "https://probarion.xyz";
const md = (source: string) => mdxToMarkdown(source, { file: "test.mdx", origin: ORIGIN });
const html = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);

const FIXTURE: RefTable = {
  id: "fixture",
  label: "Fixture rows",
  columns: [
    { key: "name", label: "Name" },
    { key: "what", label: "What it does" },
  ],
  rows: [
    { id: "fixture-a", cells: { name: "`alpha`", what: "Reads `x`, then stops." } },
    { cells: { name: "`beta`", what: "Writes." } },
  ],
};

describe("reference tables", () => {
  it("have unique ids, and rows whose ids are unique across every table and a link can name", () => {
    const tables = REF_TABLES.map((t) => t.id);
    expect(new Set(tables).size, "a table id is repeated").toBe(tables.length);
    const rows = REF_TABLES.flatMap((t) => t.rows.flatMap((r) => (r.id ? [r.id] : [])));
    const repeated = rows.filter((id, at) => rows.indexOf(id) !== at);
    expect(repeated, "row ids used twice").toEqual([]);
    for (const id of rows) expect(id, id).toMatch(ROW_ID);
  });

  it("give every row one non-empty cell per column, and no other cell", () => {
    for (const t of [...REF_TABLES, FIXTURE]) {
      const keys = t.columns.map((c) => c.key);
      expect(new Set(keys).size, `${t.id}: a column key is repeated`).toBe(keys.length);
      expect(t.columns.length, `${t.id} has no columns`).toBeGreaterThan(0);
      expect(t.label.trim(), `${t.id} has no label`).not.toBe("");
      for (const [at, r] of t.rows.entries()) {
        expect(Object.keys(r.cells).sort(), `${t.id} row ${at}`).toEqual([...keys].sort());
        for (const k of keys) expect(r.cells[k]?.trim(), `${t.id} row ${at} ${k}`).toBeTruthy();
      }
    }
  });

  it("refuse an unknown id in the page, its twin and its anchors, naming the page", () => {
    expect(() => refTable("nope")).toThrow(/RefTable: unknown id "nope"/);
    expect(() => md('<RefTable id="nope" />')).toThrow(/unknown id "nope" in test\.mdx/);
    expect(() => generatedAnchors(parseMdx('<RefTable id="nope" />'), "x.mdx")).toThrow(
      /unknown id "nope" in x\.mdx/,
    );
    expect(() => md("<RefTable />")).toThrow(/needs id in test\.mdx/);
  });

  it("render as a scrolling table with code cells and anchored rows", () => {
    const out = html(createElement(RefTableView, { table: FIXTURE }));
    expect(out).toContain('aria-label="Fixture rows"');
    expect(out).toContain('<th scope="col">What it does</th>');
    expect(out).toContain('<tr id="fixture-a">');
    expect(out).toContain("<code>alpha</code>");
    expect(out).toContain("Reads <code>x</code>, then stops.");
  });

  it("list each table's row ids as its anchors", () => {
    for (const t of REF_TABLES) {
      expect(refAnchors(t.id)).toEqual(t.rows.flatMap((r) => (r.id ? [r.id] : [])));
    }
  });
});

describe("the changelog", () => {
  const tree = changelogTree();

  it("drops the H1 and keeps the version and section headings", () => {
    expect(tree.children.some((n) => n.type === "heading" && n.depth === 1)).toBe(false);
    const ids = changelogAnchors();
    expect(ids).toContain("unreleased");
    expect(
      ids.filter((id, at) => ids.indexOf(id) !== at),
      "repeated heading ids",
    ).toEqual([]);
  });

  it("renders every node of the real CHANGELOG.md, headings with the ids the anchors list", () => {
    const out = html(createElement(ChangelogView, { tree }));
    const ids = [...out.matchAll(/<h[2-4] id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(changelogAnchors());
    expect(changelogHeadings(tree)).toHaveLength(ids.length);
  });

  it("refuses a Markdown node it does not know, and names it", () => {
    const image = { type: "image", url: "x.png", alt: "x" } as RootContent;
    expect(() => renderMdast([image], new Map())).toThrow(/unsupported Markdown node "image"/);
    const table = { type: "table", children: [] } as unknown as RootContent;
    const root: Root = { type: "root", children: [table] };
    expect(() => html(createElement(ChangelogView, { tree: root }))).toThrow(/"table"/);
  });

  it("opens a relative link on GitHub and leaves other links alone", () => {
    expect(rewriteLink("docs/RUNBOOK.md")).toBe(
      "https://github.com/probarion/probarion/blob/main/docs/RUNBOOK.md",
    );
    expect(rewriteLink("./docs/x.md")).toBe(
      "https://github.com/probarion/probarion/blob/main/docs/x.md",
    );
    expect(rewriteLink("https://probarion.xyz")).toBe("https://probarion.xyz");
    expect(rewriteLink("/docs/build/errors")).toBe("/docs/build/errors");
    expect(rewriteLink("#unreleased")).toBe("#unreleased");
    const links: string[] = [];
    const walk = (n: Root | RootContent) => {
      if (n.type === "link") links.push(n.url);
      if ("children" in n) for (const c of n.children) walk(c);
    };
    walk(tree);
    for (const url of links) expect(url, url).toMatch(/^(https?:|mailto:|\/|#)/);
  });

  it("puts the same sections in the twin", () => {
    const out = md("<Changelog />");
    expect(out).toContain("## Unreleased");
    expect(out).not.toMatch(/^# Changelog/m);
    expect(generatedAnchors(parseMdx("<Changelog />"))).toEqual(changelogAnchors());
  });
});

describe("the architecture diagram", () => {
  it("draws well: arrows name boxes, boxes fit and do not overlap, text fits its box", () => {
    expect(layoutProblems(ARCHITECTURE)).toEqual([]);
  });

  it("names a repository path for every box", () => {
    for (const n of ARCHITECTURE.nodes) {
      expect(existsSync(join(ROOT, n.source)), `${n.id}: ${n.source}`).toBe(true);
    }
  });

  it("catches a bad layout", () => {
    const base = ARCHITECTURE.nodes[0];
    if (!base) throw new Error("no box");
    const bad: Architecture = {
      ...ARCHITECTURE,
      width: 300,
      nodes: [
        base,
        { ...base, id: "twin", x: base.x + 10 },
        {
          ...base,
          id: "wide",
          label: "A label far too long for any box of this size",
          y: ARCHITECTURE.height,
        },
      ],
      edges: [{ from: base.id, to: "ghost", label: "x" }],
    };
    const problems = layoutProblems(bad).join("\n");
    expect(problems).toMatch(/names no box/);
    expect(problems).toMatch(/overlap/);
    expect(problems).toMatch(/outside/);
    expect(problems).toMatch(/label is wider than its box/);
  });

  it("is an image with a title and a description, and arrows that end on box borders", () => {
    const out = html(createElement(ArchitectureView, { arch: ARCHITECTURE }));
    expect(out).toContain('role="img"');
    expect(out).toContain(`<title id="arch-title">${ARCHITECTURE.title}</title>`);
    expect(out).toContain('viewBox="0 0');
    for (const e of ARCHITECTURE.edges) {
      const l = edgeLine(ARCHITECTURE, e);
      expect(Number.isFinite(l.x1 + l.y1 + l.x2 + l.y2), `${e.from} → ${e.to}`).toBe(true);
    }
  });

  it("lists the same boxes and arrows in the twin", () => {
    const out = md("<ArchitectureDiagram />");
    for (const n of ARCHITECTURE.nodes) expect(out).toContain(`**${n.label}**`);
    for (const e of ARCHITECTURE.edges) expect(out).toContain(e.label);
  });
});
