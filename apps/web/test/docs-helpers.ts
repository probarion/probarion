import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { anchorsOf } from "@/lib/docs/headings";
import { findPage, pageFile } from "@/lib/docs/registry";
import { appRoutes, hrefResolves, publicPaths } from "./deploy-scan";

export const WEB = fileURLToPath(new URL("..", import.meta.url));
export const ROOT = join(WEB, "..", "..");
export const DOCS_DIR_TEST = join(WEB, "content", "docs");

/** Every file under `dir` whose name ends with `ext`, as absolute paths, sorted. */
export function walkFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out.sort();
}

/** The registry path of every MDX file under content/docs ("" for index.mdx), sorted. */
export function mdxPaths(): string[] {
  return walkFiles(DOCS_DIR_TEST, ".mdx")
    .map((f) =>
      relative(DOCS_DIR_TEST, f)
        .split(sep)
        .join("/")
        .replace(/\.mdx$/, ""),
    )
    .map((p) => (p === "index" ? "" : p))
    .sort();
}

export function readMdx(path: string): string {
  return readFileSync(join(DOCS_DIR_TEST, `${path === "" ? "index" : path}.mdx`), "utf8");
}

/** A page's MDX file, relative to apps/web, as an error names it. */
export const fileOf = (path: string) => `content/docs/${pageFile(path)}.mdx`;

// --- links ---------------------------------------------------------------------------------------

/**
 * A page's anchors, computed once: a page with many links would parse its targets again for
 * each one.
 */
const ANCHORS = new Map<string, Set<string>>();
function pageAnchors(path: string): Set<string> {
  let ids = ANCHORS.get(path);
  if (!ids) {
    ids = anchorsOf(readMdx(path), fileOf(path));
    ANCHORS.set(path, ids);
  }
  return ids;
}

/**
 * Pages that exist but that the phase-1 docs do not link: the Canary's page and the extension's
 * connect page.
 */
const NOT_LINKED = ["/canary", "/extension"];
/** The site's own hosts: a link to a page here is written as a site path, not a full URL. */
const OWN_HOSTS = ["probarion.xyz", "www.probarion.xyz"];
const BAD_ESCAPE = "malformed %-escape";

/** The app's routes and public files, read once, on the first link that needs them. */
let site: { patterns: string[]; files: string[] } | undefined;
function siteRoutes(): { patterns: string[]; files: string[] } {
  site ??= { patterns: appRoutes(WEB), files: publicPaths(WEB) };
  return site;
}

/** `decodeURIComponent`, or null for a malformed %-escape (its URIError names no file). */
function decoded(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Why `url`, written on the page at `from` (its registry path, read only for a `#` link), is a
 * bad link; null when it is fine. The rules are the authoring guide's (content/docs/README.md,
 * Links).
 */
export function linkProblem(url: string, from: string): string | null {
  if (url.startsWith("#")) {
    const id = decoded(url.slice(1));
    if (id === null) return BAD_ESCAPE;
    return pageAnchors(from).has(id) ? null : `no ${url} on this page`;
  }
  if (/^mailto:/i.test(url)) return "no mailto links";
  if (/^http:/i.test(url)) return "use https";
  if (/^https:/i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "malformed URL";
    }
    if (OWN_HOSTS.includes(parsed.hostname)) {
      return `use the site path ${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    const repoFile =
      parsed.hostname === "github.com"
        ? /^\/probarion\/probarion\/(?:blob|tree)\/(?:main|dev)\/(.+)$/.exec(parsed.pathname)?.[1]
        : undefined;
    if (repoFile) {
      const file = decoded(repoFile);
      if (file === null) return BAD_ESCAPE;
      if (!existsSync(join(ROOT, file))) return `no ${repoFile} in the repository`;
    }
    return null;
  }
  if (!url.startsWith("/")) return "relative link: start it with /";
  const [rawPath = "", hash = ""] = url.split("#");
  const path = rawPath.replace(/\?.*$/, "");
  if (NOT_LINKED.some((r) => path === r || path.startsWith(`${r}/`))) {
    return "the phase-1 docs do not link this page";
  }
  if (path === "/docs.md") return null;
  if (path === "/docs" || path.startsWith("/docs/")) {
    const pagePath = (path.endsWith(".md") ? path.slice(0, -3) : path).replace(/^\/docs\/?/, "");
    const page = findPage(pagePath);
    if (!page) return `no docs page at ${path}`;
    if (hash) {
      const id = decoded(hash);
      if (id === null) return BAD_ESCAPE;
      if (!pageAnchors(page.path).has(id)) {
        return `no #${hash} on ${path}`;
      }
    }
    return null;
  }
  const { patterns, files } = siteRoutes();
  return hrefResolves(path, patterns, files) ? null : `no page or file at ${path}`;
}
