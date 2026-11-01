export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export const REQUEST_ID_HEADER = "x-request-id";

const SECRET_KEY = /secret|token|password|authorization|cookie|api_?key|private/i;
const SAFE_KEY = /(_hash|^public_key|^request_id)$/;

export function redact(fields: LogFields, depth = 0): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEY.test(k) && !SAFE_KEY.test(k)) out[k] = "[redacted]";
    else if (v && typeof v === "object" && !Array.isArray(v) && depth < 4)
      out[k] = redact(v as LogFields, depth + 1);
    else out[k] = v;
  }
  return out;
}

export function formatLog(
  level: LogLevel,
  msg: string,
  fields: LogFields = {},
  now: Date = new Date(),
): string {
  return JSON.stringify({ level, msg, at: now.toISOString(), ...redact(fields) });
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
