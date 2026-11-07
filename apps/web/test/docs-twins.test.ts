import { CHECK_NAMES, VAULT_ERROR_CODES } from "@probarion/core";
import type { Root, RootContent, Table } from "mdast";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCS_COMPONENTS } from "@/components/docs/mdx";
import { AGENT_RULES, AGENT_RULES_TITLE } from "@/lib/docs/agents";
import { HTTP_ERRORS, httpAnchor, SDK_ERRORS, VAULT_ERRORS } from "@/lib/docs/errors";
import { anchorsOf, duplicateAnchors, headingsOf, SHELL_IDS, tocOf } from "@/lib/docs/headings";
import { llmsFull, llmsIndex } from "@/lib/docs/llms";
import { MDX_COMPONENT_NAMES, mdxToMarkdown, twinUrl } from "@/lib/docs/markdown";
import { parseMarkdown } from "@/lib/docs/mdast";
import { findPage, mdHref, PAGES, pageFile } from "@/lib/docs/registry";
import { readSource } from "@/lib/docs/source";
import { SPEND_CHECKS } from "@/lib/docs/spend-checks";
import { docsStatusRows } from "@/lib/docs/status";
import { pageMarkdown, readingMinutes } from "@/lib/docs/twins";
import { STATUS_LABELS } from "@/lib/docs/types";
import { VERIFIER_DOCS } from "@/lib/docs/verifier";
import { CHECK_LABELS } from "@/lib/site/facts";
import { richParts } from "@/lib/site/rich";

const ORIGIN = "https://probarion.xyz";
const md = (source: string) => mdxToMarkdown(source, { file: "test.mdx", origin: ORIGIN });

/**
 * What a Markdown reader sees of a tree: the text and code values in order. An HTML node shows as
 * `[html:...]`, since a renderer would hide it.
 */
function seen(node: Root | RootContent): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "html") return `[html:${node.value}]`;
  return "children" in node ? (node.children as RootContent[]).map(seen).join("") : "";
}

/** The cells of a twin's first table, as a Markdown reader sees them, header row included. */
function cellsOf(markdown: string): string[][] {
  const table = parseMarkdown(markdown).children.find((n): n is Table => n.type === "table");
  return (table?.children ?? []).map((row) => row.children.map(seen));
}

/**
 * How many `<` a Markdown stringifier must escape in this copy: the ones before a letter, `!`, `/`
 * or `?`, outside code.
 */
