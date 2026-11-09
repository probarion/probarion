/**
 * Where a visitor came to the Canary from, as named by a link of ours (`/canary?via=x`), and stored with each attempt
 * (site audit P1-17). A closed set: one fixed word per kind of link, never free text, no cookie and no other request
 * data. The database accepts any short lowercase word (migration 0014), so a new source is a change here only. The
 * site's own menu links carry none: moving around the site is not a source.
 */
export const CANARY_VIA = [
  "home",
  "x",
  "share",
  "readme",
  "proof",
  "tamper",
  "ext",
  "usage",
] as const;

export type CanaryVia = (typeof CANARY_VIA)[number];

const KNOWN: ReadonlySet<string> = new Set(CANARY_VIA);

/** The source a link named, or null for anything that is not exactly one of the set: an attempt never fails for it. */
export function parseVia(value: unknown): CanaryVia | null {
  return typeof value === "string" && KNOWN.has(value) ? (value as CanaryVia) : null;
}

/** A link between the Canary's own pages that keeps the source, so a visitor who reads the rules first still counts. */
export function withVia(path: "/canary" | "/canary/rules", via: CanaryVia | null): string {
  return via === null ? path : `${path}?via=${via}`;
}
