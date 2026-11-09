import { VAULT_ERROR_CODES } from "@probarion/core";
import type { Root, RootContent } from "mdast";
import { VAULT_ERRORS } from "./errors";
import { mdxToMarkdown } from "./markdown";
import { parseMarkdown } from "./mdast";
import { docsHref, findPage, PAGES, pageFile, sectionOf } from "./registry";
import type { SearchDoc, SearchKind } from "./search";
import { readSource } from "./source";
import { type DocPage, SECTION_LABELS } from "./types";

const BODY_LIMIT = 6000;

export function kindOf(page: DocPage): SearchKind {
  if (page.type === "explanation") return "concept";
  if (page.type === "reference") return "reference";
  return "guide";
}

/** The words of a Markdown tree: text and code, without link targets. */
function plain(node: Root | RootContent): string {
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code") return node.value;
  if ("children" in node) return (node.children as RootContent[]).map(plain).join(" ");
  return "";
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 0)) || cut;
}

const CLI =
  /node packages\/cli\/dist\/bin\.js (?:--(?:network|rpc) \S+ )*((?:vault|mandate|agent|ledger|spend) [a-z][\w-]*|check|verify)\b/g;

/** The vault codes, `PROBARION:` codes and CLI commands a page names, sorted. */
export function codesIn(markdown: string): string[] {
  const out = new Set<string>();
  for (const code of VAULT_ERROR_CODES) {
    if (new RegExp(`\\b${code}\\b`).test(markdown)) out.add(code);
  }
  for (const m of markdown.matchAll(/\bPROBARION:([A-Z]\w*)/g)) out.add(`PROBARION:${m[1]}`);
  for (const m of markdown.matchAll(CLI)) if (m[1]) out.add(m[1]);
  return [...out].sort();
}

const unquote = (s: string) => s.replace(/`/g, "");

/**
 * One entry per page in reading order, then one per vault error code once the errors page
 * exists.
 */
export async function buildSearchIndex(origin: string): Promise<SearchDoc[]> {
  const docs: SearchDoc[] = [];
  for (const page of PAGES) {
    const markdown = mdxToMarkdown(await readSource(page.path), {
      file: `content/docs/${pageFile(page.path)}.mdx`,
      origin,
    });
    const tree = parseMarkdown(markdown);
    const section = sectionOf(page.path);
    docs.push({
      id: page.path === "" ? "home" : page.path,
      href: docsHref(page.path),
      title: page.title,
      section: section === null ? "Docs" : SECTION_LABELS[section],
      kind: kindOf(page),
      headings: tree.children
        .filter((n) => n.type === "heading" && n.depth >= 2 && n.depth <= 3)
        .map((n) => clip(plain(n), 200))
        .join("\n"),
      codes: codesIn(markdown).join(" "),
      body: clip(plain(tree), BODY_LIMIT),
      summary: page.description,
    });
  }
  if (findPage("build/errors")) {
    for (const code of VAULT_ERROR_CODES) {
      const e = VAULT_ERRORS[code];
      docs.push({
        id: `error:${code}`,
        href: `/docs/build/errors#${code}`,
        title: `PROBARION:${code}`,
        section: "Errors",
        kind: "error",
        headings: "",
        codes: `${code} PROBARION:${code}`,
        body: clip(unquote(`${e.meaning} Raised by ${e.raisedBy}. ${e.next}`), BODY_LIMIT),
        summary: unquote(e.meaning),
      });
    }
  }
  return docs;
}
