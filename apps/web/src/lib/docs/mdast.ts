import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * The JSX nodes remark-mdx adds to mdast, taken from RootContent so no extra type package is
 * needed.
 */
export type JsxNode = Extract<RootContent, { type: "mdxJsxFlowElement" | "mdxJsxTextElement" }>;

const mdxParser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);
const mdParser = unified().use(remarkParse).use(remarkGfm);

/** A docs page's tree, parsed the way @next/mdx parses it (remark-gfm on). */
export function parseMdx(source: string): Root {
  return mdxParser.parse(source) as Root;
}

/** Plain Markdown (no JSX), for the tables and lists the twins generate. */
export function parseMarkdown(source: string): Root {
  return mdParser.parse(source) as Root;
}

function childrenOf(node: Root | RootContent): RootContent[] {
  return "children" in node && Array.isArray(node.children) ? (node.children as RootContent[]) : [];
}

/** Every JSX element in the tree, depth first, in document order. */
export function jsxNodes(tree: Root): JsxNode[] {
  const out: JsxNode[] = [];
  const visit = (node: Root | RootContent) => {
    if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") out.push(node);
    for (const child of childrenOf(node)) visit(child);
  };
  visit(tree);
  return out;
}

/**
 * A string attribute. An expression value (`kind={...}`) throws: twins and tests need literal
 * props.
 */
export function attrOf(node: JsxNode, name: string, file: string): string | undefined {
  for (const a of node.attributes) {
    if (a.type !== "mdxJsxAttribute" || a.name !== name) continue;
    if (a.value === null || a.value === undefined) return undefined;
    if (typeof a.value !== "string") {
      throw new Error(`<${node.name}> attribute ${name} must be a plain string in ${file}`);
    }
    return a.value;
  }
  return undefined;
}

export { childrenOf };
