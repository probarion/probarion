import { describe, expect, it } from "vitest";
import withSentry, { nextConfig } from "../next.config";

const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

async function headersOf(config: typeof nextConfig): Promise<Record<string, string>> {
  const rules = (await config.headers?.()) ?? [];
  expect(rules).toHaveLength(1);
  const rule = rules[0];
  expect(rule?.source).toBe("/(.*)");
  return Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]));
}

describe("next.config headers", () => {
  it("sends Cross-Origin-Opener-Policy: same-origin-allow-popups and keeps every other security header", async () => {
    expect(await headersOf(nextConfig)).toEqual(HEADERS);
  });

  it("keeps the same headers once Sentry wraps the config", async () => {
    expect(await headersOf(withSentry)).toEqual(HEADERS);
  });
});
