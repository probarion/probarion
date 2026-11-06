import "server-only";
import { NETWORKS } from "@probarion/core";
import { appOrigin, type Network } from "./config";
import { isNearAccountId } from "./near/validate";
import { checkOrigin, isLoopbackHostname, NETWORK_ORDER } from "./site/network";

export type CanaryMode = "live" | "code-only" | "replay" | "off";
const CANARY_MODES: readonly CanaryMode[] = ["live", "code-only", "replay", "off"];

/**
 * What one network needs (W-NET-R1). Both networks' settings are always computed: a tenant on a network this site does
 * not serve can still be listed, and its settings name where it lives.
 */
export interface NetworkSettings {
  /** The default network, or one whose APP_ORIGIN_<NET> is set. */
  enabled: boolean;
  /**
   * Where this network is served (`https://host`): its APP_ORIGIN_<NET>, else, for the default network, the
   * production address. Null: not served.
   */
  origin: string | null;
  rpcUrls: string[];
  /** /proof's burn lookups for txs older than about 2.5 days. Empty (unset) means no archival lookup (R5). */
  archivalRpcUrls: string[];
  factoryId: string;
  /** The demo vault /proof shows by default. */
  demoVaultId: string | null;
  canaryVaultId: string | null;
  /** R11: vaults the team runs. Registering one gives the tenant kind "team" (else "external"). */
  teamVaultIds: string[];
}

export interface Env {
  /**
   * NEAR_NETWORK: the network of any address that matches neither origin (a preview, a deployment URL, localhost) and
   * the one whose unsuffixed settings apply. An unsuffixed variable never applies to the other network.
   */
  defaultNetwork: Network;
  /** The networks this site serves, mainnet first. */
  enabledNetworks: readonly Network[];
  networks: Record<Network, NetworkSettings>;
  NEARAI_API_KEY: string | null;
  NEARAI_MODEL: string | null;
  /** 1Click is mainnet only (there is no testnet), so this one key serves the whole site. */
  ONECLICK_JWT: string | null;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
  KEY_ENCRYPTION_SECRET: string;
  SENTRY_DSN: string | null;
  TELEGRAM_BOT_TOKEN: string | null;
  RESEND_API_KEY: string | null;
  BASE_RPC_URL: string | null;
  CRON_SECRET: string;
  CANARY_MODE: CanaryMode;
  BETTERSTACK_HEARTBEAT_URL: string | null;
}

/** Messages name the variable (and an entry's position), never its value. */
export class EnvError extends Error {}

type Source = Record<string, string | undefined>;

/** R12: an empty or whitespace-only value counts as unset. */
const opt = (v: string | undefined): string | null =>
  v !== undefined && v.trim() !== "" ? v.trim() : null;

