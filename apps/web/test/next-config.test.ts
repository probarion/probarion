import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config headers", () => {
  it("sends Cross-Origin-Opener-Policy: same-origin-allow-popups and keeps every other security header", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule?.source).toBe("/(.*)");
    expect(Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]))).toEqual({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    });
  });
});
