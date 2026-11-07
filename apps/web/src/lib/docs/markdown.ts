import { CHECK_NAMES, type CheckId, VAULT_ERROR_CODES } from "@probarion/core";
import type {
  Heading,
  List,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableRow,
} from "mdast";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { CHECK_LABELS } from "@/lib/site/facts";
import { richParts } from "@/lib/site/rich";
import { AGENT_RULES } from "./agents";
import { CALLOUT_KINDS, calloutFooter, isCalloutKind } from "./callouts";
import { errorAnchor, HTTP_ERRORS, SDK_ERRORS, VAULT_ERRORS } from "./errors";
import { attrOf, inFile, type JsxNode, parseMdx } from "./mdast";
import { docsHref, findPage, mdHref } from "./registry";
import { SPEND_CHECKS } from "./spend-checks";
import { docsStatusRows } from "./status";
import { tabNames } from "./tabs";
import { STATUS_LABELS } from "./types";
import { selectChecks, VERIFIER_DOCS } from "./verifier";

export interface MarkdownOptions {
  /** Named in errors, so a failing build points at the page. */
  file: string;
  /** Internal links become absolute on this origin. */
  origin: string;
}

interface Ctx extends MarkdownOptions {
  convert: (nodes: RootContent[]) => RootContent[];
}
type Handler = (node: JsxNode, ctx: Ctx) => RootContent[];

const PHRASING = new Set([
  "text",
  "emphasis",
  "strong",
  "inlineCode",
  "link",
  "break",
  "delete",
  "image",
]);

function text(value: string): PhrasingContent {
  return { type: "text", value };
}

function inline(value: string): PhrasingContent {
  return { type: "inlineCode", value };
}

function strong(value: string): PhrasingContent {
  return { type: "strong", children: [text(value)] };
}

function para(children: PhrasingContent[]): Paragraph {
  return { type: "paragraph", children };
}

/**
 * A line of generated copy as the page shows it (components/site/Rich.tsx): the parts in backticks
 * are code and the rest is text, never parsed as Markdown. The stringifier escapes what Markdown
 * needs, so `<Code>` or `*x*` in the copy reads the same in the twin.
 */
function rich(value: string): PhrasingContent[] {
  return richParts(value).map((part) => (part.code ? inline(part.text) : text(part.text)));
}

/** Phrasing children (a one-line component) wrapped in a paragraph; block children as they are. */
function blocks(nodes: RootContent[]): RootContent[] {
  return nodes.length > 0 && nodes.every((n) => PHRASING.has(n.type))
    ? [para(nodes as PhrasingContent[])]
    : nodes;
}

/** A table cell: generated copy (see rich), or nodes a handler built. */
type Cell = string | PhrasingContent[];

/** A GFM table as mdast nodes. */
function table(headers: Cell[], rows: Cell[][]): Table {
  const row = (cells: Cell[]): TableRow => ({
    type: "tableRow",
    children: cells.map((c) => ({
      type: "tableCell",
      // A line break would end the row.
      children: typeof c === "string" ? rich(c.replace(/\n/g, " ")) : c,
    })),
  });
  return {
    type: "table",
    align: headers.map(() => null),
    children: [row(headers), ...rows.map(row)],
  };
}

/** One verifier check: its H3, then what it proves and what it does not. */
function checkBlock(id: CheckId): RootContent[] {
  const heading: Heading = {
    type: "heading",
    depth: 3,
    children: [text(`${id}. ${CHECK_LABELS[id]} (`), inline(CHECK_NAMES[id]), text(")")],
  };
  return [
    heading,
    para([strong("Proves."), text(" "), ...rich(VERIFIER_DOCS[id].proves)]),
    para([strong("Does not prove."), text(" "), ...rich(VERIFIER_DOCS[id].limits)]),
  ];
}

/** The rules for agents as a numbered list. */
function rulesList(): List {
  return {
    type: "list",
    ordered: true,
    start: 1,
    spread: false,
    children: AGENT_RULES.map((rule) => ({
      type: "listItem",
      spread: false,
      children: [para(rich(rule))],
    })),
  };
}