function ltToEscape(copy: readonly string[]): number {
  const prose = copy.map((s) => s.replace(/`[^`]+`/g, "")).join("\n");
  return prose.match(/<[!/?A-Za-z]/g)?.length ?? 0;
}

/** Every generated component, with the copy its twin is made from. */
const GENERATED: Readonly<Record<string, readonly string[]>> = {
  '<ErrorCatalog kind="vault" />': VAULT_ERROR_CODES.flatMap((c) => [
    VAULT_ERRORS[c].meaning,
    VAULT_ERRORS[c].raisedBy,
    VAULT_ERRORS[c].next,
  ]),
  '<ErrorCatalog kind="sdk" />': SDK_ERRORS.flatMap((e) => [e.name, e.parent, e.when, e.fields]),
  '<ErrorCatalog kind="http" />': HTTP_ERRORS.flatMap((e) => [e.where, e.meaning, e.next]),
  "<SpendChecks />": SPEND_CHECKS.map((c) => c.question),
  "<VerifierChecks />": Object.entries(VERIFIER_DOCS).flatMap(([id, v]) => [
    CHECK_LABELS[id as keyof typeof CHECK_LABELS],
    v.proves,
    v.limits,
  ]),
  "<StatusTable />": docsStatusRows().flatMap((r) => [r.feature, r.detail]),
  "<AgentRules />": AGENT_RULES,
};

describe("mdxToMarkdown", () => {
  it("turns a callout into a labelled quote, in either layout", () => {
    const block = md('<Callout kind="owner-signs">\nRevoke it.\n</Callout>');
    expect(block).toContain("> **Owner signs**");
    expect(block).toContain("> Revoke it.");
    expect(block).toContain("Probarion never signs it.");
    expect(md('<Callout kind="note">One line.</Callout>')).toContain("> **Note**");
  });

  it("keeps steps and flows as ordered lists, and labels each code tab", () => {
    expect(md("<Steps>\n1. One\n2. Two\n</Steps>")).toMatch(/1\. One\n2\. Two/);
    const tabs = md(
      '<CodeTabs labels="Shell, Text">\n\n```bash\nls\n```\n\n```text\nok\n```\n\n</CodeTabs>',
    );
    expect(tabs).toMatch(/\*\*Shell\*\*\n\n```bash\nls\n```/);
    expect(tabs).toMatch(/\*\*Text\*\*\n\n```text\nok\n```/);
    expect(md('<CodeBlock title="a.ts">\n\n```ts\nx\n```\n\n</CodeBlock>')).toContain("`a.ts`");
  });

  it("writes generated components as Markdown tables and lists", () => {
    const errors = md('<ErrorCatalog kind="vault" />');
    for (const code of VAULT_ERROR_CODES) expect(errors).toContain(`\`${code}\``);
    expect(md("<SpendChecks />")).toContain("| 14 |");
    expect(md('<VerifierChecks only="a" />')).toContain("### a. ");
    expect(md("<StatusTable />")).toContain("| Feature | Status | Detail |");
    expect(md("<AgentRules />")).toContain(`9. ${AGENT_RULES[8]}`);
  });

  it("writes each generated table's rows as the page has them", () => {
    const sdk = md('<ErrorCatalog kind="sdk" />');
    expect(sdk).toMatch(
      /^\| `RpcMalformedError` \(extends RpcError\) \| `RpcError` \| A node .+ \| None \|$/m,
    );
    const http = md('<ErrorCatalog kind="http" />');
    const anchors = anchorsOf('<ErrorCatalog kind="http" />');
    for (const e of HTTP_ERRORS) {
      expect(http).toMatch(new RegExp(`^\\| ${e.status} \\| \`${e.code}\` \\| `, "m"));
      expect(anchors.has(httpAnchor(e.status, e.code)), `${e.status} ${e.code}`).toBe(true);
    }
    // key_unavailable comes back with two statuses: two rows, two anchors.
    expect(anchors.has("http-409-key_unavailable")).toBe(true);
    expect(anchors.has("http-503-key_unavailable")).toBe(true);
    expect(md("<StatusTable />")).toContain("| Vault contract | Live | On testnet |");
    expect(cellsOf(md("<StatusTable />")).slice(1)).toEqual(
      docsStatusRows().map((r) => [r.feature, STATUS_LABELS[r.status], r.detail]),
    );
    expect(md('<VerifierChecks only="a" />')).toContain(
      `### a. ${CHECK_LABELS.a} (\`${CHECK_NAMES.a}\`)`,
    );
  });

  it("keeps generated copy literal, as the page shows it", () => {
    const rules = md("<AgentRules />");
    // Rule 7 has <Code> outside backticks: escaped, so a Markdown reader still sees it.
    expect(rules).toContain(String.raw`explained at /docs/build/errors#\<Code>.`);
    const list = parseMarkdown(rules).children[0];
    expect(list?.type).toBe("list");
    const items = list && "children" in list ? (list.children as RootContent[]) : [];
    // What the page shows (components/site/Rich.tsx): the copy, its backticks turned into code.
    expect(items.map(seen)).toEqual(AGENT_RULES.map((r) => r.replace(/`/g, "")));
    expect(items.map(seen).join("")).not.toContain("[html:");
  });

  it("splits copy the way the page does: a backtick pair is code, a lone backtick is text", () => {
    expect(richParts("Call `spend` once")).toEqual([
      { code: false, text: "Call " },
      { code: true, text: "spend" },
      { code: false, text: " once" },
    ]);
    expect(richParts("`a` and `")).toEqual([
      { code: true, text: "a" },
      { code: false, text: " and `" },
    ]);
    expect(richParts("`x")).toEqual([{ code: false, text: "`x" }]);
  });

  it("links each spend check's code to build/errors exactly when that page exists", () => {
    const out = md("<SpendChecks />");
    const linked = findPage("build/errors") !== undefined;
    for (const c of SPEND_CHECKS) {
      expect(out.includes(`[\`${c.code}\`](${ORIGIN}/docs/build/errors.md#${c.code})`)).toBe(
        linked,
      );
      expect(out).toContain(`\`${c.code}\``);
    }
  });

  it("escapes only what plain Markdown needs: never {, and < only before a letter", () => {
    // remark-mdx in the stringifier would write \{a} and 1 \< 2 here.
    const out = md(String.raw`Sets \{a\}, 1 \< 2 and a \<Code\> tag.`);
    expect(out).toContain("Sets {a}, 1 < 2 and a \\<Code> tag.");
    expect(out).not.toContain("\\{");
    for (const [source, copy] of Object.entries(GENERATED)) {
      const twin = md(source);
      expect(twin, source).not.toContain("\\{");
      expect(twin.match(/\\</g)?.length ?? 0, source).toBe(ltToEscape(copy));
    }
  });

  it("makes image addresses absolute, never pointing them at a twin", () => {
    const out = md("![Flow](/img/flow.png) ![Map](/docs/map.png) ![Logo](https://x.example/l.png)");
    expect(out).toContain(`![Flow](${ORIGIN}/img/flow.png)`);
    expect(out).toContain(`![Map](${ORIGIN}/docs/map.png)`);
    expect(out).toContain("![Logo](https://x.example/l.png)");
    expect(twinUrl("//x.example/a", ORIGIN)).toBe("//x.example/a");
  });

  it("makes internal links absolute and points docs links at their twins", () => {
    const out = md(
      "[code](/docs/build/errors#NoMandate) [home](/docs) [proof](/proof) [gh](https://github.com/probarion/probarion)",
    );
    expect(out).toContain(`(${ORIGIN}/docs/build/errors.md#NoMandate)`);
    expect(out).toContain(`(${ORIGIN}/docs.md)`);
    expect(out).toContain(`(${ORIGIN}/proof)`);
    expect(out).toContain("(https://github.com/probarion/probarion)");
    expect(twinUrl("#local", ORIGIN)).toBe("#local");
  });

  it("keeps a link that already points at a twin, with no second .md", () => {
    const out = md(
      "[twin](/docs/concepts/payment-checks.md) [code](/docs/build/errors.md#NoMandate)",
    );
    expect(out).toContain(`(${ORIGIN}/docs/concepts/payment-checks.md)`);
    expect(out).toContain(`(${ORIGIN}/docs/build/errors.md#NoMandate)`);
    expect(out).not.toContain(".md.md");
    expect(twinUrl("/docs.md", ORIGIN)).toBe(`${ORIGIN}/docs.md`);
  });

  it("refuses what a twin cannot show, naming the file", () => {
    expect(() => md("<Foo />")).toThrow(/no handler for <Foo> in test\.mdx/);
    expect(() => md("Two is {1 + 1}.")).toThrow(/mdxTextExpression is not allowed in test\.mdx/);
    expect(() => md("{1 + 1}")).toThrow(/mdxFlowExpression is not allowed/);
    expect(() => md('import x from "y"\n\nText')).toThrow(/mdxjsEsm is not allowed/);
    expect(() => md("export const a = 1\n\nText")).toThrow(/mdxjsEsm is not allowed/);
    expect(() => md('<Callout kind={"note"}>x</Callout>')).toThrow(/must be a plain string/);
    expect(() => md('<Callout kind="risk">\nx\n</Callout>')).toThrow(/unknown kind "risk"/);
    expect(() => md('<CodeTabs labels="A, B">\n\n```bash\nx\n```\n\n</CodeTabs>')).toThrow(
      /2 labels for 1 code block/,
    );
  });

  it("refuses a repeated code tab label, as the component does", () => {
    expect(() =>
      md('<CodeTabs labels="A, A">\n\n```bash\nx\n```\n\n```bash\ny\n```\n\n</CodeTabs>'),
    ).toThrow(/the label "A" is repeated in test\.mdx/);
  });

  it("refuses a code tab that is not code, and a code block with no title", () => {
    expect(() =>
      md('<CodeTabs labels="A, B">\n\nSome prose.\n\n```bash\nx\n```\n\n</CodeTabs>'),
    ).toThrow(/CodeTabs: holds only code blocks, not a paragraph, in test\.mdx/);
    expect(() => md("<CodeBlock>\n\n```ts\nx\n```\n\n</CodeBlock>")).toThrow(
      /CodeBlock: a title is required in test\.mdx/,
    );
  });

  it("names the page when a verifier check letter is wrong", () => {
    expect(() => md('<VerifierChecks only="z" />')).toThrow(/unknown check "z" in test\.mdx/);
    expect(() => anchorsOf('<VerifierChecks only="a, a" />', "x.mdx")).toThrow(
      /repeated check "a" in x\.mdx/,
    );
  });

  it("has a handler for every component the pages can use, and no other", () => {
    const components = Object.keys(DOCS_COMPONENTS).filter((k) => /^[A-Z]/.test(k));
    expect([...MDX_COMPONENT_NAMES].sort()).toEqual(components.sort());
  });

  it("writes the hub blocks as links a reader can follow", () => {
    const door = md(
      '<Door who="New here" title="Start" href="/docs/concepts/payment-checks" go="Go" also="More" alsoHref="/docs">\nOne payment.\n</Door>',
    );
    expect(door).toContain(`**[Start](${ORIGIN}/docs/concepts/payment-checks.md)** (New here)`);
    expect(door).toContain("One payment.");
    expect(door).toContain(`[More](${ORIGIN}/docs.md)`);
    const card = md(
      '<Card title="Errors" href="/docs" tag="PROBARION:NoMandate">\nCodes.\n</Card>',
    );
    expect(card).toContain("`PROBARION:NoMandate`");
    expect(md('<HubAgents example="concepts/payment-checks" />')).toContain(`(${ORIGIN}/llms.txt)`);
    expect(md("<HubSearch>\n\n- [x](/docs)\n\n</HubSearch>")).toContain("**Popular searches**");
    expect(() => md('<Card title="x">\ny\n</Card>')).toThrow(/<Card> needs href in test\.mdx/);
  });

  it("refuses a door the React Door refuses: no go, or only one of also and alsoHref", () => {
    const doorWith = (attrs: string) =>
      md(`<Door who="New here" title="Start" href="/docs"${attrs}>\nOne payment.\n</Door>`);
    expect(() => doorWith("")).toThrow(/<Door> needs go in test\.mdx/);
    expect(() => doorWith(' go="Go" also="More"')).toThrow(
      /<Door> "Start": also and alsoHref go together in test\.mdx/,
    );
    expect(() => doorWith(' go="Go" alsoHref="/docs"')).toThrow(
      /<Door> "Start": also and alsoHref go together in test\.mdx/,
    );
  });
});

