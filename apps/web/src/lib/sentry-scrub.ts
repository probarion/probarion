import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { scrubText, secretEnvValues } from "@/lib/log";

// What leaves for Sentry, decided in one place for the server, the edge and the browser: no user, no cookies, no
// headers, no bodies, no query strings, no local variables, no tracing, no console breadcrumbs, only the origin of an
// outgoing request's URL, and every string through the log's own scrubber (known secret values, also in the forms
// Sentry rewrites a URL to, and secret shapes such as a Telegram bot token in a URL path). A console.error line from
// lib/log.ts becomes one issue per log key, tagged with the component that key belongs to (unless the route tagged
// one) and with the line's own request id and network.

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

/**
 * The global slot where sentry.server.config.ts keeps the isolation scope it finds right after Sentry.init: the
 * process-wide one, which the SDK falls back to outside a request and copies for every request it forks a scope for.
 * observe.ts never tags it (a request answered on it is one that started before Sentry.init).
 */
export const PROCESS_SCOPE: unique symbol = Symbol.for("probarion.sentry.process_isolation_scope");

/**
 * The secret values to mask in what goes to Sentry: the log's (`secretEnvValues`), and each http URL among them also
 * as Sentry writes a URL (default port dropped, host in lower case: `URL#href`) and without its query, which Sentry
 * cuts. Without these forms an RPC key in a URL's path would no longer match its setting. Longest first.
 */
export function sentrySecrets(values: readonly string[] = secretEnvValues()): string[] {
  const out = new Set(values);
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    out.add(url.href);
    // A bare origin's path is "/": masking `https://host/` would hide every URL of that host and no secret.
    if (url.pathname !== "/") out.add(`${url.origin}${url.pathname}`);
  }
  return [...out].filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
}

/** Every object it walks is checked against its ancestors, so a cycle ends as "[circular]". */
function scrubDeep(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
  ancestors: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") return scrubText(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (ancestors.has(value)) return "[circular]";
  ancestors.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item) => scrubDeep(item, secrets, depth + 1, ancestors));
  } else {
    const fields: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      fields[key] = scrubDeep(item, secrets, depth + 1, ancestors);
    }
    out = fields;
  }
  ancestors.delete(value);
  return out;
}

/**
 * The arguments the console integration attaches to an event (`extra.arguments`): text is kept, masked, and anything
 * else only by its type, so a large or cyclic object a library logs is never walked or sent.
 */
function consoleArguments(args: unknown, secrets: readonly string[]): unknown {
  if (!Array.isArray(args)) return scrubDeep(args, secrets);
  return args.map((arg) =>
    typeof arg === "string" ? scrubText(arg, secrets) : `[${arg === null ? "null" : typeof arg}]`,
  );
}

/** The categories of the breadcrumbs Sentry records for an outgoing request: `http` on the server, `fetch` and `xhr`. */
const REQUEST_CATEGORIES: ReadonlySet<string> = new Set(["http", "fetch", "xhr"]);
/** A request breadcrumb's query and fragment fields (`url.query` on the server, `http.query` in the browser). */
const URL_PART_FIELD = /^(url|http)\.(query|fragment)$/;

/**
 * Where an outgoing request went, and nothing that could be a key: some RPC providers put the key in the URL's path,
 * and Sentry has rewritten the URL before it gets here (default port dropped, host in lower case), so it may no longer
 * match the setting. An absolute URL keeps its origin only; a path on this site keeps its path, without the query.
 */
function requestUrl(url: string): string {
  if (url.startsWith("/") && !url.startsWith("//")) return stripQuery(url);
  try {
    const { origin } = new URL(url);
    return origin === "null" ? "[url]" : origin;
  } catch {
    return "[url]";
  }
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
  secrets: readonly string[] = sentrySecrets(),
): ErrorEvent {
  const logLine = logLineOf(event);
  const { user: _user, request, extra, ...rest } = event;
  const out = scrubDeep(rest, secrets) as ErrorEvent;
  if (extra !== undefined) {
    const { arguments: args, ...others } = extra;
    out.extra = {
      ...(scrubDeep(others, secrets) as Record<string, unknown>),
      ...("arguments" in extra ? { arguments: consoleArguments(args, secrets) } : {}),
    };
  }
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
    // The line's own request id and network win over the scope's: the line was written by the request that failed,
    // while a scope can carry another request's tags (observe.ts). So an event from a route that is not tagged still
    // carries the request id of the line that made it (plan 05 contract), and a line without them keeps the scope's.
    if (logLine.requestId !== null) tags.request_id = logLine.requestId;
    if (logLine.network !== null) tags.network = logLine.network;
    out.tags = tags;
  }
  return out;
}

/**
 * A breadcrumb as it may leave, or null to drop it. Console lines are dropped: an info or warn line can name an
 * account (sign-in, the owner's Confirm), and an error line is an event of its own (the console bridge).
 */
export function scrubBreadcrumb(
  breadcrumb: Breadcrumb,
  secrets: readonly string[] = sentrySecrets(),
): Breadcrumb | null {
  if (breadcrumb.category === "console") return null;
  const out: Breadcrumb = { ...breadcrumb };
  if (typeof out.message === "string") out.message = scrubText(out.message, secrets);
  if (out.data !== undefined) {
    const raw = out.data.url;
    const data = scrubDeep(out.data, secrets) as Record<string, unknown>;
    if (REQUEST_CATEGORIES.has(out.category ?? "")) {
      for (const key of Object.keys(data)) if (URL_PART_FIELD.test(key)) delete data[key];
      if (typeof raw === "string") data.url = scrubText(requestUrl(raw), secrets);
    } else if (typeof data.url === "string") {
      data.url = stripQuery(data.url);
    }
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
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeSend: (event: ErrorEvent): ErrorEvent => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb: Breadcrumb): Breadcrumb | null => scrubBreadcrumb(breadcrumb),
  };
}
