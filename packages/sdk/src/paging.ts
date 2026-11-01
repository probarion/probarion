import { isDeepStrictEqual } from "node:util";
import { ConfigError, ViewError } from "./errors.js";

export const PAGE_SIZE = 50;
/** v2: list views cap `limit` at 100 (the contracts' `MAX_PAGE`); `from_index` is a 0-based position, not an id. */
export const MAX_PAGE_LIMIT = 100;

// A u64 position or id sent as a JSON number: it must be a safe, non-negative integer, or the
// contract answers with a serde error instead of a result.
export function assertU64(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConfigError(`${name} must be a non-negative integer, got ${String(value)}`);
  }
}

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit))
    throw new ConfigError(`limit must be a number, got ${String(limit)}`);
  return Math.max(1, Math.min(Math.floor(limit), MAX_PAGE_LIMIT));
}

/** A walk longer than this many pages is a stuck or hostile node, not a vault (1000 pages hold 50 000 rows at the default size). */
export const MAX_PAGES = 1000;

/** Names the view being walked, for the error a bad walk throws. */
export interface PageSource {
  contractId: string;
  methodName: string;
}

const UNKNOWN_SOURCE: PageSource = { contractId: "<unknown>", methodName: "list" };

/**
 * Read a list view page by page until a short page. `limit` is clamped to the contract's cap, so a
 * larger value can neither truncate the result nor stall the loop.
 *
 * A node that cannot be trusted must not turn this into an endless loop, so the walk throws a
 * `ViewError` when a page is longer than asked for, when a page repeats the previous one (the node
 * ignores `from_index`), or when the walk passes `MAX_PAGES` pages.
 */
export async function pageAll<T>(
  fetchPage: (fromIndex: number, limit: number) => Promise<T[]>,
  limit = PAGE_SIZE,
  source: PageSource = UNKNOWN_SOURCE,
): Promise<T[]> {
  const size = clampLimit(limit);
  const bad = (detail: string) => new ViewError(source.contractId, source.methodName, detail);
  const out: T[] = [];
  let previous: T[] = [];
  for (let n = 0; n < MAX_PAGES; n++) {
    const page = await fetchPage(n * size, size);
    if (!Array.isArray(page)) throw bad("a page is not a list");
    if (page.length > size)
      throw bad(`a page has ${page.length} rows but at most ${size} were asked for`);
    if (page.length > 0 && previous.length > 0 && repeats(previous, page)) {
      throw bad(`page ${n} repeats page ${n - 1}: the node ignores from_index`);
    }
    for (const item of page) out.push(item);
    if (page.length < size) return out;
    previous = page;
  }
  throw bad(`more than ${MAX_PAGES} pages`);
}

/** Two pages that start and end with equal rows are the same page: ids and positions never repeat. */
function repeats<T>(previous: T[], page: T[]): boolean {
  return isDeepStrictEqual(previous[0], page[0]) && isDeepStrictEqual(previous.at(-1), page.at(-1));
}
