import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import GithubSlugger from "github-slugger";
import type { Heading, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { REPO_URL } from "@/lib/proof/cli";

/** The repository's CHANGELOG.md. Next builds and vitest both run from apps/web. */
const CHANGELOG_FILE = join(process.cwd(), "..", "..", "CHANGELOG.md");

/**
 * A link as the changelog page needs it. A relative link names a file in the repository, so it
 * opens that file on GitHub, never a missing page under /docs/resources/. Absolute URLs, site
 * paths and fragments stay as they are.
 */
export function rewriteLink(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/") || url.startsWith("#")) return url;
  const path = posix.normalize(url).replace(/^(\.\/)+/, "");
  return `${REPO_URL}/blob/main/${path}`;
}

function rewriteLinks(node: Root | RootContent): void {
  if (node.type === "link" || node.type === "definition") node.url = rewriteLink(node.url);
  if ("children" in node) for (const child of node.children) rewriteLinks(child);
}

let cached: Root | undefined;

/**
 * CHANGELOG.md as mdast, without its H1 (the page head shows the title), its relative links
 * rewritten. Read once per process, at build time. Server only.
 */
export function changelogTree(): Root {
  if (cached) return cached;
  const source = readFileSync(CHANGELOG_FILE, "utf8");
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
  const root: Root = {
    type: "root",
    children: tree.children.filter((n) => !(n.type === "heading" && n.depth === 1)),
  };
  rewriteLinks(root);
  cached = root;
  return root;
}

/** The plain text of a node, as a heading's id is made from it. */
export function plainText(node: RootContent): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if ("children" in node) return node.children.map((c) => plainText(c as RootContent)).join("");
  return "";
}

/** The changelog's headings, each with the id the page gives it, in document order. */
export function changelogHeadings(tree: Root = changelogTree()): { node: Heading; id: string }[] {
  const slugger = new GithubSlugger();
  return tree.children
    .filter((n): n is Heading => n.type === "heading")
    .map((node) => ({ node, id: slugger.slug(plainText(node)) }));
}

/** The anchors the changelog puts on its page. */
export function changelogAnchors(): string[] {
  return changelogHeadings().map((h) => h.id);
}
