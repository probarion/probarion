import { ConfigError } from "./errors.js";

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

/**
 * Read a list view page by page until a short page. `limit` is clamped to the contract's cap, so a
 * larger value can neither truncate the result nor stall the loop.
 */
export async function pageAll<T>(
  fetchPage: (fromIndex: number, limit: number) => Promise<T[]>,
  limit = PAGE_SIZE,
): Promise<T[]> {
  const size = clampLimit(limit);
  const out: T[] = [];
  for (let from = 0; from <= 10_000_000; from += size) {
    const page = await fetchPage(from, size);
    for (const item of page) out.push(item);
    if (page.length < size) return out;
  }
  throw new ConfigError("pagination did not terminate");
}
