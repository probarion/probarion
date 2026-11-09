// biome-ignore-all lint/correctness/noChildrenProp: the component types need children in props

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type FunctionComponent, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bundledThemes } from "shiki";
import { afterEach, describe, expect, it, vi } from "vitest";
import DocsLayout from "@/app/docs/layout";
import DocsNotFound from "@/app/docs/not-found";
import { Breadcrumbs } from "@/components/docs/Breadcrumbs";
import { Callout } from "@/components/docs/Callout";
import { CodeFrame } from "@/components/docs/CodeFrame";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { scrollTopFor } from "@/components/docs/CurrentInView";
import { DocsBar } from "@/components/docs/DocsBar";
import d from "@/components/docs/docs.module.css";
import { Feedback } from "@/components/docs/Feedback";
import {
  Card,
  Door,
  HUB_CLAIM,
  HubAgents,
  HubDoors,
  HubHero,
  HubSearch,
} from "@/components/docs/hub";
import { DOCS_COMPONENTS } from "@/components/docs/mdx";
import { PageHead } from "@/components/docs/PageHead";
import { Pager } from "@/components/docs/Pager";
import { PREVIEW_LEGEND, Sidebar } from "@/components/docs/Sidebar";
import { SourceBox } from "@/components/docs/SourceBox";
import { Toc } from "@/components/docs/Toc";
import { TocDrop } from "@/components/docs/TocDrop";
import { BetaStripView } from "@/components/site/BetaStrip";
import { PhoneMenu } from "@/components/site/PhoneMenu";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { HUB_AGENTS } from "@/lib/docs/agents";
import { commitFrom } from "@/lib/docs/build-info";
import { CALLOUT_KINDS, isCalloutKind } from "@/lib/docs/callouts";
import { copyText } from "@/lib/docs/clipboard";
import { anchorsOf, SHELL_IDS } from "@/lib/docs/headings";
import { editUrl, issueUrl, sourceUrl } from "@/lib/docs/links";
import { mdxToMarkdown } from "@/lib/docs/markdown";
import { docsJsonLd, docsMetadata, docsTitle } from "@/lib/docs/meta";
import { codeText, nodeText } from "@/lib/docs/node-text";
import { readCodeTab, writeCodeTab } from "@/lib/docs/prefs";
import { findPage, PAGES, visibleTabs } from "@/lib/docs/registry";
import { isTabKey, nextTab, tabFor, tabNames } from "@/lib/docs/tabs";
import { pickActive } from "@/lib/docs/toc-spy";
import { DOC_TYPE_LABELS, NETWORK_CHIPS, STATUS_LABELS } from "@/lib/docs/types";
import { HERO, OG_IMAGE } from "@/lib/site/facts";
import { WEB } from "./docs-helpers";

const html = (node: ReactNode) => renderToStaticMarkup(node as never);

describe("nodeText", () => {
  it("joins the text of a nested element tree", () => {
    const tree = createElement(
      "code",
      null,
      createElement("span", null, "pnpm "),
      createElement("span", null, ["install", "\n"]),
      42,
    );
    expect(nodeText(tree)).toBe("pnpm install\n42");
    expect(nodeText(null)).toBe("");
    expect(nodeText(false)).toBe("");
  });
});

describe("codeText", () => {
  it("is the code in a frame's pre, without the frame's label or the last newline", () => {
    // What a CodeTabs panel holds once the server has rendered its CodeFrame.
    const frame = createElement(
      "figure",
      null,
      createElement("figcaption", null, createElement("span", null, "Shell")),
      createElement("pre", null, createElement("code", null, "pnpm install\n")),
    );
    expect(codeText(frame)).toBe("pnpm install");
    expect(codeText(createElement("code", null, "ls\n"))).toBe("ls");
    expect(codeText(undefined)).toBe("");
  });
});

describe("copyText", () => {
  it("is true when the clipboard takes the text", async () => {
    const writeText = vi.fn(async () => {});
    expect(await copyText("x", { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith("x");
  });

  it("is false, and does not throw, when the clipboard is blocked or missing", async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    expect(await copyText("x", { writeText })).toBe(false);
    expect(await copyText("x", undefined)).toBe(false);
  });
});

describe("the remembered code tab", () => {
  const store = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  };

  it("reads back what was written", () => {
    const s = store();
    writeCodeTab("Shell", s);
    expect(readCodeTab(s)).toBe("Shell");
  });

  it("returns null and stays quiet when storage throws or is absent", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    } as unknown as Storage;
    expect(readCodeTab(broken)).toBeNull();
    expect(() => writeCodeTab("x", broken)).not.toThrow();
    expect(readCodeTab(null)).toBeNull();
  });
});

