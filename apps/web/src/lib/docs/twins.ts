import { buildCommit } from "./build-info";
import { mdxToMarkdown } from "./markdown";
import { docsHref, pageFile } from "./registry";
import { readSource } from "./source";
import { type DocPage, NETWORK_CHIPS, STATUS_LABELS } from "./types";

/**
 * A page as one Markdown document: title, description, lede, facts line, canonical address, then
 * the body. The facts line names the build commit when it is known.
 */
export async function pageMarkdown(
  page: DocPage,
  origin: string,
  commit: string | null = buildCommit(),
): Promise<string> {
  const body = mdxToMarkdown(await readSource(page.path), {
    file: `content/docs/${pageFile(page.path)}.mdx`,
    origin,
  });
  const facts = [
    page.status ? `Status: ${STATUS_LABELS[page.status]}` : null,
    page.network ? `Network: ${NETWORK_CHIPS[page.network].join(" and ")}` : null,
    `Reviewed: ${page.reviewed}`,
    commit ? `Built from: ${commit}` : null,
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

/** The twin's head: everything up to and including its "Canonical page:" line. */
const TWIN_HEAD = /^[\s\S]*?^Canonical page: .*$/m;
/** A fenced code block, in a list or a quote too: its opening fence to the matching close. */
const FENCED = /^[ \t>]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t>]*\1[ \t]*$/gm;

/**
 * Minutes to read a page's prose, at 220 words a minute, never less than 1. The twin's head and
 * its fenced code blocks do not count: a reader runs or copies code rather than reads it.
 */
export function readingMinutes(markdown: string): number {
  const prose = markdown.replace(TWIN_HEAD, "").replace(FENCED, "");
  const words = prose.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}
