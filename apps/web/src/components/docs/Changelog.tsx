import type { Root, RootContent } from "mdast";
import { createElement, type ReactNode } from "react";
import { changelogHeadings, changelogTree } from "@/lib/docs/changelog";
import { DocLink, H2, H3, H4 } from "./prose";

const HEADINGS = { 2: H2, 3: H3, 4: H4 } as const;

/**
 * mdast to React for the node types CHANGELOG.md uses. Headings and links render through the same
 * components as an MDX page's. Any other type throws, so a table, an image, a reference-style link
 * (a link reference or its definition) or raw HTML in the changelog fails the build instead of
 * rendering a blank section.
 */
export function renderMdast(nodes: readonly RootContent[], ids: ReadonlyMap<RootContent, string>) {
  return nodes.map((node, at) => renderNode(node, `${at}`, ids));
}

function renderNode(
  node: RootContent,
  key: string,
  ids: ReadonlyMap<RootContent, string>,
): ReactNode {
  const kids = () => ("children" in node ? renderMdast(node.children as RootContent[], ids) : []);
  switch (node.type) {
    case "heading": {
      if (node.depth !== 2 && node.depth !== 3 && node.depth !== 4) {
        throw new Error(`Changelog: unsupported heading depth ${node.depth}`);
      }
      return createElement(HEADINGS[node.depth], { key, id: ids.get(node) }, ...kids());
    }
    case "paragraph":
      return createElement("p", { key }, ...kids());
    case "list":
      return createElement(node.ordered ? "ol" : "ul", { key }, ...kids());
    case "listItem":
      return createElement("li", { key }, ...kids());
    case "blockquote":
      return createElement("blockquote", { key }, ...kids());
    case "text":
      return node.value;
    case "inlineCode":
      return createElement("code", { key }, node.value);
    case "code":
      return createElement("pre", { key }, createElement("code", null, node.value));
    case "link":
      return createElement(
        DocLink,
        { key, href: node.url, title: node.title ?? undefined },
        ...kids(),
      );
    case "emphasis":
      return createElement("em", { key }, ...kids());
    case "strong":
      return createElement("strong", { key }, ...kids());
    case "break":
      return createElement("br", { key });
    case "thematicBreak":
      return createElement("hr", { key });
    default:
      throw new Error(`Changelog: unsupported Markdown node "${node.type}"`);
  }
}

/** The repository's CHANGELOG.md, rendered at build time. */
export function ChangelogView({ tree }: { tree: Root }) {
  const ids = new Map<RootContent, string>(changelogHeadings(tree).map((h) => [h.node, h.id]));
  return <>{renderMdast(tree.children, ids)}</>;
}

/** `<Changelog />` on resources/changelog. */
export function Changelog() {
  return <ChangelogView tree={changelogTree()} />;
}
