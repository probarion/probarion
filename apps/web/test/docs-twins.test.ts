import { VAULT_ERROR_CODES } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { DOCS_COMPONENTS } from "@/components/docs/mdx";
import { AGENT_RULES, AGENT_RULES_TITLE } from "@/lib/docs/agents";
import { anchorsOf, duplicateAnchors, headingsOf, tocOf } from "@/lib/docs/headings";
import { llmsFull, llmsIndex } from "@/lib/docs/llms";
import { MDX_COMPONENT_NAMES, mdxToMarkdown, twinUrl } from "@/lib/docs/markdown";
import { mdHref, PAGES, pageFile } from "@/lib/docs/registry";
import { readSource } from "@/lib/docs/source";
import { pageMarkdown, readingMinutes } from "@/lib/docs/twins";

const ORIGIN = "https://probarion.xyz";
const md = (source: string) => mdxToMarkdown(source, { file: "test.mdx", origin: ORIGIN });

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

  it("has a handler for every component the pages can use, and no other", () => {
    const components = Object.keys(DOCS_COMPONENTS).filter((k) => /^[A-Z]/.test(k));
    expect([...MDX_COMPONENT_NAMES].sort()).toEqual(components.sort());
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
    expect(out).toContain(`## ${AGENT_RULES_TITLE}`);
    for (const page of PAGES) expect(out, page.path).toContain(`(${ORIGIN}${mdHref(page.path)})`);
    expect(out).toContain(`(${ORIGIN}/llms-full.txt)`);
  });

  it("llms-full.txt holds the rules and every page", async () => {
    const out = await llmsFull(ORIGIN);
    expect(out).toContain(`## ${AGENT_RULES_TITLE}`);
    for (const page of PAGES) expect(out, page.path).toContain(`\n# ${page.title}\n`);
  });
});
