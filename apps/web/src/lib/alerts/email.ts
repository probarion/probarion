import { Resend } from "resend";
import { ALERT_FROM } from "@/lib/config";
import type { SendResult } from "./telegram";

export interface EmailSender {
  /**
   * Plain text only. The `idempotencyKey` is Resend's: a second send with the same key within a day is not a second
   * email, which is what lets a claim that is taken again after a crash send nothing twice. `unsubscribeUrl` is the
   * address a mail client POSTs to for one-click unsubscribe (RFC 8058).
   */
  send(i: {
    to: string;
    subject: string;
    text: string;
    idempotencyKey: string;
    unsubscribeUrl?: string;
  }): Promise<SendResult>;
}

/** The part of the Resend client this file uses, so a test hands it a fake. */
interface ResendLike {
  emails: {
    send(
      payload: {
        from: string;
        to: string;
        subject: string;
        text: string;
        headers?: Record<string, string>;
      },
      options?: { idempotencyKey?: string },
    ): Promise<{ data: { id: string } | null; error: { message: string } | null }>;
  };
}

export function resendSender(
  apiKey: string,
  client: ResendLike = new Resend(apiKey) as unknown as ResendLike,
): EmailSender {
  return {
    async send({ to, subject, text, idempotencyKey, unsubscribeUrl }) {
      try {
        const { data, error } = await client.emails.send(
          {
            from: ALERT_FROM,
            to,
            subject,
            text,
            ...(unsubscribeUrl
              ? {
                  headers: {
                    "List-Unsubscribe": `<${unsubscribeUrl}>`,
                    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                  },
                }
              : {}),
          },
          { idempotencyKey },
        );
        return error ? { ok: false, error: error.message } : { ok: true, id: data?.id ?? "" };
      } catch {
        // The thrown error can carry the request; the cause is in Resend's dashboard, not in our log.
        return { ok: false, error: "network error" };
      }
    },
  };
}