/**
 * Every docs component's Markdown form.
 * A component with no entry here fails the twin, and so the build.
 */
const HANDLERS: Record<string, Handler> = {
  Callout(node, ctx) {
    const kind = attrOf(node, "kind", ctx.file) ?? "";
    if (!isCalloutKind(kind)) throw new Error(`Callout: unknown kind "${kind}" in ${ctx.file}`);
    const title = attrOf(node, "title", ctx.file) ?? CALLOUT_KINDS[kind].label;
    const footer = calloutFooter(kind);
    const body = blocks(ctx.convert(node.children as RootContent[]));
    return [
      {
        type: "blockquote",
        children: [
          para([strong(title)]),
          ...(body as Paragraph[]),
          ...(footer ? [para([{ type: "emphasis", children: [text(footer)] }])] : []),
        ],
      },
    ];
  },
  Steps: (node, ctx) => ctx.convert(node.children as RootContent[]),
  Flow: (node, ctx) => ctx.convert(node.children as RootContent[]),
  CodeTabs(node, ctx) {
    const labels = attrOf(node, "labels", ctx.file) ?? "";
    const panels = ctx.convert(node.children as RootContent[]);
    // The component makes each child a tab, so anything but a code block would be a tab of prose.
    const stray = panels.find((n) => n.type !== "code");
    if (stray) {
      throw new Error(`CodeTabs: holds only code blocks, not a ${stray.type}, in ${ctx.file}`);
    }
    // The same label rule as the component (lib/docs/tabs.ts), with the page named.
    const names = inFile(ctx.file, () => tabNames(labels, panels.length));
    return panels.flatMap((c, at) => [para([strong(names[at] ?? "")]), c]);
  },
  CodeBlock(node, ctx) {
    const title = attrOf(node, "title", ctx.file);
    if (!title) throw new Error(`CodeBlock: a title is required in ${ctx.file}`);
    return [para([inline(title)]), ...ctx.convert(node.children as RootContent[])];
  },
  ErrorCatalog(node, ctx) {
    const kind = attrOf(node, "kind", ctx.file);
    if (kind === "vault") {
      return [
        table(
          ["Code", "Meaning", "Raised by", "Retry helps", "What to do"],
          VAULT_ERROR_CODES.map((c) => {
            const e = VAULT_ERRORS[c];
            return [[inline(c)], e.meaning, e.raisedBy, e.retryable ? "Yes" : "No", e.next];
          }),
        ),
      ];
    }
    if (kind === "sdk") {
      return [
        table(
          ["Class", [inline(".code")], "When", "Extra fields"],
          SDK_ERRORS.map((e) => [
            [inline(e.name), text(` (extends ${e.parent})`)],
            [inline(e.code)],
            e.when,
            e.fields || "None",
          ]),
        ),
      ];
    }
    if (kind === "http") {
      return [
        table(
          ["Status", "Code", "Returned by", "Meaning", "What to do"],
          HTTP_ERRORS.map((e) => [String(e.status), [inline(e.code)], e.where, e.meaning, e.next]),
        ),
      ];
    }
    throw new Error(`ErrorCatalog: unknown kind "${String(kind)}" in ${ctx.file}`);
  },
  SpendChecks(_node, ctx) {
    // A code links to its entry on build/errors once that page exists, as in the component.
    const errors = findPage("build/errors");
    const refusal = (c: (typeof SPEND_CHECKS)[number]): PhrasingContent[] =>
      errors
        ? [
            {
              type: "link",
              url: twinUrl(`${docsHref(errors.path)}#${errorAnchor(c.code)}`, ctx.origin),
              children: [inline(c.code)],
            },
          ]
        : [inline(c.code)];
    return [
      table(
        ["#", "The vault asks", "Refused with"],
        SPEND_CHECKS.map((c, at) => [String(at + 1), c.question, refusal(c)]),
      ),
    ];
  },
  VerifierChecks(node, ctx) {
    const only = attrOf(node, "only", ctx.file);
    return inFile(ctx.file, () => selectChecks(only)).flatMap(checkBlock);
  },
  StatusTable: () => [
    table(
      ["Feature", "Status", "Detail"],
      docsStatusRows().map((r) => [r.feature, STATUS_LABELS[r.status], r.detail]),
    ),
  ],
  AgentRules: () => [rulesList()],
};