/** A comma list: entries trimmed, empty ones dropped. Unset, blank or only commas is an empty list (R12). */
const list = (v: string | undefined): string[] =>
  (opt(v) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** A comma list that names at least one entry, else null (a list of only commas is unset, R12). */
const entries = (v: string | undefined): string[] | null => {
  const l = list(v);
  return l.length > 0 ? l : null;
};

/**
 * Parses an http(s) service URL. The scheme must be followed by "//" and a host, so "https:foo",
 * "https:/foo" and "https:///foo" (which `new URL` would read as https://foo/) are refused.
 */
function parseServiceUrl(value: string): URL | null {
  if (!/^https?:\/\/[^/?#\\\s]/i.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Strict https, for the URLs that carry a secret to a third party (the Sentry DSN, the heartbeat). */
function isHttps(value: string): boolean {
  return parseServiceUrl(value)?.protocol === "https:";
}

/**
 * https, or http for a local development service. The host is read from the parsed URL, never by
 * a string prefix: http://localhost.evil.com and http://localhost@evil.com are refused.
 */
export function isAllowedServiceUrl(value: string): boolean {
  const url = parseServiceUrl(value);
  if (url === null) return false;
  if (url.protocol === "https:") return true;
  return isLoopbackHostname(url.hostname);
}

const HTTPS_OR_LOCAL = "must be https (http only for localhost)";

/** 32 bytes as standard base64 is 43 characters and one "=". */
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

function masterKeyProblem(value: string): string | null {
  if (!BASE64_32_BYTES.test(value))
    return "KEY_ENCRYPTION_SECRET must be 32 bytes encoded as base64";
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value) {
    return "KEY_ENCRYPTION_SECRET must be 32 bytes encoded as base64";
  }
  if (bytes.every((b) => b === bytes[0])) {
    return "KEY_ENCRYPTION_SECRET must not be one repeated byte";
  }
  return null;
}

/**
 * The settings that exist once per network. `<NAME>_MAINNET` and `<NAME>_TESTNET` are the per-network forms; the bare
 * `<NAME>` is the default network's (`NEAR_NETWORK`).
 */
export const PER_NETWORK_ENV_NAMES = [
  "NEAR_RPC_URLS",
  "NEAR_ARCHIVAL_RPC_URLS",
  "PROBARION_FACTORY_ID",
  "PROBARION_VAULT_ID",
  "CANARY_VAULT_ID",
  "TEAM_VAULT_IDS",
] as const;

const SUFFIX: Record<Network, string> = { mainnet: "MAINNET", testnet: "TESTNET" };

/**
 * One per-network setting, in this order: `<NAME>_<NET>`; for the default network only, the bare `<NAME>`; else
 * nothing (the caller's built-in default). The bare name never applies to the other network: testnet RPCs must never
 * serve mainnet. `name` is the variable that supplied the value, for the message about a refused entry.
 */
function perNetwork<T>(
  src: Source,
  base: (typeof PER_NETWORK_ENV_NAMES)[number],
  network: Network,
  defaultNetwork: Network,
  read: (raw: string | undefined) => T | null,
): { name: string; value: T } | null {
  const suffixed = `${base}_${SUFFIX[network]}`;
  const own = read(src[suffixed]);
  if (own !== null) return { name: suffixed, value: own };
  if (network !== defaultNetwork) return null;
  const bare = read(src[base]);
  return bare === null ? null : { name: base, value: bare };
}

type FoundOrigin = { origin: string; host: string } | null;

/**
 * APP_ORIGIN_<NET>: where each network is served. The default network falls back to the production address. Refused,
 * with the variable named and never its value: a value that is not an origin (a path, a query, a fragment, a scheme
 * other than https, http for anything but localhost), and two networks on one host.
 */
function originsOf(
  src: Source,
  defaultNetwork: Network,
  problems: string[],
): Record<Network, FoundOrigin> {
  const found: Record<Network, FoundOrigin> = { mainnet: null, testnet: null };
  for (const network of NETWORK_ORDER) {
    const name = `APP_ORIGIN_${SUFFIX[network]}`;
    const raw = opt(src[name]);
    if (raw === null) continue;
    const checked = checkOrigin(raw);
    if (checked.ok) found[network] = { origin: checked.origin, host: checked.host };
    else if (checked.reason === "scheme")
      problems.push(`${name} must be https (http only for localhost)`);
    else
      problems.push(
        `${name} must be an origin: a scheme and a host, with no path, query or fragment`,
      );
  }
  if (found[defaultNetwork] === null) {
    // The production address stands in for the default network's origin (the same fallback appOrigin() gives).
    const fallback = checkOrigin(appOrigin(src));
    if (fallback.ok) found[defaultNetwork] = { origin: fallback.origin, host: fallback.host };
  }
  const { mainnet, testnet } = found;
  if (mainnet !== null && testnet !== null && mainnet.host === testnet.host) {
    const other = defaultNetwork === "mainnet" ? "testnet" : "mainnet";
    problems.push(
      `APP_ORIGIN_${SUFFIX[other]} must not have the same host as the ${defaultNetwork} address (APP_ORIGIN_${SUFFIX[defaultNetwork]} or the production address)`,
    );
  }
  return found;
}

function settingsOf(
  src: Source,
  network: Network,
  defaultNetwork: Network,
  origin: FoundOrigin,
  problems: string[],
): NetworkSettings {
  const rpc = perNetwork(src, "NEAR_RPC_URLS", network, defaultNetwork, entries);
  rpc?.value.forEach((u, i) => {
    if (!isAllowedServiceUrl(u)) problems.push(`${rpc.name} entry ${i + 1} ${HTTPS_OR_LOCAL}`);
  });
  // No network default here: unset (or only commas) means /proof makes no archival lookup.
  const archival = perNetwork(src, "NEAR_ARCHIVAL_RPC_URLS", network, defaultNetwork, entries);
  archival?.value.forEach((u, i) => {
    if (!isAllowedServiceUrl(u)) problems.push(`${archival.name} entry ${i + 1} ${HTTPS_OR_LOCAL}`);
  });
  const team = perNetwork(src, "TEAM_VAULT_IDS", network, defaultNetwork, entries);
  team?.value.forEach((id, i) => {
    if (!isNearAccountId(id)) problems.push(`${team.name} entry ${i + 1} is not a NEAR account id`);
  });
  return {
    enabled: network === defaultNetwork || origin !== null,
    origin: origin?.origin ?? null,
    // A list with no entries (for example ",") is unset, so the network default applies.
    rpcUrls: rpc?.value ?? [...NETWORKS[network].rpcUrls],
    archivalRpcUrls: archival?.value ?? [],
    factoryId:
      perNetwork(src, "PROBARION_FACTORY_ID", network, defaultNetwork, opt)?.value ??
      NETWORKS[network].factory,
    demoVaultId: perNetwork(src, "PROBARION_VAULT_ID", network, defaultNetwork, opt)?.value ?? null,
    canaryVaultId: perNetwork(src, "CANARY_VAULT_ID", network, defaultNetwork, opt)?.value ?? null,
    teamVaultIds: team?.value ?? [],
  };
}

export function loadEnv(src: Source): Env {
  const problems: string[] = [];
  const req = (name: string): string => {
    const v = opt(src[name]);
    if (v === null) problems.push(`${name} is required`);
    return v ?? "";
  };

  const rawNetwork = opt(src.NEAR_NETWORK) ?? "testnet";
  if (rawNetwork !== "mainnet" && rawNetwork !== "testnet")
    problems.push("NEAR_NETWORK must be mainnet or testnet");
  const defaultNetwork: Network = rawNetwork === "mainnet" ? "mainnet" : "testnet";

  const origins = originsOf(src, defaultNetwork, problems);
  const networks: Record<Network, NetworkSettings> = {
    mainnet: settingsOf(src, "mainnet", defaultNetwork, origins.mainnet, problems),
    testnet: settingsOf(src, "testnet", defaultNetwork, origins.testnet, problems),
  };

  const master = req("KEY_ENCRYPTION_SECRET");
  const masterProblem = master ? masterKeyProblem(master) : null;
  if (masterProblem) problems.push(masterProblem);
  const cron = req("CRON_SECRET");
  if (cron && cron.length < 32) problems.push("CRON_SECRET must be at least 32 characters");

  const mode = opt(src.CANARY_MODE) ?? "code-only";
  if (!CANARY_MODES.includes(mode as CanaryMode))
    problems.push("CANARY_MODE must be live, code-only, replay or off");
  const heartbeat = opt(src.BETTERSTACK_HEARTBEAT_URL);
  if (heartbeat && !isHttps(heartbeat)) problems.push("BETTERSTACK_HEARTBEAT_URL must be https");
  const supabaseUrl = req("SUPABASE_URL");
  if (supabaseUrl && !isAllowedServiceUrl(supabaseUrl))
    problems.push(`SUPABASE_URL ${HTTPS_OR_LOCAL}`);
  const publicSupabaseUrl = req("NEXT_PUBLIC_SUPABASE_URL");
  if (publicSupabaseUrl && !isAllowedServiceUrl(publicSupabaseUrl))
    problems.push(`NEXT_PUBLIC_SUPABASE_URL ${HTTPS_OR_LOCAL}`);
  const baseRpc = opt(src.BASE_RPC_URL);
  if (baseRpc && !isAllowedServiceUrl(baseRpc)) problems.push(`BASE_RPC_URL ${HTTPS_OR_LOCAL}`);
  const sentryDsn = opt(src.SENTRY_DSN);
  if (sentryDsn && !isHttps(sentryDsn)) problems.push("SENTRY_DSN must be https");

  const env: Env = {
    defaultNetwork,
    enabledNetworks: NETWORK_ORDER.filter((n) => networks[n].enabled),
    networks,
    NEARAI_API_KEY: opt(src.NEARAI_API_KEY),
    NEARAI_MODEL: opt(src.NEARAI_MODEL),
    ONECLICK_JWT: opt(src.ONECLICK_JWT),
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: req("SUPABASE_SERVICE_ROLE_KEY"),
    NEXT_PUBLIC_SUPABASE_URL: publicSupabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: req("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    KEY_ENCRYPTION_SECRET: master,
    SENTRY_DSN: sentryDsn,
    TELEGRAM_BOT_TOKEN: opt(src.TELEGRAM_BOT_TOKEN),
    RESEND_API_KEY: opt(src.RESEND_API_KEY),
    BASE_RPC_URL: baseRpc,
    CRON_SECRET: cron,
    CANARY_MODE: mode as CanaryMode,
    BETTERSTACK_HEARTBEAT_URL: heartbeat,
  };
  if (problems.length > 0) throw new EnvError(`Invalid environment: ${problems.join("; ")}`);
  return env;
}

let cached: Env | null = null;

/** Parsed lazily so `next build` does not need runtime secrets. */
export function getEnv(): Env {
  cached ??= loadEnv(process.env);
  return cached;
}
