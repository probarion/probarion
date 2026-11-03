import "server-only";
import { NETWORKS } from "@probarion/core";
import type { Network } from "./config";
import { isNearAccountId } from "./near/validate";

export type CanaryMode = "live" | "code-only" | "replay" | "off";
const CANARY_MODES: readonly CanaryMode[] = ["live", "code-only", "replay", "off"];

export interface Env {
  NEAR_NETWORK: Network;
  NEAR_RPC_URLS: string[];
  PROBARION_FACTORY_ID: string;
  PROBARION_VAULT_ID: string | null; // the demo vault /proof shows by default
  NEARAI_API_KEY: string | null;
  NEARAI_MODEL: string | null;
  ONECLICK_JWT: string | null;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
  KEY_ENCRYPTION_SECRET: string;
  SENTRY_DSN: string | null;
  TELEGRAM_BOT_TOKEN: string | null;
  RESEND_API_KEY: string | null;
  CANARY_VAULT_ID: string | null;
  /** R11: vaults the team runs. Registering one gives the tenant kind "team" (else "external"). */
  TEAM_VAULT_IDS: string[];
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

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * https, or http for a local development service. The host is read from the parsed URL, never by
 * a string prefix: http://localhost.evil.com and http://localhost@evil.com are refused.
 */
export function isAllowedServiceUrl(value: string): boolean {
  const url = parseServiceUrl(value);
  if (url === null) return false;
  if (url.protocol === "https:") return true;
  return LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost");
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
  const network: Network = rawNetwork === "mainnet" ? "mainnet" : "testnet";

  // A list with no entries (for example ",") is unset, so the network default applies.
  const listed = list(src.NEAR_RPC_URLS);
  const rpc = listed.length > 0 ? listed : [...NETWORKS[network].rpcUrls];
  const teamVaults = list(src.TEAM_VAULT_IDS);
  teamVaults.forEach((id, i) => {
    if (!isNearAccountId(id))
      problems.push(`TEAM_VAULT_IDS entry ${i + 1} is not a NEAR account id`);
  });
  rpc.forEach((u, i) => {
    if (!isAllowedServiceUrl(u)) problems.push(`NEAR_RPC_URLS entry ${i + 1} ${HTTPS_OR_LOCAL}`);
  });

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
    NEAR_NETWORK: network,
    NEAR_RPC_URLS: rpc,
    PROBARION_FACTORY_ID: opt(src.PROBARION_FACTORY_ID) ?? NETWORKS[network].factory,
    PROBARION_VAULT_ID: opt(src.PROBARION_VAULT_ID),
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
    CANARY_VAULT_ID: opt(src.CANARY_VAULT_ID),
    TEAM_VAULT_IDS: teamVaults,
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
