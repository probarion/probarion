import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { slug } from "github-slugger";
import type { Heading, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { REPO_URL } from "@/lib/proof/cli";
import type { TocItem } from "./toc-spy";

/** The repository's CHANGELOG.md. Next builds and vitest both run from apps/web. */
const CHANGELOG_FILE = join(process.cwd(), "..", "..", "CHANGELOG.md");

/** The site's own hosts: the docs link a page here by its site path, never by a full URL. */
const SITE_HOSTS: readonly string[] = ["probarion.xyz", "www.probarion.xyz"];

/**
 * A link as the changelog page needs it. A relative link names a file in the repository, so it
 * opens that file on GitHub, never a missing page under /docs/resources/. A full https URL of this
 * site becomes its site path, as the docs link rules ask. Other absolute URLs, site paths and
 * fragments stay as they are, and the docs tests hold them to the same rules as an MDX link.
 */
export function rewriteLink(url: string): string {
  if (/^https:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return url;
    }
    return SITE_HOSTS.includes(parsed.hostname)
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : url;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/") || url.startsWith("#")) return url;
  const path = posix.normalize(url).replace(/^(\.\/)+/, "");
  return `${REPO_URL}/blob/main/${path}`;
}

/**
 * Only inline links are rewritten. A reference-style link (`[text][ref]` with a `[ref]: url`
 * definition) fails the build instead: the page refuses a definition and a link reference.
 */
function rewriteLinks(node: Root | RootContent): void {
  if (node.type === "link") node.url = rewriteLink(node.url);
  if ("children" in node) for (const child of node.children) rewriteLinks(child);
}

let cached: Root | undefined;

/**
 * CHANGELOG.md as mdast, without its H1 (the page head shows the title), its links rewritten.
 * Read once per process, at build time. Server only.
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

/**
 * The changelog's headings, each with the id the page gives it, in document order. A version (an
 * H2) takes the slug of its own text. A section under it (an H3 or H4) takes the version's id, a
 * hyphen, then its own slug, such as `unreleased-added`, so a link to a section keeps its meaning
 * when the next release is cut. Nothing numbers a repeat: the docs tests fail on one.
 */
export function changelogHeadings(tree: Root = changelogTree()): { node: Heading; id: string }[] {
  let version = "";
  return tree.children
    .filter((n): n is Heading => n.type === "heading")
    .map((node) => {
      const own = slug(plainText(node));
      if (node.depth <= 2) {
        version = own;
        return { node, id: own };
      }
      return { node, id: version === "" ? own : `${version}-${own}` };
    });
}

/** The anchors the changelog puts on its page. */
export function changelogAnchors(): string[] {
  return changelogHeadings().map((h) => h.id);
}

/** "On this page" for the changelog: its versions and their sections, the H2s and H3s. */
export function changelogToc(tree: Root = changelogTree()): TocItem[] {
  return changelogHeadings(tree)
    .filter((h) => h.node.depth === 2 || h.node.depth === 3)
    .map((h) => ({ id: h.id, text: plainText(h.node), depth: h.node.depth }));
}
