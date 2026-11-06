export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export const REQUEST_ID_HEADER = "x-request-id";

/** Field names whose values never reach a log line (matched anywhere in the name, any case). */
const SECRET_KEY =
  /secret|token|password|passphrase|mnemonic|seed|authorization|bearer|cookie|api_?key|private|service_?role|jwt|heartbeat|rpc_?urls?|dsn|(agent|ledger|signing)_?key$/i;
/** A hash of a secret is not the secret (`token_hash`), except a password hash. */
const HASH_KEY = /hash$/i;
const PASSWORD_KEY = /password/i;
/** Usage counters (`token_count`, `tokens_in`, `prompt_tokens`) are numbers, not credentials. */
const COUNTER_KEY = /(^|_)tokens(_|$)|^token_(count|total|usage|limit|budget)$/i;

const MAX_DEPTH = 4;
const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";

function isSecretKey(key: string, value: unknown): boolean {
  // A secret is text or a number. A flag or an absent value (`heartbeat: true`) is not one.
  if (value === null || value === undefined || typeof value === "boolean") return false;
  if (!SECRET_KEY.test(key)) return false;
  if (HASH_KEY.test(key) && !PASSWORD_KEY.test(key)) return false;
  if (COUNTER_KEY.test(key) && (typeof value === "number" || typeof value === "bigint")) {
    return false;
  }
  return true;
}

const TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  // A NEAR secret key is base58 of 64 bytes (about 88 characters); a public key is about 44.
  [/\bed25519:[1-9A-HJ-NP-Za-km-z]{60,}/g, `ed25519:${REDACTED}`],
  [/(\bhttps?:\/\/)[^\s/@"']+@/gi, `$1${REDACTED}@`],
  [/([?&][a-z_]*(?:key|token|secret|sig|auth)[a-z_]*=)[^&\s"']+/gi, `$1${REDACTED}`],
  // A Telegram bot token (<bot id>:<35 characters>), which its API puts in the URL path.
  [/(?<!\d)\d{6,}:[A-Za-z0-9_-]{30,}/g, REDACTED],
];

/**
 * Environment variables that hold a secret, or a URL that may carry one (an RPC key, a token in a
 * path). A fixed list, not a name pattern: a pattern also masks harmless variables such as
 * `__NEXT_PRIVATE_ORIGIN`. The names are the secret ones in `Env` plus the other IF §14 and
 * rotation-runbook names; log.test.ts checks that every non-public `Env` variable is listed.
 */
export const SECRET_ENV_NAMES = [
  "NEARAI_API_KEY",
  "ONECLICK_JWT",
  "SUPABASE_SERVICE_ROLE_KEY",
  "KEY_ENCRYPTION_SECRET",
  "SENTRY_DSN",
  "TELEGRAM_BOT_TOKEN",
  "RESEND_API_KEY",
  "CRON_SECRET",
  "BETTERSTACK_HEARTBEAT_URL",
  "NEAR_RPC_URLS",
  "NEAR_RPC_URLS_MAINNET",
  "NEAR_RPC_URLS_TESTNET",
  "NEAR_ARCHIVAL_RPC_URLS",
  "NEAR_ARCHIVAL_RPC_URLS_MAINNET",
  "NEAR_ARCHIVAL_RPC_URLS_TESTNET",
  "BASE_RPC_URL",
  "PROBARION_AGENT_KEY",
  "PROBARION_LEDGER_KEY",
  "OLD_KEY_ENCRYPTION_SECRET",
  "NEW_KEY_ENCRYPTION_SECRET",
] as const;

/**
 * The current values of those variables (a comma list gives one value per entry), longest first,
 * so text that quotes one can be masked. Read once per log line.
 */
export function secretEnvValues(): string[] {
  if (typeof process === "undefined") return [];
  const out: string[] = [];
  for (const name of SECRET_ENV_NAMES) {
    for (const part of (process.env[name] ?? "").split(",")) {
      const value = part.trim();
      if (value.length >= 8) out.push(value);
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Free text (a message, an error string) cannot be judged by key, so known secrets and shapes go. */
export function scrubText(text: string, secrets: readonly string[] = secretEnvValues()): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  for (const [pattern, replacement] of TEXT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function redactValue(value: unknown, depth: number, secrets: readonly string[]): unknown {
  if (typeof value === "string") return scrubText(value, secrets);
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (value instanceof Error) {
    return { name: value.name, message: scrubText(value.message, secrets) };
  }
  if (value instanceof URL) return value.origin;
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, secrets));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    // Buffers, Maps, class instances: their contents cannot be vetted, so only the type is logged.
    return `[${(value as object).constructor?.name ?? "Object"}]`;
  }
  return redactFields(value as LogFields, depth + 1, secrets);
}

function redactFields(fields: LogFields, depth: number, secrets: readonly string[]): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = isSecretKey(k, v) ? REDACTED : redactValue(v, depth, secrets);
  }
  return out;
}

export function redact(
  fields: LogFields,
  secrets: readonly string[] = secretEnvValues(),
): LogFields {
  return redactFields(fields, 0, secrets);
}

const replacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

/** One JSON line. It never throws: fields that cannot be serialised give a fallback line. */
export function formatLog(
  level: LogLevel,
  msg: string,
  fields: LogFields = {},
  now: Date = new Date(),
): string {
  const at = Number.isNaN(now.getTime()) ? "invalid-date" : now.toISOString();
  try {
    const secrets = secretEnvValues();
    // Fields first, so a field named level, msg or at cannot replace the real one.
    return JSON.stringify(
      { ...redact(fields, secrets), level, msg: scrubText(String(msg), secrets), at },
      replacer,
    );
  } catch {
    return JSON.stringify({ level, msg: "log.fields_unserialisable", at });
  }
}

export const log = {
  debug: (msg: string, f: LogFields = {}) => console.debug(formatLog("debug", msg, f)),
  info: (msg: string, f: LogFields = {}) => console.log(formatLog("info", msg, f)),
  warn: (msg: string, f: LogFields = {}) => console.warn(formatLog("warn", msg, f)),
  error: (msg: string, f: LogFields = {}) => console.error(formatLog("error", msg, f)),
};

export function newRequestId(): string {
  return crypto.randomUUID();
}