describe("the code tabs' logic", () => {
  it("reads the names from the labels, and refuses a wrong count or a repeated name", () => {
    expect(tabNames(" TypeScript, Shell ,", 2)).toEqual(["TypeScript", "Shell"]);
    expect(() => tabNames("A, B", 1)).toThrow(/2 labels for 1 code block/);
    expect(() => tabNames("Shell, TypeScript, Shell", 3)).toThrow(/label "Shell" is repeated/);
  });

  it("moves with the arrow keys, wrapping at both ends, and jumps with Home and End", () => {
    expect(nextTab(0, "ArrowRight", 3)).toBe(1);
    expect(nextTab(2, "ArrowRight", 3)).toBe(0);
    expect(nextTab(1, "ArrowLeft", 3)).toBe(0);
    expect(nextTab(0, "ArrowLeft", 3)).toBe(2);
    expect(nextTab(1, "Home", 3)).toBe(0);
    expect(nextTab(1, "End", 3)).toBe(2);
  });

  it("leaves the tab alone for any other key, and claims only the keys it moves with", () => {
    for (const key of ["Enter", " ", "Tab", "ArrowDown", "a"]) {
      expect(nextTab(1, key, 3), key).toBe(1);
      expect(isTabKey(key), key).toBe(false);
    }
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      expect(isTabKey(key), key).toBe(true);
    }
    expect(nextTab(0, "ArrowRight", 0)).toBe(0);
  });

  it("finds the remembered tab by its name, and nothing for a name this block lacks", () => {
    expect(tabFor(["TypeScript", "Shell"], "Shell")).toBe(1);
    expect(tabFor(["TypeScript", "Shell"], "Rust")).toBeNull();
    expect(tabFor(["TypeScript", "Shell"], null)).toBeNull();
  });
});

describe("Callout", () => {
  it("knows exactly five kinds", () => {
    expect(Object.keys(CALLOUT_KINDS)).toEqual([
      "note",
      "warning",
      "owner-signs",
      "approver-signs",
      "key",
    ]);
    expect(isCalloutKind("risk")).toBe(false);
  });

  it("marks who signs, and says that Probarion does not", () => {
    const out = html(
      createElement(Callout, { kind: "owner-signs", children: "Revoke the mandate." }),
    );
    expect(out).toContain("Owner signs");
    expect(out).toContain("Revoke the mandate.");
    expect(out).toContain("Probarion never signs it.");
    expect(html(createElement(Callout, { kind: "approver-signs", children: "x" }))).toContain(
      "Approver signs",
    );
  });

  it("uses a given title, and refuses an unknown kind", () => {
    expect(
      html(createElement(Callout, { kind: "key", title: "No payee", children: "x" })),
    ).toContain("No payee");
    expect(() => html(createElement(Callout, { kind: "risk" as never, children: "x" }))).toThrow(
      /unknown kind "risk"/,
    );
  });
});

describe("CodeFrame", () => {
  const shikiPre = (lang: string) =>
    createElement(CodeFrame, {
      className: "shiki github-dark-high-contrast",
      style: { backgroundColor: "#0a0c10" },
      tabIndex: 0,
      children: createElement(
        "code",
        { className: `language-${lang}` },
        createElement("span", { className: "line" }, "pnpm install"),
        "\n",
      ),
    });

  it("labels the language, keeps shiki's class, and drops shiki's background", () => {
    const out = html(shikiPre("bash"));
    expect(out).toContain("Shell");
    expect(out).toContain('class="shiki github-dark-high-contrast');
    expect(out).not.toContain("background-color");
    expect(out).toContain('tabindex="0"');
  });

  it("has a copy button for the code's text", () => {
    expect(html(shikiPre("ts"))).toContain(">Copy<");
  });

  it("names the figure by its language, not by the text of its button", () => {
    expect(html(shikiPre("bash"))).toMatch(/<figure [^>]*aria-label="Shell code"/);
    expect(html(shikiPre("zig"))).toMatch(/<figure [^>]*aria-label="zig code"/);
  });
});

describe("CodeTabs", () => {
  it("renders every panel visible until JavaScript runs, each with its own label", () => {
    const out = html(
      createElement(CodeTabs, {
        labels: "TypeScript, Shell",
        children: [createElement("pre", { key: 1 }, "a"), createElement("pre", { key: 2 }, "b")],
      }),
    );
    expect(out).toContain('role="tablist"');
    expect(out.match(/role="tabpanel"/g)).toHaveLength(2);
    expect(out).not.toMatch(/role="tabpanel"[^>]*hidden/);
    expect(out).toContain("TypeScript");
    expect(out).toContain("Shell");
  });

  it("keeps the tabs and one Copy button in a frame head that shows only with JavaScript", () => {
    const frame = (lang: string, code: string) =>
      createElement(CodeFrame, {
        key: lang,
        children: createElement("code", { className: `language-${lang}` }, code),
      });
    const out = html(
      createElement(CodeTabs, {
        labels: "TypeScript, Shell",
        children: [frame("ts", "const a = 1;"), frame("bash", "pnpm install")],
      }),
    );
    // The shared head is hidden in the server markup, and each panel keeps its own frame and head.
    expect(out).toMatch(/hidden=""><div role="tablist"/);
    expect(out.match(/<figcaption/g)).toHaveLength(2);
    expect(out.match(/>Copy</g)).toHaveLength(3);
  });

  it("refuses a label count that does not match the blocks", () => {
    expect(() =>
      html(createElement(CodeTabs, { labels: "A, B", children: createElement("pre", null, "a") })),
    ).toThrow(/2 labels for 1 code block/);
  });

  it("refuses a repeated label", () => {
    expect(() =>
      html(
        createElement(CodeTabs, {
          labels: "Shell, Shell",
          children: [createElement("pre", { key: 1 }, "a"), createElement("pre", { key: 2 }, "b")],
        }),
      ),
    ).toThrow(/label "Shell" is repeated/);
  });
});

