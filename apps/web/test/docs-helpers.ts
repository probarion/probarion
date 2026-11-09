import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
