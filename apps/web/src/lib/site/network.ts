// Which network a request is for, decided by the address it was opened at (W-NET-R2). This module has no runtime
// import and reads no settings of its own, so the server (lib/network.ts), the browser (the header's network switch,
// the beta strip) and next.config.ts all use the same rule: one function, one set of tests.
import type { Network } from "@/lib/config";

/** The two networks, mainnet first: the order a cron run, a list and a switch use. */
export const NETWORK_ORDER: readonly Network[] = ["mainnet", "testnet"];

export function isNetwork(value: unknown): value is Network {
  return value === "mainnet" || value === "testnet";
}

export function otherNetworkOf(network: Network): Network {
  return network === "mainnet" ? "testnet" : "mainnet";
}

/**
 * Where this site is served, per network. An origin is `https://host` (or `http://localhost:<port>` in development).
 * `null` means the network is not served: a network is enabled when it is the default or has an origin of its own, and
 * the default network always has one (its own, else the production address).
 */
export interface NetworkRouting {
  /** The network of any address that matches no origin: a preview, a deployment URL, localhost. */
  defaultNetwork: Network;
  origins: Readonly<Record<Network, string | null>>;
}

/** The networks that are served, mainnet first. */
export function enabledNetworksOf(routing: NetworkRouting): Network[] {
  return NETWORK_ORDER.filter((n) => n === routing.defaultNetwork || routing.origins[n] !== null);
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** A loopback host name, read from a parsed URL's `hostname` (never by a string prefix). */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}

export type OriginCheck =
  | { ok: true; origin: string; host: string }
  /** `scheme`: not https (http is for loopback only). `shape`: more than a scheme and a host (and port). */
  | { ok: false; reason: "scheme" | "shape" };

/** `scheme://host[:port]`, with at most one trailing slash: no path, query, fragment or credentials. */
const ORIGIN_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\\\s@]+\/?$/i;

/**
 * Reads an origin. The result carries the normalised origin (lower case, no default port, no trailing slash) and its
 * host (with the port, when there is one), which is what a request's `Host` header is compared with.
 */
export function checkOrigin(value: string): OriginCheck {
  if (!/^https?:\/\//i.test(value)) return { ok: false, reason: "scheme" };
  if (!ORIGIN_SHAPE.test(value)) return { ok: false, reason: "shape" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "shape" };
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    return { ok: false, reason: "scheme" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "scheme" };
  // A fully qualified name ends in a dot, and a Host header is compared without it (normalizeHost): the origin is
  // stored without it too, so "x.example." and "x.example" are one address (and one host for the same-host check).
  const hostname = url.hostname.replace(/\.$/, "");
  if (hostname.endsWith(".") || hostname.includes("..")) return { ok: false, reason: "shape" };
  const host = url.port === "" ? hostname : `${hostname}:${url.port}`;
  return { ok: true, origin: `${url.protocol}//${host}`, host };
}

/** The host of a normalised origin, or null. */
export function originHost(origin: string | null): string | null {
  if (origin === null) return null;
  const r = checkOrigin(origin);
  return r.ok ? r.host : null;
}

/**
 * The host a request was made for, the one source for both the CSRF check (`assertSameOrigin`) and the network of the
 * request (`requestNetwork`), so the two cannot read different hosts: the first `X-Forwarded-Host` value when the header
 * is there (behind a proxy chain it is a comma list, and the first hop is the one the client asked for), else `Host`, else
 * the host of `url` when the caller has the request's URL. Trimmed and lower case, with the port. Null when none of them
 * gives a host. On Vercel the platform sets both headers.
 */
export function requestHost(
  headers: { get(name: string): string | null },
  url?: string,
): string | null {
  const raw =
    headers.get("x-forwarded-host") ??
    headers.get("host") ??
    (url === undefined ? null : hostOfUrl(url));
  const first = (raw?.split(",")[0] ?? "").trim().toLowerCase();
  return first === "" ? null : first;
}

function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** A `Host` header as it is compared: trimmed, lower case, without the dot that ends a fully qualified name. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.(?=(?::\d+)?$)/, "");
}

/**
 * The network a request is for. A host equal to an enabled network's origin host is that network; anything else is
 * the default network. Only the host decides: never a query parameter, a cookie or a header the visitor can set to
 * reach the other network's settings.
 */
export function networkForHost(host: string | null | undefined, routing: NetworkRouting): Network {
  const h = normalizeHost(host ?? "");
  if (h !== "") {
    for (const n of NETWORK_ORDER) {
      if (originHost(routing.origins[n]) === h) return n;
    }
  }
  return routing.defaultNetwork;
}

