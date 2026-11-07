import GithubSlugger from "github-slugger";
import type { Heading, Root, RootContent } from "mdast";
import { generatedAnchors } from "./anchors";
import { childrenOf, parseMdx } from "./mdast";
import type { TocItem } from "./toc-spy";

function textOf(node: RootContent): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  return childrenOf(node).map(textOf).join("");
}

function headingsIn(tree: Root): TocItem[] {
  const slugger = new GithubSlugger();
  const out: TocItem[] = [];
  const visit = (node: Root | RootContent) => {
    if (node.type === "heading") {
      const text = (node as Heading).children.map(textOf).join("");
      out.push({ depth: node.depth, text, id: slugger.slug(text) });
      return;
    }
    for (const child of childrenOf(node)) visit(child);
  };
  visit(tree);
  return out;
}

/**
 * Every heading, with the id rehype-slug gives it: one slugger per page, in document order, depth
 * first (headings inside a JSX block count too, as they do for rehype-slug).
 */
export function headingsOf(source: string): TocItem[] {
  return headingsIn(parseMdx(source));
}

/** "On this page": the H2s and H3s. */
export function tocOf(source: string): TocItem[] {
  return headingsOf(source).filter((h) => h.depth === 2 || h.depth === 3);
}

/** Every id on the page, in document order per kind: heading ids, then generated anchors. */
function idsOf(source: string, file?: string): string[] {
  const tree = parseMdx(source);
  return [...headingsIn(tree).map((h) => h.id), ...generatedAnchors(tree, file)];
}

/**
 * Every id a link may target on this page: heading ids plus the generated components' anchors.
 * `file` names the page in the error when a generated component's prop is not a plain string.
 */
export function anchorsOf(source: string, file?: string): Set<string> {
  return new Set(idsOf(source, file));
}

/**
 * The ids that appear more than once on the page, each listed once. rehype-slug numbers a repeated
 * heading but does not see the ids generated components add, so a heading such as "Canary" next
 * to <StatusTable /> gets the id of a table row, and a link to it lands on whichever comes first.
 */
export function duplicateAnchors(source: string, file?: string): string[] {
  const ids = idsOf(source, file);
  return [...new Set(ids.filter((id, at) => ids.indexOf(id) !== at))];
}
