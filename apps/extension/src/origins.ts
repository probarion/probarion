/** The Probarion origins this build trusts: the manifest's hosts, written in by scripts/build.mjs. */
export const ORIGINS: readonly string[] = __ORIGINS__;

/** What Connect offers: the trusted origins that serve Probarion now (scripts/manifest.mjs offeredFor). */
export const OFFERED: readonly string[] = __OFFERED__;

/** What Connect preselects: Probarion's canonical address. Its own address, https://probarion.vercel.app, stays offered. */
export const DEFAULT_ORIGIN = "https://probarion.xyz";

export const isKnownOrigin = (origin: unknown): origin is string =>
  typeof origin === "string" && ORIGINS.includes(origin);

export const hostOf = (origin: string): string => new URL(origin).host;
