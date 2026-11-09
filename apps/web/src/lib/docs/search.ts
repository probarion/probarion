import MiniSearch, { type SearchResult } from "minisearch";

// The docs search, shared by the server (which builds the index) and the dialog (which loads it).
// No node imports.

export const SEARCH_KINDS = ["guide", "concept", "reference", "error"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export const SEARCH_FILTERS = ["all", ...SEARCH_KINDS] as const;
export type SearchFilter = (typeof SEARCH_FILTERS)[number];

export const FILTER_LABELS: Readonly<Record<SearchFilter, string>> = {
  all: "All",
  guide: "Guides",
  concept: "Concepts",
  reference: "Reference",
  error: "Errors",
};

/** The kind shown on each result. */
export const KIND_LABELS: Readonly<Record<SearchKind, string>> = {
  guide: "Guide",
  concept: "Concept",
  reference: "Reference",
  error: "Error code",
};

export const SEARCH_INDEX_URL = "/docs/search-index.json";
/** Dispatch on window, with an optional `detail.query`, to open the search dialog. */
export const SEARCH_EVENT = "probarion:docs-search";

/**
 * One entry of the index: a page, or one vault error code. Every field is a string, so the JSON
 * stays flat.
 */
export interface SearchDoc {
  id: string;
  href: string;
  title: string;
  section: string;
  kind: SearchKind;
  /** The page's H2 and H3 texts, one per line. */
  headings: string;
  /** Error codes and CLI commands the entry names, one per line: a command keeps its spaces. */
  codes: string;
  body: string;
  summary: string;
}

const FIELDS = [
  "id",
  "href",
  "title",
  "section",
  "kind",
  "headings",
  "codes",
  "body",
  "summary",
] as const;

/**
 * The index as the server wrote it. Throws on anything else, so a bad file shows the error state.
 */
export function parseIndex(value: unknown): SearchDoc[] {
  if (!Array.isArray(value)) throw new Error("search index: not a list");
  // MiniSearch throws on a repeated id, so the index refuses one here, where the error state shows.
  const seen = new Set<string>();
  return value.map((entry: unknown, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`search index: entry ${i} is not an object`);
    }
    const e = entry as Record<string, unknown>;
    for (const f of FIELDS) {
      if (typeof e[f] !== "string") throw new Error(`search index: entry ${i} has no ${f}`);
    }
    if (!(SEARCH_KINDS as readonly string[]).includes(e.kind as string)) {
      throw new Error(`search index: entry ${i} has kind "${String(e.kind)}"`);
    }
    const id = e.id as string;
    if (seen.has(id)) throw new Error(`search index: entry ${i} repeats id ${id}`);
    seen.add(id);
    return Object.fromEntries(FIELDS.map((f) => [f, e[f]])) as unknown as SearchDoc;
  });
}

/** A request that aborts when it has no answer in 10 s, so the dialog shows Try again. */
const timedFetch = (url: string) => fetch(url, { signal: AbortSignal.timeout(10_000) });

/**
 * The index, or null when it does not load (an HTTP error, no network, no answer in 10 s, bad JSON,
 * a bad entry). The reason goes to the console.
 */
export async function loadIndex(
  fetcher: (url: string) => Promise<Response> = timedFetch,
): Promise<SearchDoc[] | null> {
  try {
    const res = await fetcher(SEARCH_INDEX_URL);
    if (!res.ok) throw new Error(`search index: HTTP ${res.status}`);
    return parseIndex(await res.json());
  } catch (error) {
    console.error("Docs search: the index did not load.", error);
    return null;
  }
}

/** How many results the dialog lists. */
export const RESULT_LIMIT = 20;

/**
 * `probarion:` right before a code. Every vault code carries it, so the index and the query drop
 * it: the word "probarion" then finds the pages about Probarion, not every error entry.
 */
const PREFIX = /\bprobarion:(?=\w)/gi;
const unprefixed = (s: string) => s.replace(PREFIX, "");

/** Each engine's error entries, by code key: a pasted `PROBARION:<Code>` puts its entry first. */
const ERROR_IDS = new WeakMap<MiniSearch<SearchDoc>, ReadonlyMap<string, string>>();