/** The production address when no origin is set for the default network (`https://$VERCEL_PROJECT_PRODUCTION_URL`). */
export function productionOrigin(src: Record<string, string | undefined>): string {
  const prod = src.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return prod ? `https://${prod}` : "http://localhost:3000";
}

/** The variables next.config.ts publishes to the browser, and the browser's routing built from them. */
export interface PublicRoutingVars {
  NEXT_PUBLIC_DEFAULT_NETWORK: string;
  NEXT_PUBLIC_ORIGIN_MAINNET: string;
  NEXT_PUBLIC_ORIGIN_TESTNET: string;
}

const present = (v: string | undefined): string | null => (v && v.trim() !== "" ? v.trim() : null);

/**
 * What next.config.ts publishes: the default network and each network's origin (empty: not served), from the same
 * settings the server reads (NEAR_NETWORK, APP_ORIGIN_MAINNET, APP_ORIGIN_TESTNET, VERCEL_PROJECT_PRODUCTION_URL).
 * A value the server would refuse is left out here; the server refuses it at its first request, with a clear message.
 */
export function publicRoutingVars(src: Record<string, string | undefined>): PublicRoutingVars {
  const defaultNetwork: Network = present(src.NEAR_NETWORK) === "mainnet" ? "mainnet" : "testnet";
  const origin = (network: Network): string => {
    const raw = present(src[network === "mainnet" ? "APP_ORIGIN_MAINNET" : "APP_ORIGIN_TESTNET"]);
    const checked = raw === null ? null : checkOrigin(raw);
    if (checked?.ok) return checked.origin;
    if (network !== defaultNetwork) return "";
    const fallback = checkOrigin(productionOrigin(src));
    return fallback.ok ? fallback.origin : "";
  };
  return {
    NEXT_PUBLIC_DEFAULT_NETWORK: defaultNetwork,
    NEXT_PUBLIC_ORIGIN_MAINNET: origin("mainnet"),
    NEXT_PUBLIC_ORIGIN_TESTNET: origin("testnet"),
  };
}

/** The routing the published variables describe. An unset or unreadable value is "not served". */
export function routingFromPublicVars(
  v: Partial<Record<keyof PublicRoutingVars, string | undefined>>,
): NetworkRouting {
  const read = (raw: string | undefined): string | null => {
    const value = present(raw);
    const checked = value === null ? null : checkOrigin(value);
    return checked?.ok ? checked.origin : null;
  };
  return {
    defaultNetwork: v.NEXT_PUBLIC_DEFAULT_NETWORK === "mainnet" ? "mainnet" : "testnet",
    origins: {
      mainnet: read(v.NEXT_PUBLIC_ORIGIN_MAINNET),
      testnet: read(v.NEXT_PUBLIC_ORIGIN_TESTNET),
    },
  };
}

/**
 * The browser's routing. The three references are written out in full so that Next replaces each one with the value
 * next.config.ts published at build time.
 */
export function publicRouting(): NetworkRouting {
  return routingFromPublicVars({
    NEXT_PUBLIC_DEFAULT_NETWORK: process.env.NEXT_PUBLIC_DEFAULT_NETWORK,
    NEXT_PUBLIC_ORIGIN_MAINNET: process.env.NEXT_PUBLIC_ORIGIN_MAINNET,
    NEXT_PUBLIC_ORIGIN_TESTNET: process.env.NEXT_PUBLIC_ORIGIN_TESTNET,
  });
}

/**
 * The path the switch opens on the other network. A public page keeps its path. A vault page or a vault's proof has no
 * meaning there (the vault is registered on one network), so it opens the list instead, and a one-time link page opens
 * the home page. Never the query or the fragment: they can carry a one-time code.
 */
export function switchPath(pathname: string): string {
  const path = pathname.startsWith("/") ? pathname : "/";
  if (/^\/console\/.+/.test(path)) return "/console";
  if (/^\/proof\/.+/.test(path)) return "/proof";
  if (/^\/alerts(\/|$)/.test(path)) return "/";
  return path;
}

/** The two names of the pair, what the switch shows and where its other half goes. */
export interface NetworkSwitchModel {
  current: Network;
  other: Network;
  href: string;
}

/** The switch for a page at `host` and `pathname`, or null when the other network is not served. */
export function networkSwitch(
  host: string | null | undefined,
  pathname: string,
  routing: NetworkRouting,
): NetworkSwitchModel | null {
  const current = networkForHost(host, routing);
  const other = otherNetworkOf(current);
  const origin = routing.origins[other];
  if (origin === null) return null;
  return { current, other, href: `${origin}${switchPath(pathname)}` };
}
