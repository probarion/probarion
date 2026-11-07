import { type Env, loadEnv } from "@/lib/env";

// 32 distinct bytes: a key that is one repeated byte is rejected.
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256)).toString("base64");

/** The required variables, so a test builds a whole Env with `loadEnv` and names only what it is about. */
export const REQUIRED_ENV: Record<string, string> = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x",
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_x",
  KEY_ENCRYPTION_SECRET: KEY,
  CRON_SECRET: "c".repeat(40),
};

/**
 * A whole `Env` from the variables a test sets (the unsuffixed and suffixed names, as in production), on top of the
 * required ones. With no `NEAR_NETWORK` it is testnet, as in `loadEnv`. (`test/fixtures/networks.ts` builds the network
 * part by hand, for a test that replaces `@/lib/env` and so cannot call `loadEnv`.)
 */
export function envFrom(src: Record<string, string | undefined> = {}): Env {
  return loadEnv({ ...REQUIRED_ENV, ...src });
}
