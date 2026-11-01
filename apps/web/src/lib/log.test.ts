import { describe, expect, it } from "vitest";
import { formatLog, redact } from "./log";

describe("structured logs", () => {
  it("emits one JSON line with level, message, time and request_id", () => {
    const line = formatLog(
      "info",
      "invoice.decided",
      { request_id: "r-1", tenant: "t" },
      new Date("2026-11-08T00:00:00Z"),
    );
    expect(JSON.parse(line)).toEqual({
      level: "info",
      msg: "invoice.decided",
      at: "2026-11-08T00:00:00.000Z",
      request_id: "r-1",
      tenant: "t",
    });
  });

  it("redacts secrets at any depth but keeps hashes and public keys", () => {
    const out = redact({
      agent_secret: "ed25519:xyz",
      headers: { authorization: "Bearer abc", cookie: "pb_session=1" },
      invoice_hash: "ab".repeat(32),
      public_key: "ed25519:pub",
      nested: { deeper: { api_key: "k" } },
    });
    expect(out.agent_secret).toBe("[redacted]");
    expect((out.headers as Record<string, unknown>).authorization).toBe("[redacted]");
    expect((out.headers as Record<string, unknown>).cookie).toBe("[redacted]");
    expect(out.invoice_hash).toBe("ab".repeat(32));
    expect(out.public_key).toBe("ed25519:pub");
    expect(
      ((out.nested as Record<string, unknown>).deeper as Record<string, unknown>).api_key,
    ).toBe("[redacted]");
  });
});