describe("prose overrides", () => {
  const C = DOCS_COMPONENTS as Record<string, (p: Record<string, unknown>) => ReactNode>;

  it("give h2 and h3 a focusable anchor with an accessible name", () => {
    const out = html(
      createElement(C.h2 as never, { id: "what-a-refusal-does", children: "What a refusal does" }),
    );
    expect(out).toContain('id="what-a-refusal-does"');
    expect(out).toContain('href="#what-a-refusal-does"');
    expect(out).toContain('aria-label="Link to this section: What a refusal does"');
    expect(html(createElement(C.h3 as never, { id: "x", children: "X" }))).toContain('href="#x"');
  });

  it("put a table in a region named from its header row, which can scroll sideways", () => {
    const head = createElement(
      "thead",
      { key: "head" },
      createElement(
        "tr",
        null,
        createElement("th", null, "#"),
        createElement("th", null, createElement("code", null, "Code")),
      ),
    );
    const out = html(
      createElement(C.table as never, {
        children: [head, createElement("tbody", { key: "body" })],
      }),
    );
    expect(out).toContain('aria-label="Table: #, Code"');
    expect(out).toContain("<table");
    expect(html(createElement(C.table as never, { children: createElement("tbody") }))).toContain(
      'aria-label="Table"',
    );
  });

  it("open external links in a new tab, and keep internal links in the page", () => {
    expect(
      html(
        createElement(C.a as never, {
          href: "https://github.com/probarion/probarion",
          children: "repo",
        }),
      ),
    ).toContain('target="_blank"');
    const inner = html(
      createElement(C.a as never, { href: "/docs/build/errors#NoMandate", children: "code" }),
    );
    expect(inner).toContain('href="/docs/build/errors#NoMandate"');
    expect(inner).not.toContain("_blank");
  });

  it("keep a Markdown link's title on an external link", () => {
    const out = html(
      createElement(C.a as never, {
        href: "https://github.com/probarion/probarion",
        title: "The source on GitHub",
        children: "repo",
      }),
    );
    expect(out).toContain('title="The source on GitHub"');
    expect(out).toContain('target="_blank"');
  });

  it("link a .md twin or an llms file with a plain <a>: next/link would prefetch it", () => {
    const typeOf = (href: string) => {
      const link = C.a({ href, children: "file" });
      return isValidElement(link) ? link.type : undefined;
    };
    for (const href of [
      "/docs.md",
      "/docs/build/errors.md",
      "/docs/build/errors.md#NoMandate",
      "/llms.txt",
      "/llms-full.txt",
    ]) {
      expect(typeOf(href), href).toBe("a");
    }
    expect(typeOf("/docs/build/errors")).not.toBe("a");
  });
});

