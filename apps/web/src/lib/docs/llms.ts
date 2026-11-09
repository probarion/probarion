import { SITE_DESCRIPTION } from "@/lib/site/facts";
import { AGENT_RULES_TITLE } from "./agents";
import { buildCommit } from "./build-info";
import { agentRulesMarkdown } from "./markdown";
import { findPage, mdHref, PAGES, sidebarGroups } from "./registry";
import { pageMarkdown } from "./twins";

/**
 * The rules, as llmstxt.org places details: a line and a numbered list before the first H2, since
 * every H2 section is a list of links.
 */
function rulesBlock(): string[] {
  return [`${AGENT_RULES_TITLE}:`, "", agentRulesMarkdown().trimEnd(), ""];
}

/**
 * /llms.txt in the llmstxt.org shape: H1, summary quote, the rules, then H2 sections of links to
 * the .md twins.
 */
export function llmsIndex(origin: string): string {
  const home = findPage("");
  const lines = ["# Probarion docs", "", `> ${SITE_DESCRIPTION}`, "", ...rulesBlock()];
  if (home) {
    lines.push(
      "## Docs home",
      "",
      `- [${home.title}](${origin}${mdHref("")}): ${home.description}`,
      "",
    );
  }
  for (const group of sidebarGroups()) {
    lines.push(`## ${group.label}`, "");
    for (const p of group.pages) {
      lines.push(`- [${p.title}](${origin}${mdHref(p.path)}): ${p.description}`);
    }
    lines.push("");
  }
  lines.push(
    "## Optional",
    "",
    `- [All docs in one file](${origin}/llms-full.txt): every page above, as Markdown`,
    "",
  );
  return lines.join("\n");
}

/** /llms-full.txt: the same head, then every page's twin in reading order, each naming the commit. */
export async function llmsFull(
  origin: string,
  commit: string | null = buildCommit(),
): Promise<string> {
  const head = [
    "# Probarion docs, full text",
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    ...rulesBlock(),
  ].join("\n");
  const pages = await Promise.all(PAGES.map((p) => pageMarkdown(p, origin, commit)));
  return `${head}\n${pages.join("\n---\n\n")}`;
}
