import { NETWORKS } from "@probarion/core";
import type { Network } from "./config";

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
  BASE_RPC_URL: string | null;
  CRON_SECRET: string;
  CANARY_MODE: CanaryMode;
  BETTERSTACK_HEARTBEAT_URL: string | null;
}

export class EnvError extends Error {}

type Source = Record<string, string | undefined>;

const opt = (v: string | undefined): string | null =>
  v !== undefined && v.trim() !== "" ? v.trim() : null;

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

  const rpc = opt(src.NEAR_RPC_URLS)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [...NETWORKS[network].rpcUrls];
  for (const u of rpc)
    if (!u.startsWith("https://")) problems.push(`NEAR_RPC_URLS entry must be https: ${u}`);

  const master = req("KEY_ENCRYPTION_SECRET");
  if (master && Buffer.from(master, "base64").length !== 32) {
    problems.push("KEY_ENCRYPTION_SECRET must be 32 bytes encoded as base64");
  }
  const cron = req("CRON_SECRET");
  if (cron && cron.length < 32) problems.push("CRON_SECRET must be at least 32 characters");

  const mode = opt(src.CANARY_MODE) ?? "code-only";
  if (!CANARY_MODES.includes(mode as CanaryMode))
    problems.push("CANARY_MODE must be live, code-only, replay or off");
  const heartbeat = opt(src.BETTERSTACK_HEARTBEAT_URL);
  if (heartbeat && !heartbeat.startsWith("https://"))
    problems.push("BETTERSTACK_HEARTBEAT_URL must be https");

  const env: Env = {
    NEAR_NETWORK: network,
    NEAR_RPC_URLS: rpc,
    PROBARION_FACTORY_ID: opt(src.PROBARION_FACTORY_ID) ?? NETWORKS[network].factory,
    PROBARION_VAULT_ID: opt(src.PROBARION_VAULT_ID),
    NEARAI_API_KEY: opt(src.NEARAI_API_KEY),
    NEARAI_MODEL: opt(src.NEARAI_MODEL),
    ONECLICK_JWT: opt(src.ONECLICK_JWT),
    SUPABASE_URL: req("SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: req("SUPABASE_SERVICE_ROLE_KEY"),
    NEXT_PUBLIC_SUPABASE_URL: req("NEXT_PUBLIC_SUPABASE_URL"),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: req("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    KEY_ENCRYPTION_SECRET: master,
    SENTRY_DSN: opt(src.SENTRY_DSN),
    TELEGRAM_BOT_TOKEN: opt(src.TELEGRAM_BOT_TOKEN),
    RESEND_API_KEY: opt(src.RESEND_API_KEY),
    CANARY_VAULT_ID: opt(src.CANARY_VAULT_ID),
    BASE_RPC_URL: opt(src.BASE_RPC_URL),
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