describe("the code theme", () => {
  const luminance = (hex: string) => {
    const channel = (at: number) => {
      const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  it("is the one next.config.ts names", () => {
    expect(readFileSync(join(WEB, "next.config.ts"), "utf8")).toContain(
      'theme: "github-dark-high-contrast"',
    );
  });

  it("keeps every token colour at 4.5:1 on the ink frame", async () => {
    const css = readFileSync(join(WEB, "src", "app", "globals.css"), "utf8");
    const band = /--color-band:\s*(#[0-9a-f]{6})/i.exec(css)?.[1] ?? "";
    const theme = (await bundledThemes["github-dark-high-contrast"]()).default;
    const colours = new Set<string>();
    // A rule with its own background (diff markup only) is drawn on that background, not on the frame.
    for (const rule of theme.tokenColors ?? []) {
      if (rule.settings?.foreground && !rule.settings.background) {
        colours.add(rule.settings.foreground.toLowerCase());
      }
    }
    expect(colours.size).toBeGreaterThan(5);
    for (const c of colours) {
      expect(c, "token colours are 6-digit hex").toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(c, band), c).toBeGreaterThanOrEqual(4.5);
    }
  });
});

const article = () => {
  const page = findPage("concepts/payment-checks");
  if (!page) throw new Error("starter page missing");
  return page;
};

describe("pickActive", () => {
  it("marks the last heading that has passed the offset, else the first", () => {
    const tops = [
      { id: "a", top: 300 },
      { id: "b", top: 900 },
    ];
    expect(pickActive(tops, 100)).toBe("a");
    expect(
      pickActive(
        [
          { id: "a", top: -400 },
          { id: "b", top: 60 },
          { id: "c", top: 500 },
        ],
        100,
      ),
    ).toBe("b");
    expect(pickActive([], 100)).toBeNull();
  });
});

describe("build commit and GitHub links", () => {
  it("prefers Vercel's commit, then git, else none", () => {
    expect(commitFrom({ VERCEL_GIT_COMMIT_SHA: "a".repeat(40) }, () => "b".repeat(40))).toBe(
      "a".repeat(40),
    );
    expect(commitFrom({ VERCEL_GIT_COMMIT_SHA: " " }, () => "b".repeat(40))).toBe("b".repeat(40));
    expect(commitFrom({}, () => null)).toBeNull();
  });

  it("point source at the build commit (else main), edits at dev, issues with the page", () => {
    expect(sourceUrl("contracts/vault/src/checks.rs", "abc")).toBe(
      "https://github.com/probarion/probarion/blob/abc/contracts/vault/src/checks.rs",
    );
    expect(sourceUrl("x", null)).toContain("/blob/main/x");
    expect(editUrl(article())).toBe(
      "https://github.com/probarion/probarion/edit/dev/apps/web/content/docs/concepts/payment-checks.mdx",
    );
    const issue = new URL(issueUrl(article(), "https://probarion.xyz"));
    expect(issue.pathname).toBe("/probarion/probarion/issues/new");
    expect(issue.searchParams.get("title")).toBe("Docs: How a payment is checked");
    expect(issue.searchParams.get("body")).toContain(
      "https://probarion.xyz/docs/concepts/payment-checks",
    );
  });
});

describe("docs metadata", () => {
  it("titles every page for the docs, with a canonical address and the site image", () => {
    const meta = docsMetadata(article());
    expect(meta.title).toEqual({ absolute: "How a payment is checked · Probarion Docs" });
    expect(meta.alternates?.canonical).toBe("/docs/concepts/payment-checks");
    expect(JSON.stringify(meta.openGraph)).toContain(OG_IMAGE.url);
    expect(docsTitle(PAGES[0] ?? article())).toBe("Probarion Docs");
  });

  it("sets its own Twitter card, so the root layout's title never shows on a docs page", () => {
    const page = article();
    const meta = docsMetadata(page);
    expect(meta.twitter).toMatchObject({
      card: "summary_large_image",
      title: "How a payment is checked · Probarion Docs",
      description: page.description,
    });
    expect(JSON.stringify(meta.twitter)).toContain(OG_IMAGE.url);
  });

  it("writes JSON-LD that cannot close its script tag", () => {
    const ld = docsJsonLd({ ...article(), title: "</script><b>" }, "https://probarion.xyz");
    expect(ld).not.toContain("<");
    const data = JSON.parse(ld) as { "@type": string }[];
    expect(data.map((x) => x["@type"])).toEqual(["TechArticle", "BreadcrumbList"]);
  });
});

describe("the docs shell", () => {
  it("marks the current page in the sidebar and lists only sections with pages", () => {
    const out = html(createElement(Sidebar, { current: "concepts/payment-checks", where: "side" }));
    expect(out).toContain('aria-label="Docs"');
    expect(out).toContain('id="side-concepts"');
    expect(out).toContain('aria-labelledby="side-concepts"');
    // next/link puts href after the other props, so the match takes the two in either order.
    expect(out).toMatch(
      /<a(?=[^>]*href="\/docs\/concepts\/payment-checks")(?=[^>]*aria-current="page")[^>]*>/,
    );
    expect(out).toContain("Concepts");
    expect(out).not.toContain("Operate");
  });

  it("puts a legend under the groups of both copies, and keeps the dot's screen-reader text", () => {
    expect(PREVIEW_LEGEND).toBe("Preview: built, not yet run end to end");
    for (const where of ["side", "drawer"] as const) {
      const out = html(createElement(Sidebar, { current: "concepts/payment-checks", where }));
      expect(out, where).toMatch(
        /<p class="[^"]*"><span class="[^"]*" aria-hidden="true"><\/span>Preview: built, not yet run end to end<\/p><\/nav>$/,
      );
      // CurrentInView's mark sits in the nav it works on.
      expect(out, where).toMatch(/^<nav[^>]*><span hidden=""><\/span>/);
      expect(out, where).toContain('<span class="sr-only"> (Preview)</span>');
    }
  });

  it("scrolls the current link to the middle of its box only when it is not in full view", () => {
    const box = { top: 100, bottom: 500 };
    expect(scrollTopFor(box, { top: 120, bottom: 150 }, 0)).toBeNull();
    expect(scrollTopFor(box, { top: 100, bottom: 500 }, 40)).toBeNull();
    // 400 px of room and a 30 px link: 185 px above it once it is in the middle.
    expect(scrollTopFor(box, { top: 700, bottom: 730 }, 0)).toBe(415);
    expect(scrollTopFor(box, { top: 490, bottom: 520 }, 0)).toBe(205);
    expect(scrollTopFor(box, { top: 40, bottom: 70 }, 900)).toBe(655);
    expect(scrollTopFor(box, { top: 60, bottom: 90 }, 10)).toBe(0);
  });

  it("takes the group ids' prefix from where it sits, not from its name", () => {
    const drawer = html(createElement(Sidebar, { current: null, where: "drawer", label: "Docs" }));
    expect(drawer).toContain('aria-label="Docs"');
    expect(drawer).toContain('id="drawer-concepts"');
    expect(drawer).not.toContain('id="side-');
  });

  it("gives the bar a search trigger that works without JavaScript, and a Contents drawer", () => {
    const out = html(
      createElement(DocsBar, { current: "guides", path: "concepts/payment-checks" }),
    );
    expect(out).toMatch(
      /<a[^>]*data-docs-search[^>]*href="\/docs#popular"|<a[^>]*href="\/docs#popular"[^>]*data-docs-search/,
    );
    expect(out).toContain("<summary");
    expect(out).toContain("Contents");
    expect(out).toContain('aria-label="Docs contents"');
    expect(out).toContain('id="drawer-concepts"');
    // The shortcut is announced by aria-keyshortcuts, so the visible key cap is hidden from it.
    expect(out).toMatch(/<a[^>]*aria-keyshortcuts="Control\+K Meta\+K"/);
    expect(out).toMatch(/<kbd[^>]*aria-hidden="true"[^>]*>Ctrl K<\/kbd>/);
    // No empty tabs nav: it shows once a tab's page exists.
    expect(out.includes('aria-label="Docs sections"')).toBe(visibleTabs().length > 0);
  });

  it("shows breadcrumbs, the H1, lede, chips, and the page actions", () => {
    expect(html(createElement(Breadcrumbs, { page: article() }))).toContain(
      'aria-label="Breadcrumb"',
    );
    const page = article();
    const head = html(createElement(PageHead, { page, minutes: 4, markdown: "# x" }));
    expect(head).toContain("<h1");
    // The chips come from the registry entry, so a rewrite of the entry keeps this test true.
    const chips = [
      ...(page.status ? [STATUS_LABELS[page.status]] : []),
      ...(page.network ? NETWORK_CHIPS[page.network] : []),
      DOC_TYPE_LABELS[page.type],
    ];
    for (const chip of chips) expect(head).toContain(chip);
    expect(head).toContain("4 min read");
    // The Markdown link: visible ".md", then sr-only text, no aria-label.
    const md = /<a[^>]*href="\/docs\/concepts\/payment-checks\.md"[^>]*>(.*?)<\/a>/.exec(head);
    expect(md).not.toBeNull();
    expect(md?.[0]).not.toContain("aria-label");
    expect(md?.[1]).toBe('.md<span class="sr-only"> (this page as Markdown)</span>');
    // Copy page, its status region and the .md link wrap together as one group.
    const actions = new RegExp(
      `<span class="${d.actions}"><button[^>]*>Copy page</button><span role="status"[^>]*></span>` +
        `<a [^>]*href="/docs/concepts/payment-checks\\.md"[^>]*>\\.md<span class="sr-only"> ` +
        `\\(this page as Markdown\\)</span></a></span>`,
    );
    expect(head).toMatch(actions);
  });

  it("names the build commit or a local build, and links each source", () => {
    const out = html(createElement(SourceBox, { page: article(), commit: null }));
    expect(out).toContain("a local build");
    // Every source of the registry entry, so a rewrite of the entry keeps this test true.
    const { sources } = article();
    expect(sources.length).toBeGreaterThan(0);
    for (const path of sources) expect(out).toContain(`/blob/main/${path}`);
    const built = html(
      createElement(SourceBox, { page: article(), commit: "0c7c5ba".padEnd(40, "0") }),
    );
    expect(built).toContain("<code>0c7c5ba</code>");
  });

  it("links the previous and next page", () => {
    const out = html(createElement(Pager, { prev: PAGES[0], next: undefined }));
    expect(out).toContain('rel="prev"');
    expect(out).not.toContain('rel="next"');
  });

  it("lets PhoneMenu take a label, and keeps Menu as the default", () => {
    expect(html(createElement(PhoneMenu, { label: "Contents", children: "x" }))).toContain(
      ">Contents</summary>",
    );
    expect(html(createElement(PhoneMenu, { children: "x" }))).toContain(">Menu</summary>");
  });
});

describe("the docs bar's tabs, once a tab's page exists", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/docs/pages/start");
    vi.doUnmock("@/lib/docs/pages/build");
    vi.doUnmock("@/lib/docs/pages/trust");
    vi.resetModules();
  });

  it("shows only the tabs whose page exists, and marks the current one", async () => {
    vi.resetModules();
    const base = article();
    // The double replaces every section that holds a tab's page, so later pages cannot change it.
    vi.doMock("@/lib/docs/pages/start", () => ({ START: [] }));
    vi.doMock("@/lib/docs/pages/build", () => ({
      BUILD: [{ ...base, path: "build/install", title: "Install" }],
    }));
    vi.doMock("@/lib/docs/pages/trust", () => ({ TRUST: [] }));
    const fresh = await import("@/components/docs/DocsBar");
    const out = html(createElement(fresh.DocsBar, { current: "build", path: "build/install" }));
    const tabs = /<nav aria-label="Docs sections"[^>]*>(.*?)<\/nav>/.exec(out)?.[1] ?? "";
    expect(tabs).toMatch(
      /<a(?=[^>]*href="\/docs\/build\/install")(?=[^>]*aria-current="true")[^>]*>Build<\/a>/,
    );
    // The other tabs' pages do not exist in this registry.
    expect(tabs.match(/<a /g)).toHaveLength(1);
  });
});