describe("headings", () => {
  const source = [
    "## The 14 checks, in order",
    "## What a refusal does",
    "### `check_spend`",
    "## What a refusal does",
    '<Callout kind="note">',
    "## Inside a callout",
    "</Callout>",
  ].join("\n\n");

  it("get the ids rehype-slug gives them, in document order", () => {
    expect(headingsOf(source).map((h) => h.id)).toEqual([
      "the-14-checks-in-order",
      "what-a-refusal-does",
      "check_spend",
      "what-a-refusal-does-1",
      "inside-a-callout",
    ]);
    expect(tocOf(source).every((h) => h.depth === 2 || h.depth === 3)).toBe(true);
  });

  it("include the anchors generated components add", () => {
    const anchors = anchorsOf(
      '## Codes\n\n<ErrorCatalog kind="vault" />\n\n<VerifierChecks only="b" />',
    );
    expect(anchors.has("codes")).toBe(true);
    expect(anchors.has("NoMandate")).toBe(true);
    expect(anchors.has("check-b")).toBe(true);
    expect(anchors.has("check-a")).toBe(false);
  });

  it("name the page when a generated component's prop is not a plain string", () => {
    expect(() => anchorsOf('<VerifierChecks only={"a"} />', "x.mdx")).toThrow(
      /must be a plain string in x\.mdx/,
    );
  });

  it("catch a heading whose id a generated component also puts on the page", () => {
    expect(duplicateAnchors("## Canary\n\n<StatusTable />")).toEqual(["canary"]);
    expect(duplicateAnchors("## Check a\n\n<VerifierChecks />")).toEqual(["check-a"]);
    expect(duplicateAnchors('## Check a\n\n<VerifierChecks only="b" />')).toEqual([]);
    expect(
      duplicateAnchors('<ErrorCatalog kind="vault" />\n\n<ErrorCatalog kind="vault" />'),
    ).toEqual([...VAULT_ERROR_CODES]);
    // Heading ids never clash among themselves: the slugger numbers a repeat.
    expect(duplicateAnchors(source)).toEqual([]);
  });

  it("give every generated component ids no other generated component uses", () => {
    const all = [
      '<ErrorCatalog kind="vault" />',
      '<ErrorCatalog kind="sdk" />',
      '<ErrorCatalog kind="http" />',
      "<VerifierChecks />",
      "<StatusTable />",
    ].join("\n\n");
    expect(duplicateAnchors(all)).toEqual([]);
  });

  it("catch a heading whose id the shell around the page already uses", () => {
    expect(duplicateAnchors("## Main")).toEqual(["main"]);
    expect(duplicateAnchors("## Side concepts\n\n## Drawer start")).toEqual([
      "side-concepts",
      "drawer-start",
    ]);
    for (const id of SHELL_IDS) expect(duplicateAnchors(`## ${id}`), id).toEqual([id]);
    // The anchors a link may target stay the page's own.
    expect(anchorsOf("## Codes").has("main")).toBe(false);
  });

  it("leave no page with two elements of the same id", async () => {
    for (const page of PAGES) {
      const file = `content/docs/${pageFile(page.path)}.mdx`;
      expect(duplicateAnchors(await readSource(page.path), file), file).toEqual([]);
    }
  });
});

