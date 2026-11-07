// biome-ignore-all lint/correctness/noChildrenProp: the component types need children in props

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bundledThemes } from "shiki";
import { describe, expect, it, vi } from "vitest";
import { Callout } from "@/components/docs/Callout";
import { CodeFrame } from "@/components/docs/CodeFrame";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { DOCS_COMPONENTS } from "@/components/docs/mdx";
import { CALLOUT_KINDS, isCalloutKind } from "@/lib/docs/callouts";
import { copyText } from "@/lib/docs/clipboard";
import { codeText, nodeText } from "@/lib/docs/node-text";
import { readCodeTab, writeCodeTab } from "@/lib/docs/prefs";
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