describe("the ids the shell puts on a docs page", () => {
  it("are all reserved in SHELL_IDS, so a heading that takes one fails the duplicate-id check", () => {
    const page = article();
    const toc = [{ id: "the-14-checks-in-order", text: "The 14 checks, in order", depth: 2 }];
    // The docs layout wraps every docs page, so whatever it mounts (the search dialog) counts too.
    const out = html(
      createElement(
        "div",
        null,
        createElement(BetaStripView, { network: "testnet" }),
        createElement(BetaStripView, { network: "mainnet" }),
        createElement(SiteHeader),
        createElement(DocsLayout, {
          children: createElement(
            "div",
            null,
            createElement(DocsBar, { current: null, path: page.path }),
            createElement(Sidebar, { current: page.path, where: "side" }),
            createElement(Breadcrumbs, { page }),
            createElement(TocDrop, { items: toc }),
            createElement(PageHead, { page, minutes: 4, markdown: "# x" }),
            createElement(SourceBox, { page, commit: null }),
            createElement(Feedback, { page, origin: "https://probarion.xyz" }),
            createElement(Pager, { prev: PAGES[0], next: page }),
            createElement(Toc, { items: toc }),
            createElement(DocsNotFound),
          ),
        }),
        createElement(SiteFooter),
      ),
    );
    const layouts = [
      readFileSync(join(WEB, "src", "app", "layout.tsx"), "utf8"),
      readFileSync(join(WEB, "src", "app", "docs", "layout.tsx"), "utf8"),
    ].join("\n");
    const ids = [...`${out}\n${layouts}`.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
    // The layout's main, the logo's gradient and both copies of the contents.
    expect(ids).toEqual(
      expect.arrayContaining(["main", "probarion-coin", "side-concepts", "drawer-concepts"]),
    );
    for (const id of new Set(ids)) expect(SHELL_IDS, id).toContain(id);
  });
});

describe("docs.module.css", () => {
  const css = readFileSync(join(WEB, "src", "components", "docs", "docs.module.css"), "utf8");
  // A comment may name what no rule does, so the rule checks read the file without comments.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("sizes every flexible grid track with minmax(0, ...)", () => {
    for (const m of css.matchAll(/grid-(?:template|auto)-columns:\s*([^;]+);/g)) {
      const tracks = (m[1] ?? "").replace(/minmax\(0,\s*[\d.]+fr\)/g, "");
      expect(tracks, m[0]).not.toMatch(/fr\b/);
    }
  });

  it("wraps long words in prose and scrolls code and tables inside their own box", () => {
    expect(css).toMatch(/\.prose\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.pre\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.tableWrap\s*\{[^}]*overflow-x:\s*auto/);
  });

  it("keeps the page actions together at the end of the meta row", () => {
    const actions = /\.actions\s*\{([^}]*)\}/.exec(rules)?.[1] ?? "";
    expect(actions).toMatch(/display:\s*inline-flex/);
    expect(actions).toMatch(/margin-left:\s*auto/);
    expect(actions).toMatch(/flex-wrap:\s*nowrap/);
    expect(rules).not.toMatch(/\.spacer\b/);
  });

  it("marks the current tab, link and heading, and shows the Preview dot, in forced colours", () => {
    const forced = /@media \(forced-colors: active\) \{([\s\S]*?)\n\}/.exec(rules)?.[1] ?? "";
    const rule = (selector: string) =>
      new RegExp(
        `(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`,
      ).exec(forced)?.[1] ?? "";
    expect(rule(".tabLink")).toMatch(/border-bottom-color: Canvas;/);
    expect(rule(".tabLink[aria-current]")).toMatch(/border-bottom-color: Highlight;/);
    expect(rule(".tocLink[aria-current]")).toMatch(/border-left: 3px solid Highlight;/);
    // A focused one keeps its own ring.
    for (const selector of [
      '.tab[aria-selected="true"]:not(:focus-visible)',
      '.sideLink[aria-current="page"]:not(:focus-visible)',
    ]) {
      expect(rule(selector), selector).toMatch(
        /outline: 2px solid Highlight;\s*outline-offset: -2px;/,
      );
    }
    expect(rule(".dotPreview")).toMatch(/forced-color-adjust: none;/);
    expect(rule(".dotPreview")).toMatch(/background: CanvasText;/);
  });

  it("hides the docs home's key cap on a phone, as the bar's", () => {
    const phone = [...rules.matchAll(/@media \(max-width: 767px\) \{([\s\S]*?)\n\}/g)]
      .map((m) => m[1] ?? "")
      .join("\n");
    expect(phone).toMatch(/\.searchTrigger \.kbd,\s*\.bigSearch \.kbd \{\s*display: none;/);
  });

  it("never removes the focus ring or reaches outside the module", () => {
    expect(rules).not.toMatch(/all:\s*unset/);
    expect(rules).not.toContain(":global(");
  });

  it("gives each shell control its own gold ring, inside the box where it would be clipped", () => {
    const ring = (control: string) =>
      new RegExp(`\\.${control}:focus-visible[^{]*\\{([^}]*)\\}`).exec(rules)?.[1] ?? "";
    const controls = [
      "tag",
      "tabLink",
      "searchTrigger",
      "drawerButton",
      "tocDropButton",
      "sideLink",
      "metaButton",
      "tocLink",
      "pagerLink",
      "bigSearch",
    ];
    for (const control of controls) {
      expect(ring(control), control).toMatch(/outline:\s*2px solid var\(--color-gold-small\)/);
    }
    for (const control of ["sideLink", "tocLink", "tabLink"]) {
      expect(ring(control), control).toMatch(/outline-offset:\s*-2px/);
    }
  });

  /** The declarations of every rule, nested ones too, whose selector list names `selector`. */
  const declarationsOf = (selector: string) =>
    [...rules.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter((m) => (m[1] ?? "").split(",").some((s) => s.trim() === selector))
      .map((m) => m[2] ?? "")
      .join("\n");

  it("moves a door's or a card's ring to the whole card only where :has() works", () => {
    const supports = /@supports selector\(:has\(\*\)\)\s*\{([\s\S]*?)\n\}/.exec(rules)?.[1] ?? "";
    expect(supports).toMatch(/\.cover:focus-visible\s*\{\s*outline:\s*none;?\s*\}/);
    for (const card of ["door", "card"]) {
      const ring = new RegExp(`\\.${card}:has\\(\\.cover:focus-visible\\)[^{]*\\{([^}]*)\\}`);
      expect(ring.exec(supports)?.[1], card).toMatch(
        /outline:\s*2px solid var\(--color-gold-small\)/,
      );
    }
    // Outside that block nothing takes the cover link's own ring away.
    expect(rules.replace(supports, "")).not.toMatch(/\.cover:focus-visible/);
  });

  it("lifts every other link in a door or a card above the title's cover", () => {
    for (const link of [".also", ".hub .doorText a", ".hub .cardText a"]) {
      expect(declarationsOf(link), link).toMatch(/position:\s*relative/);
      expect(declarationsOf(link), link).toMatch(/z-index:\s*1\b/);
    }
  });

  it("gives inline code and links on the home's ink surfaces the key callout's colours", () => {
    const surfaces: [string, string][] = [
      [".key", ":not(pre) > code"],
      [".hub .doorInk", ":not(pre) > code"],
      // A tight list item holds its text itself: `li :not(pre) > code` would miss its code.
      [".hub .flow ol > li:last-child", "code:not(pre code)"],
    ];
    for (const [ink, inlineCode] of surfaces) {
      const code = declarationsOf(`${ink} ${inlineCode}`);
      expect(code, ink).toMatch(/border-color:\s*var\(--color-band-line\)/);
      expect(code, ink).toMatch(/background:\s*var\(--color-code-active\)/);
      expect(code, ink).toMatch(/color:\s*var\(--color-band-fg\)/);
      expect(declarationsOf(`${ink} .link`), ink).toMatch(/color:\s*var\(--color-gold-bright\)/);
      expect(declarationsOf(`${ink} .link:focus-visible`), ink).toMatch(
        /outline-color:\s*var\(--color-gold-bright\)/,
      );
    }
  });
});

