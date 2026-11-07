import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it, vi } from "vitest";
import { formatLog } from "@/lib/log";
import {
  COMPONENTS,
  componentOfLog,
  scrubBreadcrumb,
  scrubEvent,
  sentryOptions,
  sentrySecrets,
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

  it("takes the request id and network of the line over the scope's, and keeps the scope's when the line has none that is valid", () => {
    // A scope can carry another request's tags (the request that started the instance tagged the scope every later
    // request copies), while the line was written by the request that failed.
    const line = formatLog("error", "payables.route_failed", {
      request_id: "from-line",
      network: "mainnet",
    });
    const stale = scrubEvent(
      event({
        logger: "console",
        message: line,
        tags: { request_id: "from-scope", network: "testnet" },
      }),
      [],
    );
    expect(stale.tags?.request_id).toBe("from-line");
    expect(stale.tags?.network).toBe("mainnet");
    const bare = formatLog("error", "payables.route_failed", { network: "moon" });
    const tagged = scrubEvent(
      event({
        logger: "console",
        message: bare,
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

  it("keeps the console's text arguments, masked, and only the type of any other, cycles included", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    loop.again = { back: loop, list: [loop, loop] };
    const out = scrubEvent(
      event({
        logger: "console",
        message: "plain",
        extra: { arguments: [`failed with ${SECRET}`, loop, new Error(SECRET), 7] },
      }),
      [SECRET],
    );
    expect(out.extra?.arguments).toEqual([
      "failed with [redacted]",
      "[object]",
      "[object]",
      "[number]",
    ]);
    const cyclic = scrubEvent(event({ contexts: { app: loop } }), []);
    expect(JSON.stringify(cyclic)).toContain("[circular]");
  });
});

/** An RPC key, as some providers put it in the URL's path (Lava's documented shape). */
const RPC_KEY = ["0123456789abcdef", "0123456789abcdef"].join("");

describe("sentrySecrets", () => {
  it("adds each secret URL as Sentry writes it: default port dropped, host in lower case, and without its query", () => {
    const configured = [
      `https://g.w.lavanet.xyz:443/gateway/near/rpc-http/${RPC_KEY}`,
      `https://RPC.Example.com/v1/${RPC_KEY}`,
      `https://near.example.com/v1/${RPC_KEY}?network=mainnet`,
    ];
    const secrets = sentrySecrets(configured);
    for (const value of configured) expect(secrets).toContain(value);
    for (const form of [
      `https://g.w.lavanet.xyz/gateway/near/rpc-http/${RPC_KEY}`,
      `https://rpc.example.com/v1/${RPC_KEY}`,
      `https://near.example.com/v1/${RPC_KEY}`,
    ])
      expect(secrets).toContain(form);
    expect(secrets).toEqual([...secrets].sort((a, b) => b.length - a.length));
    // Text that is not an http URL is kept as it is, and adds nothing.
    expect(sentrySecrets(["ed25519:abcdefghijk", "123456789:token-like"])).toEqual([
      "123456789:token-like",
      "ed25519:abcdefghijk",
    ]);
  });

  it("masks a keyed URL in an error's text in the form Sentry gives it, from the settings themselves", () => {
    vi.stubEnv(
      "NEAR_RPC_URLS_MAINNET",
      `https://g.w.lavanet.xyz:443/gateway/near/rpc-http/${RPC_KEY}`,
    );
    vi.stubEnv("NEAR_ARCHIVAL_RPC_URLS_MAINNET", `https://RPC.Example.com/v1/${RPC_KEY}`);
    try {
      const options = sentryOptions("https://public@o0.ingest.sentry.io/0");
      const out = options.beforeSend(
        event({
          message: `fetch to https://g.w.lavanet.xyz/gateway/near/rpc-http/${RPC_KEY} failed`,
          exception: {
            values: [{ type: "Error", value: `https://rpc.example.com/v1/${RPC_KEY}: 502` }],
          },
        }),
      );
      expect(JSON.stringify(out)).not.toContain(RPC_KEY);
    } finally {
      vi.unstubAllEnvs();
    }
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
    expect(String(crumb?.data?.url)).not.toContain("AAAA");
    expect(String(crumb?.data?.url)).not.toContain("?");
  });

  it("keeps only the origin of an outgoing request, so an RPC key in its path never reaches Sentry", () => {
    // The URLs as Sentry's fetch breadcrumb writes them, after it dropped the :443, lower-cased the host and cut the
    // query: none of them is the configured text any more.
    const configured = [
      `https://g.w.lavanet.xyz:443/gateway/near/rpc-http/${RPC_KEY}`,
      `https://RPC.Example.com/v1/${RPC_KEY}`,
    ];
    const cases: [string, string, string][] = [
      [
        "http",
        `https://g.w.lavanet.xyz/gateway/near/rpc-http/${RPC_KEY}`,
        "https://g.w.lavanet.xyz",
      ],
      ["http", `https://rpc.example.com/v1/${RPC_KEY}`, "https://rpc.example.com"],
      ["fetch", `https://rpc.example.com:8443/v1/${RPC_KEY}`, "https://rpc.example.com:8443"],
      ["xhr", `https://rpc.example.com/v1/${RPC_KEY}#frag`, "https://rpc.example.com"],
    ];
    for (const secrets of [[], configured, sentrySecrets(configured)]) {
      for (const [category, url, origin] of cases) {
        const crumb = scrubBreadcrumb(
          {
            category,
            type: "http",
            data: {
              url,
              status_code: 200,
              "http.request.method": "POST",
              "url.query": "network=mainnet",
              "url.fragment": "frag",
              "http.query": "?network=mainnet",
              "http.fragment": "#frag",
            },
          },
          secrets,
        );
        expect(crumb?.data, url).toEqual({
          url: origin,
          status_code: 200,
          "http.request.method": "POST",
        });
      }
    }
  });

  it("keeps the path of a request to this site, without its query", () => {
    const crumb = scrubBreadcrumb(
      { category: "fetch", data: { url: "/alerts/confirm?token=abc", method: "GET" } },
      [],
    );
    expect(crumb?.data).toEqual({ url: "/alerts/confirm", method: "GET" });
    const odd = scrubBreadcrumb({ category: "fetch", data: { url: "not a url/at all" } }, []);
    expect(odd?.data).toEqual({ url: "[url]" });
  });

  it("drops console breadcrumbs: info and warn lines can name an account, and they stay in the server's logs", () => {
    const line = formatLog("info", "auth.signed_in", { account: "alice.near" });
    expect(scrubBreadcrumb({ category: "console", level: "info", message: line }, [])).toBeNull();
    const options = sentryOptions("https://public@o0.ingest.sentry.io/0");
    expect(options.beforeBreadcrumb({ category: "console", message: line })).toBeNull();
    expect(options.beforeBreadcrumb({ category: "navigation", data: { to: "/status" } })).toEqual({
      category: "navigation",
      data: { to: "/status" },
    });
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
      ["ext.pair_failed", "extension"],
      ["ext.inbox_failed", "extension"],
      ["ext.mint_failed", "extension"],
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
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    });
  });
});
