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
];

/** The values of secret-named environment variables, so an error that quotes one is scrubbed. */
function secretEnvValues(): string[] {
  const out: string[] = [];
  const env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env;
  for (const [name, value] of Object.entries(env)) {
    if (!value || !isSecretKey(name, value)) continue;
    for (const part of value.split(",")) if (part.trim().length >= 8) out.push(part.trim());
  }
  return out;
}

/** Free text (an error message) cannot be judged by key, so known secret shapes and values go. */
export function scrubText(text: string): string {
  let out = text;
  for (const secret of secretEnvValues()) out = out.split(secret).join(REDACTED);
  for (const [pattern, replacement] of TEXT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (value instanceof Error) return { name: value.name, message: scrubText(value.message) };
  if (value instanceof URL) return value.origin;
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    // Buffers, Maps, class instances: their contents cannot be vetted, so only the type is logged.
    return `[${(value as object).constructor?.name ?? "Object"}]`;
  }
  return redactFields(value as LogFields, depth + 1);
}

function redactFields(fields: LogFields, depth: number): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = isSecretKey(k, v) ? REDACTED : redactValue(v, depth);
  }
  return out;
}

export function redact(fields: LogFields): LogFields {
  return redactFields(fields, 0);
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
    // Fields first, so a field named level, msg or at cannot replace the real one.
    return JSON.stringify({ ...redact(fields), level, msg: scrubText(String(msg)), at }, replacer);
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
