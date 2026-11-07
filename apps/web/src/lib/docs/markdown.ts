import { CHECK_NAMES, VAULT_ERROR_CODES } from "@probarion/core";
import type { Paragraph, PhrasingContent, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { CHECK_LABELS } from "@/lib/site/facts";
import { AGENT_RULES } from "./agents";
import { CALLOUT_KINDS, calloutFooter, isCalloutKind } from "./callouts";
import { HTTP_ERRORS, SDK_ERRORS, VAULT_ERRORS } from "./errors";
import { attrOf, type JsxNode, parseMarkdown, parseMdx } from "./mdast";
import { mdHref } from "./registry";
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

function para(children: PhrasingContent[]): Paragraph {
  return { type: "paragraph", children };
}

/** Phrasing children (a one-line component) wrapped in a paragraph; block children as they are. */
function blocks(nodes: RootContent[]): RootContent[] {
  return nodes.length > 0 && nodes.every((n) => PHRASING.has(n.type))
    ? [para(nodes as PhrasingContent[])]
    : nodes;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** A GFM table as mdast nodes. */
function table(headers: string[], rows: string[][]): RootContent[] {
  const lines = [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ];
  return parseMarkdown(lines.join("\n")).children;
}

const code = (value: string) => `\`${value}\``;

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
          para([{ type: "strong", children: [text(title)] }]),
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
    const codes = ctx.convert(node.children as RootContent[]).filter((n) => n.type === "code");
    // The same label rule as the component (lib/docs/tabs.ts), with the page named.
    let names: string[];
    try {
      names = tabNames(labels, codes.length);
    } catch (error) {
      throw new Error(`${(error as Error).message} in ${ctx.file}`);
    }
    return codes.flatMap((c, at) => [
      para([{ type: "strong", children: [text(names[at] ?? "")] }]),
      c,
    ]);
  },
  CodeBlock(node, ctx) {
    const title = attrOf(node, "title", ctx.file) ?? "";
    return [
      para([{ type: "inlineCode", value: title }]),
      ...ctx.convert(node.children as RootContent[]),
    ];
  },
  ErrorCatalog(node, ctx) {
    const kind = attrOf(node, "kind", ctx.file);
    if (kind === "vault") {
      return table(
        ["Code", "Meaning", "Raised by", "Retry helps", "What to do"],
        VAULT_ERROR_CODES.map((c) => {
          const e = VAULT_ERRORS[c];
          return [code(c), e.meaning, e.raisedBy, e.retryable ? "Yes" : "No", e.next];
        }),
      );
    }
    if (kind === "sdk") {
      return table(
        ["Class", "`.code`", "When", "Extra fields"],
        SDK_ERRORS.map((e) => [
          `${code(e.name)} (extends ${e.parent})`,
          code(e.code),
          e.when,
          e.fields || "None",
        ]),
      );
    }
    if (kind === "http") {
      return table(
        ["Status", "Code", "Returned by", "Meaning", "What to do"],
        HTTP_ERRORS.map((e) => [String(e.status), code(e.code), e.where, e.meaning, e.next]),
      );
    }
    throw new Error(`ErrorCatalog: unknown kind "${String(kind)}" in ${ctx.file}`);
  },
  SpendChecks: () =>
    table(
      ["#", "The vault asks", "Refused with"],
      SPEND_CHECKS.map((c, at) => [String(at + 1), c.question, code(c.code)]),
    ),
  VerifierChecks(node, ctx) {
    return selectChecks(attrOf(node, "only", ctx.file)).flatMap(
      (id) =>
        parseMarkdown(
          [
            `### ${id}. ${CHECK_LABELS[id]} (${code(CHECK_NAMES[id])})`,
            `**Proves.** ${VERIFIER_DOCS[id].proves}`,
            `**Does not prove.** ${VERIFIER_DOCS[id].limits}`,
          ].join("\n\n"),
        ).children,
    );
  },
  StatusTable: () =>
    table(
      ["Feature", "Status", "Detail"],
      docsStatusRows().map((r) => [r.feature, STATUS_LABELS[r.status], r.detail]),
    ),
  AgentRules: () =>
    parseMarkdown(AGENT_RULES.map((r, at) => `${at + 1}. ${r}`).join("\n")).children,
};

/** The component names a page may use: exactly the ones with a Markdown form. */
export const MDX_COMPONENT_NAMES: readonly string[] = Object.keys(HANDLERS);

/**
 * An internal link made absolute; a docs page's link points at its .md twin. A link that is a
 * twin already (`/docs.md`, `/docs/<path>.md`) keeps its path: never a second .md. Hash links
 * stay as they are.
 */
export function twinUrl(url: string, origin: string): string {
  if (!url.startsWith("/")) return url;
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
