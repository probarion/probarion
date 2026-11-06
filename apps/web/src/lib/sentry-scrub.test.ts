import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { formatLog } from "@/lib/log";
import {
  COMPONENTS,
  componentOfLog,
  scrubBreadcrumb,
  scrubEvent,
  sentryOptions,
} from "./sentry-scrub";

const SECRET = "s3cr3t-value-0123456789";
const event = (over: Record<string, unknown>): ErrorEvent =>
  ({ type: undefined, ...over }) as ErrorEvent;

describe("scrubEvent", () => {
  it("drops the user, the headers, the cookies, the body and the query", () => {
    const out = scrubEvent(
      event({
        user: { id: "alice.near", ip_address: "203.0.113.7" },
        request: {
          url: "https://probarion.xyz/alerts/confirm?token=abc#x",
          method: "GET",
          headers: { cookie: "pb_session=x" },
          cookies: { pb_session: "x" },
          data: "body",
          query_string: "token=abc",
        },
      }),
      [SECRET],
    );
    expect(out.user).toBeUndefined();
    expect(out.request).toEqual({ url: "https://probarion.xyz/alerts/confirm", method: "GET" });
  });

  it("masks a secret value wherever it appears", () => {
    const out = scrubEvent(
      event({
        message: `failed with ${SECRET}`,
        exception: { values: [{ type: "Error", value: `bad ${SECRET}` }] },
        breadcrumbs: [{ message: `crumb ${SECRET}` }],
        extra: { nested: { deep: [SECRET] } },
        contexts: { app: { note: SECRET } },
      }),
      [SECRET],
    );
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("makes a log line one issue per key, tagged with the key's component", () => {
    const line = formatLog("error", "payables.route_failed", { request_id: "r1" });
    const out = scrubEvent(
      event({
        logger: "console",
        message: line,
        extra: { arguments: [line] },
        tags: { component: "web" },
      }),
      [],
    );
    expect(out.fingerprint).toEqual(["log", "payables.route_failed"]);
    expect(out.message).toBe("payables.route_failed");
    expect(out.tags?.component).toBe("payables");
  });

  it("keeps the component a route set, and reads the logentry form too", () => {
    const line = formatLog("error", "watch.tenant_failed", {});
    const out = scrubEvent(
      event({ logger: "console", logentry: { message: line }, tags: { component: "canary" } }),
      [],
    );
    expect(out.fingerprint).toEqual(["log", "watch.tenant_failed"]);
    expect(out.tags?.component).toBe("canary");
  });

  it("leaves an event that is not a log line as it was", () => {
    const out = scrubEvent(event({ logger: "console", message: "plain text" }), []);
    expect(out.fingerprint).toBeUndefined();
    expect(out.message).toBe("plain text");
  });

  it("tags an untagged route's event with its line's request id and network, and with nothing else of the line", () => {
    const line = formatLog("error", "topup.quote_failed", {
      request_id: "r-1",
      network: "mainnet",
      account: "alice.near",
    });
    const out = scrubEvent(
      event({ logger: "console", message: line, tags: { component: "web" } }),
      [],
    );
    expect(out.tags).toEqual({ component: "topup", request_id: "r-1", network: "mainnet" });
  });

  it("keeps the request id and network a route tagged, and ignores malformed ones in the line", () => {
    const line = formatLog("error", "payables.route_failed", {
      request_id: "from-line",
      network: "moon",
    });
    const tagged = scrubEvent(
      event({
        logger: "console",
        message: line,
        tags: { request_id: "from-route", network: "testnet" },
      }),
      [],
    );
    expect(tagged.tags?.request_id).toBe("from-route");
    expect(tagged.tags?.network).toBe("testnet");
    const odd = formatLog("error", "proof.unavailable", { request_id: "x y\n", network: "moon" });
    const untagged = scrubEvent(event({ logger: "console", message: odd }), []);
    expect(untagged.tags?.request_id).toBeUndefined();
    expect(untagged.tags?.network).toBeUndefined();
  });
});

describe("scrubBreadcrumb", () => {
  it("strips the query and masks a bot token in the path", () => {
    const crumb = scrubBreadcrumb(
      {
        category: "fetch",
        data: {
          url: "https://api.telegram.org/bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage?chat_id=1",
          method: "POST",
        },
      },
      [],
    );
    expect(String(crumb.data?.url)).not.toContain("AAAA");
    expect(String(crumb.data?.url)).not.toContain("?");
  });
});

describe("componentOfLog", () => {
  it("maps every log prefix the app uses to one tag value", () => {
    const cases: [string, string | null][] = [
      ["cron.watch_failed", "watcher"],
      ["watch.tenant_failed", "watcher"],
      ["cron.metrics_failed", "metrics"],
      ["cron.rate_limits_prune_failed", "metrics"],
      ["alerts.dispatch_failed", "alerts"],
      ["telegram.webhook_failed", "alerts"],
      ["chain.wrong", "auth"],
      ["auth.verify_failed", "auth"],
      ["canary.route_failed", "canary"],
      ["keys.add_failed", "console"],
      ["register.failed", "console"],
      ["lease.lost", "payables"],
      ["payables.route_failed", "payables"],
      ["proof.snapshot_failed", "proof"],
      ["topup.quote_failed", "topup"],
      ["usage.load_failed", "usage"],
      ["health.settings_invalid", "health"],
      ["status.report_failed", "health"],
      ["sdk.something", null],
    ];
    for (const [key, component] of cases) expect(componentOfLog(key), key).toBe(component);
    for (const [, component] of cases) {
      if (component !== null) expect(COMPONENTS).toContain(component);
    }
  });
});

describe("sentryOptions", () => {
  it("is off without a DSN, traces nothing and collects no personal data", () => {
    expect(sentryOptions(undefined).enabled).toBe(false);
    const on = sentryOptions("https://public@o0.ingest.sentry.io/0");
    expect(on.enabled).toBe(true);
    expect("tracesSampleRate" in on).toBe(false);
    expect(on.tracePropagationTargets).toEqual([]);
    expect(on.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    });
  });
});
