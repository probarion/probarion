import type { Root, RootContent } from "mdast";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArchitectureView } from "@/components/docs/ArchitectureDiagram";
import { ChangelogView, renderMdast } from "@/components/docs/Changelog";
import d from "@/components/docs/docs.module.css";
import { DocLink, H2, H3 } from "@/components/docs/prose";
import { RefTableView } from "@/components/docs/RefTable";
import { generatedAnchors } from "@/lib/docs/anchors";
import { ARCHITECTURE, type Architecture, edgeLine, layoutProblems } from "@/lib/docs/architecture";
import {
  changelogAnchors,
  changelogHeadings,
  changelogToc,
  changelogTree,
  plainText,
  rewriteLink,
} from "@/lib/docs/changelog";
import { mdxToMarkdown } from "@/lib/docs/markdown";
import { jsxNodes, parseMarkdown, parseMdx } from "@/lib/docs/mdast";
import { REF_TABLES, refAnchors, refTable } from "@/lib/docs/ref";
import { type RefTable, ROW_ID } from "@/lib/docs/ref/types";
import { PAGES } from "@/lib/docs/registry";
import { linkProblem, readMdx } from "./docs-helpers";

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

  it("list as each table's anchors the row ids the rendered table carries", () => {
    for (const t of REF_TABLES) {
      const out = html(createElement(RefTableView, { table: t }));
      expect(
        [...out.matchAll(/<tr id="([^"]+)"/g)].map((m) => m[1]),
        t.id,
      ).toEqual(refAnchors(t.id));
    }
  });
});

describe("components with a page of their own", () => {
  it("put Changelog and ArchitectureDiagram on their own pages only", () => {
    // From the parsed page, so `<Changelog/>` or a prop counts as well as `<Changelog />`. Only a
    // page whose source names the tag can hold the element, so only those are parsed.
    const on = (tag: string) =>
      PAGES.filter((p) => {
        const source = readMdx(p.path);
        return source.includes(`<${tag}`) && jsxNodes(parseMdx(source)).some((n) => n.name === tag);
      }).map((p) => p.path);
    expect(on("Changelog")).toEqual(["resources/changelog"]);
    expect(on("ArchitectureDiagram")).toEqual(["operate/architecture"]);
  });
});

/** The URL of every link and image in a tree, in document order. */
function urlsIn(node: Root | RootContent): string[] {
  const own = node.type === "link" || node.type === "image" ? [node.url] : [];
  const kids = "children" in node ? (node.children as RootContent[]).flatMap(urlsIn) : [];
  return [...own, ...kids];
}

/** The `href` of every element in rendered HTML, its entities decoded. */
const hrefsIn = (out: string) =>
  [...out.matchAll(/\shref="([^"]*)"/g)].map((m) =>
    (m[1] ?? "")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&"),
  );

/** The GitHub links that point anywhere but the probarion organisation. */
const foreignGitHub = (urls: readonly string[]) =>
  urls.filter((u) => {
    try {
      const url = new URL(u);
      return (
        (url.hostname === "github.com" || url.hostname === "www.github.com") &&
        !/^\/probarion(?:\/|$)/.test(url.pathname)
      );
    } catch {
      return false;
    }
  });

