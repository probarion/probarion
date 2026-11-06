import { describe, expect, it, vi } from "vitest";
import { ALERT_FROM } from "@/lib/config";
import { resendSender } from "./email";

const client = (reply: { data: { id: string } | null; error: { message: string } | null }) => {
  const send = vi.fn(
    async (_payload: Record<string, unknown>, _options?: Record<string, unknown>) => reply,
  );
  return { send, emails: { send } };
};

describe("resendSender", () => {
  it("sends plain text from the alert address, with the idempotency key as Resend's option", async () => {
    const c = client({ data: { id: "em_1" }, error: null });
    const r = await resendSender("key", c).send({
      to: "owner@example.com",
      subject: "S",
      text: "T",
      idempotencyKey: "alert-1-2",
    });
    expect(r).toEqual({ ok: true, id: "em_1" });
    expect(c.send).toHaveBeenCalledTimes(1);
    const [payload, options] = c.send.mock.calls[0] ?? [];
    expect(payload).toEqual({ from: ALERT_FROM, to: "owner@example.com", subject: "S", text: "T" });
    expect(payload).not.toHaveProperty("html");
    expect(options).toEqual({ idempotencyKey: "alert-1-2" });
  });

  it("adds the one-click unsubscribe headers (RFC 8058) when there is an address for them", async () => {
    const c = client({ data: { id: "em_1" }, error: null });
    await resendSender("key", c).send({
      to: "owner@example.com",
      subject: "S",
      text: "T",
      idempotencyKey: "k",
      unsubscribeUrl: "https://probarion.xyz/api/alerts/stop?s=1&t=2",
    });
    const [payload] = c.send.mock.calls[0] ?? [];
    expect(payload?.headers).toEqual({
      "List-Unsubscribe": "<https://probarion.xyz/api/alerts/stop?s=1&t=2>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("answers Resend's error as a failed send, and a call that throws as one too", async () => {
    const refused = client({ data: null, error: { message: "domain is not verified" } });
    expect(
      await resendSender("key", refused).send({
        to: "a@b.co",
        subject: "S",
        text: "T",
        idempotencyKey: "k",
      }),
    ).toEqual({ ok: false, error: "domain is not verified" });
    const broken = {
      emails: { send: vi.fn(async () => Promise.reject(new Error("socket hang up"))) },
    };
    expect(
      await resendSender("key", broken).send({
        to: "a@b.co",
        subject: "S",
        text: "T",
        idempotencyKey: "k",
      }),
    ).toEqual({ ok: false, error: "network error" });
  });
});
