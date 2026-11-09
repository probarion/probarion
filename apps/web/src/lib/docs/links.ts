import { REPO_URL } from "@/lib/proof/cli";
import { docsHref, pageFile } from "./registry";
import type { DocPage } from "./types";

/** A repo file on GitHub at the build commit, else on main. */
export function sourceUrl(path: string, commit: string | null): string {
  return `${REPO_URL}/blob/${commit ?? "main"}/${path}`;
}

/** "Edit this page": the MDX file on dev, where changes land. */
export function editUrl(page: DocPage): string {
  return `${REPO_URL}/edit/dev/apps/web/content/docs/${pageFile(page.path)}.mdx`;
}

/**
 * "Report a problem": a new issue that names the page. Only the public page address goes in the
 * URL.
 */
export function issueUrl(page: DocPage, origin: string): string {
  const query = new URLSearchParams({
    title: `Docs: ${page.title}`,
    body: `Page: ${origin}${docsHref(page.path)}\n\nWhat is wrong or missing:\n`,
  });
  return `${REPO_URL}/issues/new?${query.toString()}`;
}
