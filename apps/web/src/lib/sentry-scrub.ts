import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { scrubText, secretEnvValues } from "@/lib/log";

// What leaves for Sentry, decided in one place for the server, the edge and the browser: no user, no cookies, no
// headers, no bodies, no query strings, no local variables, no tracing, and every string through the log's own
// scrubber (known secret values and secret shapes such as a Telegram bot token in a URL path). A console.error line
// from lib/log.ts becomes one issue per log key, tagged with the component that key belongs to and, unless the route
// tagged them already, the line's own request id and network.

/** The `component` tag's values. Sentry alert rules (docs/ops/MONITORING.md) filter on these and on nothing else. */
export const COMPONENTS = [
  "web",
  "auth",
  "console",
  "payables",
  "topup",
  "canary",
  "proof",
  "usage",
  "watcher",
  "alerts",
  "metrics",
  "health",
  "extension",
] as const;
export type Component = (typeof COMPONENTS)[number];

const COMPONENT_OF_KEY: ReadonlyArray<readonly [RegExp, Component]> = [
  [/^cron\.watch/, "watcher"],
  [/^cron\.(metrics|rate_limits)/, "metrics"],
  [/^(alerts|telegram)\./, "alerts"],
  [/^(auth|chain)\./, "auth"],
  [/^canary\./, "canary"],
  [/^(console|keys|register)\./, "console"],
  [/^watch\./, "watcher"],
  [/^(payables|lease)\./, "payables"],
  [/^proof\./, "proof"],
  [/^topup\./, "topup"],
  [/^usage\./, "usage"],
  [/^(health|status)\./, "health"],
];

/** The component a log key belongs to, from its prefix, or null. */
export function componentOfLog(key: string): Component | null {
  for (const [pattern, component] of COMPONENT_OF_KEY) if (pattern.test(key)) return component;
  return null;
}

const LOG_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const MAX_DEPTH = 12;

const stripQuery = (url: string): string => url.replace(/[?#].*$/, "");

function scrubDeep(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === "string") return scrubText(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, secrets, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = scrubDeep(item, secrets, depth + 1);
  return out;
}

/** A request id as the proxy and newRequestId() make them (a UUID), or any short id of that alphabet. */
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

interface LogLine {
  key: string;
  requestId: string | null;
  network: "mainnet" | "testnet" | null;
}

/**
 * The log key, and the `request_id` and `network` fields, of an event the console integration made from a lib/log.ts
 * line, or null. No other field of the line is read.
 */
function logLineOf(event: ErrorEvent): LogLine | null {
  if (event.logger !== "console") return null;
  const line = typeof event.message === "string" ? event.message : event.logentry?.message;
  if (typeof line !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { msg, request_id: requestId, network } = parsed as Record<string, unknown>;
  if (typeof msg !== "string" || !LOG_KEY.test(msg)) return null;
  return {
    key: msg,
    requestId: typeof requestId === "string" && REQUEST_ID.test(requestId) ? requestId : null,
    network: network === "mainnet" || network === "testnet" ? network : null,
  };
}

export function scrubEvent(
  event: ErrorEvent,
  secrets: readonly string[] = secretEnvValues(),
): ErrorEvent {
  const logLine = logLineOf(event);
  const { user: _user, request, ...rest } = event;
  const out = scrubDeep(rest, secrets) as ErrorEvent;
  if (request !== undefined) {
    // Only where and how: alert links carry one-time tokens in the query, and headers carry the session cookie.
    out.request = {
      ...(typeof request.url === "string"
        ? { url: stripQuery(scrubText(request.url, secrets)) }
        : {}),
      ...(typeof request.method === "string" ? { method: request.method } : {}),
    };
  }
  if (logLine !== null) {
    const { key } = logLine;
    out.fingerprint = ["log", key];
    out.message = key;
    if (out.logentry !== undefined) out.logentry = { message: key };
    const tags = { ...(out.tags ?? {}) };
    const component = componentOfLog(key);
    if (component !== null && (tags.component === undefined || tags.component === "web")) {
      tags.component = component;
    }
    // A route that tagged its scope (tagRequest) keeps its values; any other route's line brings its own, so an event
    // from a route that is not tagged still carries the request id of the line that made it (plan 05 contract).
    if (logLine.requestId !== null && tags.request_id === undefined)
      tags.request_id = logLine.requestId;
    if (logLine.network !== null && tags.network === undefined) tags.network = logLine.network;
    out.tags = tags;
  }
  return out;
}

export function scrubBreadcrumb(
  breadcrumb: Breadcrumb,
  secrets: readonly string[] = secretEnvValues(),
): Breadcrumb {
  const out: Breadcrumb = { ...breadcrumb };
  if (typeof out.message === "string") out.message = scrubText(out.message, secrets);
  if (out.data !== undefined) {
    const data = scrubDeep(out.data, secrets) as Record<string, unknown>;
    if (typeof data.url === "string") data.url = stripQuery(data.url);
    out.data = data;
  }
  return out;
}

/** The options every Sentry.init shares. Without a DSN the SDK is off. */
export function sentryOptions(dsn: string | undefined) {
  return {
    dsn,
    enabled: dsn !== undefined,
    // Tracing is off (no tracesSampleRate), and no trace header goes to another service.
    tracePropagationTargets: [] as string[],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeSend: (event: ErrorEvent): ErrorEvent => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb: Breadcrumb): Breadcrumb => scrubBreadcrumb(breadcrumb),
  };
}
