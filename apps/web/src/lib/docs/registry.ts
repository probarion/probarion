import { BUILD } from "./pages/build";
import { CONCEPTS } from "./pages/concepts";
import { HOME } from "./pages/home";
import { OPERATE } from "./pages/operate";
import { RESOURCES } from "./pages/resources";
import { START } from "./pages/start";
import { TRUST } from "./pages/trust";
import { type DocPage, SECTION_LABELS, SECTIONS, type Section } from "./types";

/**
 * Every docs page in reading order: the home, then each section in SECTIONS order. It is the one
 * source for the routes, the sidebar, the tabs, the pager, the search index, the .md twins, the
 * llms files and the sitemap. It holds only pages that exist: a later page is added with its MDX
 * file, never before.
 */
export const PAGES: readonly DocPage[] = [
  HOME,
  ...START,
  ...CONCEPTS,
  ...BUILD,
  ...TRUST,
  ...OPERATE,
  ...RESOURCES,
];

export function findPage(path: string): DocPage | undefined {
  return PAGES.find((p) => p.path === path);
}

/** The registry path for an optional catch-all's params: no slug is the home. */
export function pathFromSlug(slug?: readonly string[]): string {
  return (slug ?? []).join("/");
}

export function slugParams(): { slug: string[] }[] {
  return PAGES.map((p) => ({ slug: p.path === "" ? [] : p.path.split("/") }));
}

export function docsHref(path: string): string {
  return path === "" ? "/docs" : `/docs/${path}`;
}

/** The Markdown twin's address (next.config.ts rewrites it to /docs-md). */
export function mdHref(path: string): string {
  return path === "" ? "/docs.md" : `/docs/${path}.md`;
}

/** The MDX file under content/docs, without the extension. */
export function pageFile(path: string): string {
  return path === "" ? "index" : path;
}

export function sectionOf(path: string): Section | null {
  const first = path.split("/")[0] ?? "";
  return (SECTIONS as readonly string[]).includes(first) ? (first as Section) : null;
}

export function navLabel(page: DocPage): string {
  return page.nav ?? page.title;
}

export interface SidebarGroup {
  section: Section;
  label: string;
  pages: readonly DocPage[];
}

/** The sections that have at least one page, in SECTIONS order. */
export function sidebarGroups(): SidebarGroup[] {
  return SECTIONS.map((section) => ({
    section,
    label: SECTION_LABELS[section],
    pages: PAGES.filter((p) => sectionOf(p.path) === section),
  })).filter((g) => g.pages.length > 0);
}

/**
 * The id of a group title in the sidebar ("side") or in the phone drawer ("drawer"). A docs page
 * renders both, so the two copies need their own ids; headings.ts reserves every one of them.
 */
export function groupTitleId(where: "side" | "drawer", section: Section): string {
  return `${where}-${section}`;
}

export function neighbours(path: string): { prev?: DocPage; next?: DocPage } {
  const at = PAGES.findIndex((p) => p.path === path);
  if (at < 0) return {};
  return { prev: PAGES[at - 1], next: PAGES[at + 1] };
}

/**
 * The docs bar's tabs. Each opens its first page; a tab whose page does not exist yet is not shown.
 */
export const TABS = [
  { id: "guides", label: "Guides", path: "start/what-is-probarion" },
  { id: "build", label: "Build", path: "build/install" },
  { id: "trust", label: "Verify & trust", path: "trust/verify-a-vault" },
  { id: "reference", label: "Reference", path: "build/errors" },
  { id: "changelog", label: "Changelog", path: "resources/changelog" },
] as const;
export type TabId = (typeof TABS)[number]["id"];

export function tabOf(page: DocPage): TabId | null {
  if (page.path === "resources/changelog") return "changelog";
  const section = sectionOf(page.path);
  if (section === null) return null;
  if (section === "trust") return "trust";
  if (section === "build") return page.type === "reference" ? "reference" : "build";
  if (section === "operate") return "build";
  return "guides";
}

export function visibleTabs(): (typeof TABS)[number][] {
  return TABS.filter((t) => findPage(t.path) !== undefined);
}
