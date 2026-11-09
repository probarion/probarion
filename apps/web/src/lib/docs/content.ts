import type { MDXContent } from "mdx/types";
import { pageFile } from "./registry";

/**
 * A page's compiled MDX. One template-literal import, so the bundler includes every file under
 * content/docs.
 */
export async function loadPage(path: string): Promise<MDXContent> {
  const mod = (await import(`../../../content/docs/${pageFile(path)}.mdx`)) as {
    default: MDXContent;
  };
  return mod.default;
}