/** The component names a page may use: exactly the ones with a Markdown form. */
export const MDX_COMPONENT_NAMES: readonly string[] = Object.keys(HANDLERS);

/** A path on this site: one leading slash, not a protocol-relative `//host`. */
function isSitePath(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

/**
 * An internal link made absolute; a docs page's link points at its .md twin. A link that is a
 * twin already (`/docs.md`, `/docs/<path>.md`) keeps its path: never a second .md. Hash links
 * and other sites' links stay as they are.
 */
export function twinUrl(url: string, origin: string): string {
  if (!isSitePath(url)) return url;
  const at = url.indexOf("#");
  const path = at < 0 ? url : url.slice(0, at);
  const hash = at < 0 ? "" : url.slice(at);
  if (path.endsWith(".md")) return `${origin}${url}`;
  const page =
    path === "/docs" ? "" : path.startsWith("/docs/") ? path.slice("/docs/".length) : null;
  return `${origin}${page === null ? path : mdHref(page)}${hash}`;
}

function convert(nodes: RootContent[], opts: MarkdownOptions): RootContent[] {
  const ctx: Ctx = { ...opts, convert: (children) => convert(children, opts) };
  const out: RootContent[] = [];
  for (const node of nodes) {
    // A one-line `<Callout kind="note">text</Callout>` parses as a paragraph
    // holding one text element.
    if (
      node.type === "paragraph" &&
      node.children.length === 1 &&
      node.children[0]?.type === "mdxJsxTextElement"
    ) {
      out.push(
        ...convert(
          [{ ...node.children[0], type: "mdxJsxFlowElement" } as unknown as RootContent],
          opts,
        ),
      );
      continue;
    }
    if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
      const name = node.name ?? "<fragment>";
      const handler = HANDLERS[name];
      if (!handler) throw new Error(`markdown twin: no handler for <${name}> in ${opts.file}`);
      out.push(...handler(node, ctx));
      continue;
    }
    if (
      node.type === "mdxjsEsm" ||
      node.type === "mdxFlowExpression" ||
      node.type === "mdxTextExpression"
    ) {
      throw new Error(`markdown twin: ${node.type} is not allowed in ${opts.file}`);
    }
    if (node.type === "link" || node.type === "definition") {
      const next = { ...node, url: twinUrl(node.url, opts.origin) } as RootContent;
      if ("children" in next && Array.isArray(next.children)) {
        (next as { children: RootContent[] }).children = convert(
          next.children as RootContent[],
          opts,
        );
      }
      out.push(next);
      continue;
    }
    // An image is a file, not a page: made absolute, never pointed at a twin.
    if (node.type === "image") {
      out.push({ ...node, url: isSitePath(node.url) ? `${opts.origin}${node.url}` : node.url });
      continue;
    }
    if ("children" in node && Array.isArray(node.children)) {
      out.push({ ...node, children: convert(node.children as RootContent[], opts) } as RootContent);
      continue;
    }
    out.push(node);
  }
  return out;
}

// Tables are not padded: a row reads the same whatever the longest cell in its column.
// No remark-mdx here: it would escape every `<` and `{` in plain text as `\<` and `\{`, and
// convert() has already replaced or refused every MDX node.
const stringifier = unified()
  .use(remarkGfm, { tablePipeAlign: false })
  .use(remarkStringify, { bullet: "-", fences: true, rule: "-", emphasis: "_", strong: "*" });

/**
 * A page's MDX as plain Markdown, for the .md twin, the llms files, the search index and
 * "Copy page".
 */
export function mdxToMarkdown(source: string, opts: MarkdownOptions): string {
  const tree = parseMdx(source);
  const root: Root = { type: "root", children: convert(tree.children, opts) };
  return stringifier.stringify(root);
}

/** The rules for agents as a Markdown numbered list, for the llms files. */
export function agentRulesMarkdown(): string {
  return stringifier.stringify({ type: "root", children: [rulesList()] });
}