export function createSearch(docs: readonly SearchDoc[]): MiniSearch<SearchDoc> {
  const ms = new MiniSearch<SearchDoc>({
    // titleTerms and codeTerms index the title and the codes without the prefix. The stored title
    // and codes keep it: extractField reads the stored fields too.
    fields: ["titleTerms", "headings", "codeTerms", "body"],
    storeFields: ["href", "title", "section", "kind", "summary", "codes"],
    extractField: (doc, field) => {
      if (field === "titleTerms") return unprefixed(doc.title);
      if (field === "codeTerms") return unprefixed(doc.codes);
      return doc[field as keyof SearchDoc];
    },
    searchOptions: {
      boost: { titleTerms: 4, headings: 2.5, codeTerms: 2 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
  ms.addAll(docs);
  const ids = new Map<string, string>();
  for (const d of docs) {
    if (d.kind !== "error") continue;
    for (const code of d.codes.split("\n")) if (code !== "") ids.set(codeKey(code), d.id);
  }
  ERROR_IDS.set(ms, ids);
  return ms;
}

export interface SearchHit {
  id: string;
  href: string;
  title: string;
  section: string;
  kind: SearchKind;
  summary: string;
  codes: string;
  /** The index terms that matched, lower case. */
  terms: string[];
}

function toHit(r: SearchResult): SearchHit {
  return {
    id: String(r.id),
    href: r.href,
    title: r.title,
    section: r.section,
    kind: r.kind,
    summary: r.summary,
    codes: r.codes,
    terms: r.terms,
  };
}

/**
 * A code or a query as the exact rank compares them: one space between words, lower case, and no
 * `probarion:` in front, so NoMandate and PROBARION:NoMandate are the same code.
 */
const codeKey = (s: string) =>
  s
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/^probarion:/, "");

/**
 * 0: the error entry whose code is the query; 1: a reference page that names that code, such as
 * the CLI reference for `spend approve`; 2: another page that names it; 3: the rest. A code is a
 * whole line of `codes`, so one word of a CLI command is not the command. An empty key (the query
 * `PROBARION:` alone) and an empty line (a page with no codes) never match.
 */
function exactRank(hit: SearchHit, key: string): number {
  if (key === "") return 3;
  const codes = hit.codes.split("\n").filter((c) => c !== "");
  if (!codes.some((c) => codeKey(c) === key)) return 3;
  if (hit.kind === "error") return 0;
  return hit.kind === "reference" ? 1 : 2;
}

/**
 * The error entry of the first `PROBARION:<Code>` in the query whose code the index holds, when the
 * filter shows errors. A pasted refusal names its code that way.
 */
function pastedError(
  ms: MiniSearch<SearchDoc>,
  query: string,
  filter: SearchFilter,
): SearchHit | null {
  if (filter !== "all" && filter !== "error") return null;
  const ids = ERROR_IDS.get(ms);
  for (const m of query.matchAll(/\bprobarion:(\w+)/gi)) {
    const code = (m[1] ?? "").toLowerCase();
    const id = ids?.get(code);
    const stored = id === undefined ? undefined : ms.getStoredFields(id);
    if (id === undefined || stored === undefined) continue;
    const fields = stored as Pick<
      SearchHit,
      "href" | "title" | "section" | "kind" | "summary" | "codes"
    >;
    return { id, ...fields, terms: [code] };
  }
  return null;
}

/**
 * Every word must match; when nothing does, any word may. A query that is exactly a code puts its
 * entry first, and so does a query that holds `PROBARION:<Code>`, such as a pasted refusal.
 */
export function runSearch(
  ms: MiniSearch<SearchDoc>,
  query: string,
  filter: SearchFilter = "all",
  limit = RESULT_LIMIT,
): SearchHit[] {
  const q = query.trim();
  if (q === "") return [];
  const only = filter === "all" ? {} : { filter: (r: SearchResult) => r.kind === filter };
  // The index holds no `probarion:` before a code, so the query drops it too.
  const words = unprefixed(q);
  let results = ms.search(words, { ...only, combineWith: "AND" });
  if (results.length === 0) results = ms.search(words, { ...only, combineWith: "OR" });
  const key = codeKey(q);
  const hits = results
    .map(toHit)
    .map((hit, i) => ({ hit, i, rank: exactRank(hit, key) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ hit }) => hit);
  const pasted = pastedError(ms, q, filter);
  if (pasted === null) return hits.slice(0, limit);
  const own = hits.find((h) => h.id === pasted.id) ?? pasted;
  return [own, ...hits.filter((h) => h.id !== pasted.id)].slice(0, limit);
}

export interface HitGroup {
  section: string;
  hits: SearchHit[];
}

/**
 * Hits grouped by section. A group comes where its best hit ranks, so the first option is the best
 * hit.
 */
export function groupHits(hits: readonly SearchHit[]): HitGroup[] {
  const groups = new Map<string, SearchHit[]>();
  for (const hit of hits) groups.set(hit.section, [...(groups.get(hit.section) ?? []), hit]);
  return [...groups].map(([section, list]) => ({ section, hits: list }));
}

export interface Segment {
  text: string;
  mark: boolean;
  /** Where the segment starts in the text: a stable React key. */
  at: number;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text cut into marked and plain segments, matching the terms whatever their case. */
export function highlight(text: string, terms: readonly string[]): Segment[] {
  const words = [...new Set(terms.filter((t) => t.length > 1))].sort((a, b) => b.length - a.length);
  if (words.length === 0 || text === "") return [{ text, mark: false, at: 0 }];
  const out: Segment[] = [];
  let at = 0;
  for (const m of text.matchAll(new RegExp(words.map(escapeRegExp).join("|"), "gi"))) {
    const start = m.index ?? 0;
    if (start > at) out.push({ text: text.slice(at, start), mark: false, at });
    out.push({ text: m[0], mark: true, at: start });
    at = start + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false, at });
  return out;
}

/** The next active option, wrapping round; -1 when there is none. */
export function moveActive(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  return (((current + delta) % count) + count) % count;
}

/** The active option kept on the list, whatever was stored (-1 after a move with no results). */
export function activeIndex(active: number, count: number): number {
  return count === 0 ? -1 : Math.min(Math.max(active, 0), count - 1);
}

/**
 * An option's element id, from its entry's id, so aria-activedescendant changes with the top hit.
 * encodeURIComponent leaves no space, so it is a valid HTML id.
 */
export function optionId(base: string, id: string): string {
  return `${base}-opt-${encodeURIComponent(id)}`;
}

/**
 * What the live region says, and the empty view shows, once a query has run. `more` says that the
 * list stops at its limit and the search found more.
 */
export function resultsMessage(count: number, query: string, more = false): string {
  const q = `"${query}"`;
  if (count === 0) return `No results for ${q}.`;
  if (more) return `Top ${count} results for ${q}`;
  return count === 1 ? `1 result for ${q}` : `${count} results for ${q}`;
}

/**
 * Where an opened result lands, once the address bar shows its page: the id its hash names, or a
 * null id for the page's h1. Null while another page shows.
 */
export function landingTarget(
  here: { pathname: string; href: string },
  href: string,
): { id: string | null } | null {
  const to = new URL(href, here.href);
  if (to.pathname !== here.pathname) return null;
  const hash = to.hash.slice(1);
  if (hash === "") return { id: null };
  try {
    return { id: decodeURIComponent(hash) };
  } catch {
    return { id: hash };
  }
}

/** The keys of a keydown that may open the search; `key` is missing on some synthetic events. */
export interface ShortcutKeys {
  key?: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Ctrl K or ⌘K, with no other modifier (Ctrl and ⌘ together do not count). The physical K key
 * counts only when the key is not a Latin letter, so a Cyrillic layout opens the search while
 * Colemak's e on that key stays Ctrl E.
 */
export function isSearchShortcut(e: ShortcutKeys): boolean {
  if (e.shiftKey || e.altKey || e.ctrlKey === e.metaKey) return false;
  const k = (e.key ?? "").toLowerCase();
  return k === "k" || (e.code === "KeyK" && !/^[a-z]$/.test(k));
}