describe("page twins and llms files", () => {
  it("convert every page, under its title, with its description and status line", async () => {
    for (const page of PAGES) {
      const out = await pageMarkdown(page, ORIGIN);
      expect(out.startsWith(`# ${page.title}\n\n> ${page.description}\n`), page.path).toBe(true);
      expect(out, page.path).toContain(`Reviewed: ${page.reviewed}`);
      // No MDX escapes: { is never escaped, and < only where Markdown would read a tag.
      expect(out, page.path).not.toContain("\\{");
      expect(out, page.path).not.toMatch(/\\<(?![!/?A-Za-z])/);
    }
  });

  it("estimate reading time at 220 words a minute, at least 1", () => {
    expect(readingMinutes("word ".repeat(10))).toBe(1);
    expect(readingMinutes("word ".repeat(1100))).toBe(5);
  });

  it("llms.txt has the llmstxt.org shape and lists every page's twin", () => {
    const out = llmsIndex(ORIGIN);
    const lines = out.split("\n");
    expect(lines[0]).toBe("# Probarion docs");
    expect(lines[2]?.startsWith("> ")).toBe(true);
    // The rules are details: a line and a numbered list between the summary and the first H2.
    const firstH2 = lines.findIndex((l) => l.startsWith("## "));
    const intro = lines.indexOf(`${AGENT_RULES_TITLE}:`);
    expect(intro).toBeGreaterThan(2);
    expect(intro).toBeLessThan(firstH2);
    const rules = lines.slice(intro + 1, firstH2).filter((l) => l !== "");
    expect(rules.map((l) => l.match(/^(\d+)\. /)?.[1])).toEqual(
      AGENT_RULES.map((_, at) => String(at + 1)),
    );
    expect(out).toContain(String.raw`explained at /docs/build/errors#\<Code>.`);
    // Every H2 section is a list of links.
    for (const line of lines.slice(firstH2).filter((l) => l !== "" && !l.startsWith("## "))) {
      expect(line).toMatch(/^- \[[^\]]+\]\(https?:\/\/[^)]+\)/);
    }
    for (const page of PAGES) expect(out, page.path).toContain(`(${ORIGIN}${mdHref(page.path)})`);
    expect(out).toContain(`(${ORIGIN}/llms-full.txt)`);
  });

  it("llms-full.txt holds the rules and every page", async () => {
    const out = await llmsFull(ORIGIN);
    const lines = out.split("\n");
    expect(lines[0]).toBe("# Probarion docs, full text");
    const intro = lines.indexOf(`${AGENT_RULES_TITLE}:`);
    expect(intro).toBeGreaterThan(2);
    expect(intro).toBeLessThan(lines.indexOf(`# ${PAGES[0]?.title}`));
    expect(out).not.toContain(`## ${AGENT_RULES_TITLE}`);
    for (const page of PAGES) expect(out, page.path).toContain(`\n# ${page.title}\n`);
  });
});