describe("the changelog", () => {
  const tree = changelogTree();
  const heads = changelogHeadings(tree);

  it("drops the H1 and keeps the version and section headings", () => {
    expect(tree.children.some((n) => n.type === "heading" && n.depth === 1)).toBe(false);
    const ids = changelogAnchors();
    expect(ids).toContain("unreleased");
    expect(ids).toContain("unreleased-added");
  });

  it("starts each section's id with its version's, and uses no id twice", () => {
    let version: string | undefined;
    for (const h of heads) {
      if (h.node.depth === 2) version = h.id;
      else {
        expect(version, `${h.id}: a section before any version`).toBeDefined();
        expect(h.id.startsWith(`${version}-`), `${h.id} under ${version}`).toBe(true);
      }
    }
    const ids = heads.map((h) => h.id);
    expect(
      ids.filter((id, at) => ids.indexOf(id) !== at),
      "repeated heading ids",
    ).toEqual([]);
  });

  it("keeps a section's id when a new release is cut above it", () => {
    const ids = (source: string) => changelogHeadings(parseMarkdown(source)).map((h) => h.id);
    expect(ids("## Unreleased\n\n### Added\n\n## 0.1.0 - 2026-11-09\n\n### Added\n")).toEqual([
      "unreleased",
      "unreleased-added",
      "010---2026-11-09",
      "010---2026-11-09-added",
    ]);
    expect(
      ids(
        "## Unreleased\n\n### Added\n\n## 0.2.0\n\n### Added\n\n## 0.1.0 - 2026-11-09\n\n### Added\n",
      ).at(-1),
    ).toBe("010---2026-11-09-added");
    // Two sections of one name under one version would share an id: the test above fails on it.
    expect(ids("## 1.0.0\n\n### Added\n\n### Added\n")).toEqual(["100", "100-added", "100-added"]);
  });

  it("renders every node of the real CHANGELOG.md, headings anchored with the ids the anchors list", () => {
    const out = html(createElement(ChangelogView, { tree }));
    const ids = [...out.matchAll(/<h[2-4] id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(changelogAnchors());
    expect(heads).toHaveLength(ids.length);
    for (const id of ids) {
      expect(out, id).toContain(`<a class="${d.anchor}" href="#${id}"`);
    }
  });

  it("gives the page an On this page list of its versions and sections", () => {
    const toc = changelogToc(tree);
    expect(toc.map((t) => t.id)).toEqual(heads.filter((h) => h.node.depth <= 3).map((h) => h.id));
    expect(toc[0]).toEqual({ id: "unreleased", text: "Unreleased", depth: 2 });
    for (const [at, t] of toc.entries()) {
      const h = heads.find((x) => x.id === t.id);
      expect(t.text, t.id).toBe(h ? plainText(h.node) : "");
      expect(t.text.trim(), `toc entry ${at}`).not.toBe("");
    }
  });

  it("refuses a Markdown node it does not know, and names it", () => {
    const image = { type: "image", url: "x.png", alt: "x" } as RootContent;
    expect(() => renderMdast([image], new Map())).toThrow(/unsupported Markdown node "image"/);
    const table = { type: "table", children: [] } as unknown as RootContent;
    const root: Root = { type: "root", children: [table] };
    expect(() => html(createElement(ChangelogView, { tree: root }))).toThrow(/"table"/);
    // A reference-style link fails the build too: its reference and its definition.
    const refs = parseMarkdown("See [the runbook][rb].\n\n[rb]: docs/RUNBOOK.md\n").children;
    expect(() => renderMdast(refs.slice(0, 1), new Map())).toThrow(/"linkReference"/);
    expect(() => renderMdast(refs.slice(1), new Map())).toThrow(/"definition"/);
  });

  it("opens a relative link on GitHub and makes a link to this site a site path", () => {
    expect(rewriteLink("docs/RUNBOOK.md")).toBe(
      "https://github.com/probarion/probarion/blob/main/docs/RUNBOOK.md",
    );
    expect(rewriteLink("./docs/x.md")).toBe(
      "https://github.com/probarion/probarion/blob/main/docs/x.md",
    );
    expect(rewriteLink("https://probarion.xyz")).toBe("/");
    expect(rewriteLink("https://www.probarion.xyz/docs/build/errors?x=1#NoMandate")).toBe(
      "/docs/build/errors?x=1#NoMandate",
    );
    expect(rewriteLink("https://probarion.vercel.app")).toBe("https://probarion.vercel.app");
    expect(rewriteLink("/docs/build/errors")).toBe("/docs/build/errors");
    expect(rewriteLink("#unreleased")).toBe("#unreleased");
  });

  it("holds every rendered link to the docs link rules", () => {
    const out = html(createElement(ChangelogView, { tree }));
    const links = hrefsIn(out);
    // The rendered page carries the tree's links, plus one anchor link per heading.
    expect(links.length).toBe(urlsIn(tree).length + heads.length);
    const problems = links.flatMap((url) => {
      const why = linkProblem(url, "resources/changelog");
      return why ? [`${url}: ${why}`] : [];
    });
    expect(problems).toEqual([]);
    expect(foreignGitHub(links), "a GitHub link outside github.com/probarion/").toEqual([]);
    expect(
      foreignGitHub([
        "https://github.com/probarion/probarion/blob/main/README.md",
        "https://github.com/probarion",
        "https://github.com/example/other",
        "https://www.github.com/example/other",
        "https://example.com/x",
      ]),
    ).toEqual(["https://github.com/example/other", "https://www.github.com/example/other"]);
    // Every link takes the docs link style (a heading's "#" its anchor style), and an external one
    // opens in a new tab, as on every docs page.
    for (const [a] of out.matchAll(/<a\s[^>]*>/g)) {
      expect([d.link, d.anchor], a).toContain(/\sclass="([^"]*)"/.exec(a)?.[1]);
      if (/\shref="https:/.test(a)) expect(a).toContain('target="_blank"');
    }
  });

  it("renders headings and links through the components an MDX page uses", () => {
    const one = (source: string) =>
      html(createElement(ChangelogView, { tree: parseMarkdown(source) }));
    // A site path, a fragment, a file the site serves and another site: each DocLink case.
    for (const href of [
      "/docs/build/errors",
      "#unreleased",
      "/llms.txt",
      "https://example.com/x",
    ]) {
      expect(one(`[x](${href})\n`), href).toBe(
        `<p>${html(createElement(DocLink, { href }, "x"))}</p>`,
      );
    }
    expect(one("## Unreleased\n")).toBe(
      html(createElement(H2, { id: "unreleased" }, "Unreleased")),
    );
    expect(one("## Unreleased\n\n### Added\n")).toContain(
      html(createElement(H3, { id: "unreleased-added" }, "Added")),
    );
  });

  it("puts the same sections in the twin, its site links made absolute", () => {
    const out = md("<Changelog />");
    expect(out).toContain("## Unreleased");
    expect(out).not.toMatch(/^# Changelog/m);
    expect(generatedAnchors(parseMdx("<Changelog />"))).toEqual(changelogAnchors());
    const urls = urlsIn(parseMarkdown(out));
    expect(urls.filter((u) => u.startsWith("/"))).toEqual([]);
    // Each site path the page links becomes a full URL of this site, as in every other twin.
    const sitePaths = urlsIn(tree).filter((u) => u.startsWith("/"));
    expect(urls.filter((u) => u.startsWith(`${ORIGIN}/`))).toHaveLength(sitePaths.length);
  });
});

describe("the architecture diagram", () => {
  // The layout and the box sources: docs-ref-architecture.test.ts.
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
