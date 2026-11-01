import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// interfaces §14, in table order
const REQUIRED = [
  "NEAR_NETWORK",
  "NEAR_RPC_URLS",
  "PROBARION_FACTORY_ID",
  "PROBARION_VAULT_ID",
  "PROBARION_AGENT_KEY",
  "PROBARION_LEDGER_KEY",
  "NEARAI_API_KEY",
  "NEARAI_MODEL",
  "ONECLICK_JWT",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "KEY_ENCRYPTION_SECRET",
  "SENTRY_DSN",
  "TELEGRAM_BOT_TOKEN",
  "RESEND_API_KEY",
  "CANARY_VAULT_ID",
  "BASE_RPC_URL",
  "CRON_SECRET",
  "PROBARION_LEDGER_PATH",
  "NEAR_ARCHIVAL_RPC_URLS",
  "BETTERSTACK_HEARTBEAT_URL",
  "CANARY_MODE",
];

// BETTERSTACK_HEARTBEAT_URL carries a token in its path, so it counts as a secret.
const SECRETS = [
  "PROBARION_AGENT_KEY",
  "PROBARION_LEDGER_KEY",
  "NEARAI_API_KEY",
  "ONECLICK_JWT",
  "SUPABASE_SERVICE_ROLE_KEY",
  "KEY_ENCRYPTION_SECRET",
  "SENTRY_DSN",
  "TELEGRAM_BOT_TOKEN",
  "RESEND_API_KEY",
  "CRON_SECRET",
  "BETTERSTACK_HEARTBEAT_URL",
];

const CANARY_MODES = ["live", "code-only", "replay", "off"];

function readEnvExample() {
  return readFileSync(new URL("../.env.example", import.meta.url), "utf8");
}

function parse() {
  const vars = new Map();
  for (const raw of readEnvExample().split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    vars.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return vars;
}

test(".env.example declares every variable from interfaces §14", () => {
  const vars = parse();
  for (const name of REQUIRED) assert.ok(vars.has(name), `missing ${name}`);
});

test(".env.example leaves every secret empty", () => {
  const vars = parse();
  for (const name of SECRETS) assert.equal(vars.get(name), "", `${name} must be empty`);
});

test(".env.example sets a valid CANARY_MODE", () => {
  const mode = parse().get("CANARY_MODE");
  assert.ok(CANARY_MODES.includes(mode), `CANARY_MODE must be one of ${CANARY_MODES.join("|")}`);
});

test(".env.example documents how NEARAI_MODEL resolves its default", () => {
  assert.match(readEnvExample(), /\/v1\/model\/list/);
});
