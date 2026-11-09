import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pageFile } from "./registry";

/** content/docs under the web app. Next builds and vitest both run from apps/web. */
export const DOCS_DIR = join(process.cwd(), "content", "docs");

/**
 * A page's MDX source, read at build time for the twins, the TOC and the search index. Server only.
 */
export function readSource(path: string): Promise<string> {
  return readFile(join(DOCS_DIR, `${pageFile(path)}.mdx`), "utf8");
}
