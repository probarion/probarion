import { mdxToMarkdown } from "./markdown";
import { docsHref, pageFile } from "./registry";
import { readSource } from "./source";
import { type DocPage, NETWORK_CHIPS, STATUS_LABELS } from "./types";

/**
 * A page as one Markdown document: title, description, lede, status line, canonical address, then
 * the body.
 */
export async function pageMarkdown(page: DocPage, origin: string): Promise<string> {
  const body = mdxToMarkdown(await readSource(page.path), {
    file: `content/docs/${pageFile(page.path)}.mdx`,
    origin,
  });
  const facts = [
    page.status ? `Status: ${STATUS_LABELS[page.status]}` : null,
    page.network ? `Network: ${NETWORK_CHIPS[page.network].join(" and ")}` : null,
    `Reviewed: ${page.reviewed}`,
  ]
    .filter((f): f is string => f !== null)
    .join(" · ");
  return [
    `# ${page.title}`,
    `> ${page.description}`,
    page.lede,
    facts,
    `Canonical page: ${origin}${docsHref(page.path)}`,
    body.trimEnd(),
  ]
    .join("\n\n")
    .concat("\n");
}

/** Minutes to read, at 220 words a minute, never less than 1. */
export function readingMinutes(markdown: string): number {
  const words = markdown.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}
