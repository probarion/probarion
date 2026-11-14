// Recorded fixtures live under test/fixtures/<area>/ (proofs, events, keys, poa), each with a `_source` field that
// says what was read, from where, when and by which script.
import { readFileSync } from "node:fs";

/** Parses `test/fixtures/<path>`, for example `readFixture("proofs/mainnet-spend-2.json")`. */
export function readFixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8")) as T;
}