// These swap one data module for a test double, so each loads markdown.ts afresh.
describe("twins built from other data", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/docs/registry");
    vi.doUnmock("@/lib/docs/status");
    vi.resetModules();
  });

  it("link each spend check's code to its build/errors row once that page exists", async () => {
    vi.resetModules();
    vi.doMock("@/lib/docs/registry", async (importOriginal) => {
      const real = await importOriginal<typeof import("@/lib/docs/registry")>();
      const errors = { ...real.PAGES[0], path: "build/errors", title: "Errors" };
      return {
        ...real,
        findPage: (path: string) => (path === "build/errors" ? errors : real.findPage(path)),
      };
    });
    const fresh = await import("@/lib/docs/markdown");
    const out = fresh.mdxToMarkdown("<SpendChecks />", { file: "t.mdx", origin: ORIGIN });
    const refused = cellsOf(out)
      .slice(1)
      .map((row) => row[2]);
    expect(refused).toEqual(SPEND_CHECKS.map((c) => c.code));
    for (const c of SPEND_CHECKS) {
      expect(out).toContain(`| [\`${c.code}\`](${ORIGIN}/docs/build/errors.md#${c.code}) |`);
    }
  });

  it("keep a cell that looks like Markdown as text, as the page does", async () => {
    vi.resetModules();
    vi.doMock("@/lib/docs/status", () => ({
      docsStatusRows: () => [
        { id: "x", feature: "*x* and [x](y)", status: "live", detail: "a | b, `c|d` and <Tag>" },
      ],
    }));
    const fresh = await import("@/lib/docs/markdown");
    const out = fresh.mdxToMarkdown("<StatusTable />", { file: "t.mdx", origin: ORIGIN });
    expect(cellsOf(out)[1]).toEqual(["*x* and [x](y)", "Live", "a | b, c|d and <Tag>"]);
  });
});