describe("the docs home blocks", () => {
  const home = () => {
    const page = findPage("");
    if (!page) throw new Error("home missing");
    return page;
  };

  it("lead with the eyebrow, the claim as the H1, and the lede", () => {
    const out = html(createElement(HubHero, { page: home() }));
    expect(out).toContain(`>${home().title}</p>`);
    expect(out).toMatch(/<h1[^>]*>Give your AI agent a budget, <span/);
    expect(out).toContain(HUB_CLAIM.gold);
  });

  it("make the claim the landing's own first words", () => {
    expect(HUB_CLAIM).toEqual({ plain: "Give your AI agent a budget,", gold: "not your wallet." });
    expect(HERO.lede.startsWith(`${HUB_CLAIM.plain} ${HUB_CLAIM.gold}`)).toBe(true);
  });

  it("make the search box a link to the popular list, so it works without JavaScript", () => {
    const out = html(createElement(HubSearch, { children: "list" }));
    expect(out).toMatch(/<a[^>]*href="#popular"/);
    expect(out).toContain("data-docs-search");
    expect(out).toMatch(/id="popular"[^>]*data-docs-popular|data-docs-popular[^>]*id="popular"/);
  });

  const links = (out: string) => out.match(/<a /g)?.length ?? 0;

  it("make each door one link, with an optional second link and an ink variant", () => {
    const props = {
      who: "Evaluator",
      title: "Check it",
      href: "/docs/concepts/payment-checks",
      go: "Verify it",
      also: "Verify a vault",
      alsoHref: "/docs/concepts/payment-checks",
      ink: true,
      children: "Text",
    };
    const out = html(createElement(Door, props));
    expect(out).toContain("data-door");
    expect(out).toContain(`class="${d.door} ${d.doorInk}"`);
    expect(out).toMatch(
      /<h3[^>]*><a[^>]*href="\/docs\/concepts\/payment-checks"[^>]*>Check it<\/a>/,
    );
    expect(out).toContain(">Verify a vault</a>");
    expect(out).toMatch(/aria-hidden="true">Verify it/);
    // The title and the second link: "go" is a label, never a third link.
    expect(links(out)).toBe(2);
    expect(() => html(createElement(Door, { ...props, alsoHref: undefined }))).toThrow(
      /also and alsoHref go together/,
    );
    expect(() => html(createElement(Door, { ...props, also: undefined }))).toThrow(
      /also and alsoHref go together/,
    );
    expect(() => html(createElement(Door, { ...props, go: "" }))).toThrow(/needs go/);
  });

  it("make a door without also exactly one link, with no trailing class", () => {
    const out = html(
      createElement(Door, {
        who: "Owner",
        title: "Set up a vault",
        href: "/docs",
        go: "Read it",
        children: "Text",
      }),
    );
    expect(links(out)).toBe(1);
    expect(out).toContain(`class="${d.door}"`);
    expect(out).not.toContain(d.also);
  });

  it("show a card's tag as code, and no code line without one", () => {
    const card = (tag?: string) =>
      html(createElement(Card, { title: "Errors", href: "/docs", tag, children: "x" }));
    expect(card("PROBARION:NoMandate")).toContain("<code>PROBARION:NoMandate</code>");
    expect(card()).not.toContain("<code>");
    expect(card()).not.toContain(d.cardTag);
    expect(links(card())).toBe(1);
    expect(() => card("")).toThrow(/<Card> needs tag/);
  });

  it("refuse an empty also or alsoHref, as a missing prop is refused", () => {
    const door = (also: string, alsoHref: string) =>
      html(
        createElement(Door, {
          who: "Owner",
          title: "Set up a vault",
          href: "/docs",
          go: "Read it",
          also,
          alsoHref,
          children: "Text",
        }),
      );
    expect(() => door("", "/docs")).toThrow(/<Door> needs also/);
    expect(() => door("More", " ")).toThrow(/<Door> needs alsoHref/);
  });

  it("fail a broken door or card with the twin's message, field by field in the same order", () => {
    const door = { who: "Owner", title: "Start", href: "/docs", go: "Read it" };
    const card = { title: "Errors", href: "/docs" };
    const cases: ["Door" | "Card", Record<string, string>][] = [
      ["Door", { ...door, title: "", go: "" }],
      ["Door", { ...door, also: "More", go: "" }],
      ["Door", { ...door, also: "", alsoHref: "/docs", go: "" }],
      ["Door", { ...door, also: "More", alsoHref: "", go: "" }],
      ["Door", { ...door, go: "", href: "", who: "" }],
      ["Door", { ...door, href: "", who: "" }],
      ["Door", { ...door, who: "" }],
      ["Card", { ...card, title: "", href: "" }],
      ["Card", { ...card, href: "", tag: "" }],
      ["Card", { ...card, tag: "" }],
    ];
    const failure = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "no error";
    };
    for (const [name, props] of cases) {
      const component = { Door, Card }[name] as unknown as FunctionComponent<typeof props>;
      const attrs = Object.entries(props).map(([k, v]) => `${k}="${v}"`);
      const source = `<${name} ${attrs.join(" ")}>\nText\n</${name}>`;
      const react = failure(() => html(createElement(component, props, "Text")));
      const twin = failure(() => mdxToMarkdown(source, { file: "t.mdx", origin: "https://x" }));
      expect(react, source).toMatch(/^<(Door|Card)> /);
      expect(twin, source).toBe(`${react} in t.mdx`);
    }
  });

  it("put on the page exactly the ids anchors.ts lists for them", () => {
    const out = html(
      createElement(
        "div",
        null,
        createElement(HubSearch, { children: "list" }),
        createElement(HubDoors, { children: "doors" }),
      ),
    );
    const ids = [...out.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
    const source = "<HubSearch>\n\n- x\n\n</HubSearch>\n\n<HubDoors>\n\n</HubDoors>";
    expect(ids.sort()).toEqual([...anchorsOf(source)].sort());
  });

  it("point agents at the two llms files and one page's twin, and refuse an unknown page", () => {
    const out = html(createElement(HubAgents, { example: "concepts/payment-checks" }));
    for (const href of ["/llms.txt", "/llms-full.txt", "/docs/concepts/payment-checks.md"]) {
      expect(out).toContain(`href="${href}"`);
    }
    expect(out).toContain(`>${HUB_AGENTS.eyebrow}</p>`);
    expect(out).toContain(`<p>${HUB_AGENTS.lede}</p>`);
    // The For AI agents link, with and without its page: docs-twins.test.ts (a registry double).
    expect(() => html(createElement(HubAgents, { example: "no/such" }))).toThrow(/no docs page/);
  });
});
