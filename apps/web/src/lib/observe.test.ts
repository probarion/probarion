import { readFileSync } from "node:fs";
import type { ErrorEvent } from "@sentry/nextjs";
import * as Sentry from "@sentry/nextjs";
import { beforeAll, describe, expect, it } from "vitest";
import { tagRequest } from "./observe";
import { sentryOptions } from "./sentry-scrub";

// A real Sentry client that sends nothing: a made-up DSN, a transport that does nothing, and a beforeSend that keeps
// the scrubbed event and drops it. It is made before the server config loads, so that config's Sentry.init finds a
// client and returns, and the config's default tag is what runs.
const DSN = "https://public@example.invalid/0";
const seen: ErrorEvent[] = [];

beforeAll(async () => {
  const options = sentryOptions(DSN);
  Sentry.init({
    ...options,
    defaultIntegrations: false,
    transport: () => ({ send: async () => ({}), flush: async () => true }),
    beforeSend: (event: ErrorEvent) => {
      seen.push(options.beforeSend(event));
      return null;
    },
  });
  await import("@/sentry.server.config");
});

/** The one event `run` reports inside its own isolation scope, as a request gets one. */
async function eventOf(run: () => void): Promise<ErrorEvent> {
  const before = seen.length;
  await Sentry.withIsolationScope(async () => run());
  await Sentry.flush(2000);
  expect(seen).toHaveLength(before + 1);
  return seen[before] as ErrorEvent;
}

describe("the component tag", () => {
  it("is the one tagRequest set, over the default", async () => {
    const event = await eventOf(() => {
      tagRequest("r-1", "payables", "testnet", { tenant: "t-1" });
      Sentry.captureException(new Error("boom"));
    });
    expect(event.tags).toMatchObject({
      component: "payables",
      request_id: "r-1",
      network: "testnet",
      tenant: "t-1",
    });
  });

  it("is web for a request that tagRequest did not tag", async () => {
    const event = await eventOf(() => {
      Sentry.captureException(new Error("boom"));
    });
    expect(event.tags?.component).toBe("web");
    expect(event.tags?.request_id).toBeUndefined();
    expect(event.tags?.network).toBeUndefined();
  });

  it("is a global-scope default in every Sentry init, so the request's scope wins over it", () => {
    for (const file of [
      "sentry.server.config.ts",
      "sentry.edge.config.ts",
      "instrumentation-client.ts",
    ]) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/initialScope\s*:/);
      expect(source, file).toContain('Sentry.getGlobalScope().setTag("component", "web");');
    }
  });
});
