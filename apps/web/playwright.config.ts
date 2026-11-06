import { readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// The built site, served locally on one port with test settings only. Local only: no CI job runs it.
const PORT = 3100;
const ORIGIN = `http://localhost:${PORT}`;

/**
 * Every setting the app knows (the names in .env.example), set to empty. Next.js does not load a value from a local
 * .env file over a variable that is already set, even an empty one (@next/env checks `typeof === "undefined"`), so
 * those names, and the Sentry and Vercel build names that TEST_SETTINGS blanks, take only the values below. Any other
 * name in a local .env file still loads.
 */
function blankSettings(): Record<string, string> {
  const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  const out: Record<string, string> = {};
  for (const m of example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) out[m[1] ?? ""] = "";
  delete out[""];
  return out;
}

/** PATH and the rest of the parent environment, strings only. */
function inherited(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (typeof value === "string") out[name] = value;
  return out;
}

/** Test values that loadEnv accepts. No real service is reachable at these addresses. */
const TEST_SETTINGS: Record<string, string> = {
  NEAR_NETWORK: "testnet",
  SUPABASE_URL: "https://example.invalid",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "e2e-not-a-key",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-not-a-key",
  // The bytes 0 to 31: fixed and obviously a test value (loadEnv refuses one repeated byte).
  KEY_ENCRYPTION_SECRET: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64"),
  CRON_SECRET: "e2e-".repeat(8),
  CANARY_MODE: "replay",
  NEAR_RPC_URLS_TESTNET: "https://rpc.example.invalid",
  // Read by the Sentry build plugin and by the origin fallback, and not in .env.example (R14): blanked here so a
  // developer's .env.local or shell can never make the local build upload source maps or change the default origin.
  SENTRY_AUTH_TOKEN: "",
  SENTRY_ORG: "",
  SENTRY_PROJECT: "",
  VERCEL_PROJECT_PRODUCTION_URL: "",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: ORIGIN },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm build && pnpm start -p ${PORT}`,
    url: `${ORIGIN}/api/health`,
    reuseExistingServer: false,
    timeout: 600_000,
    env: { ...inherited(), ...blankSettings(), ...TEST_SETTINGS },
  },
});
