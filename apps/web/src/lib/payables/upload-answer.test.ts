import { describe, expect, it } from "vitest";
import { uploadAnswer } from "./upload-answer";

// What the upload form says for each answer of POST /api/console/[vault]/invoices (route.ts), in plain words.

describe("uploadAnswer", () => {
  it("links the cycle of a decided invoice and names its outcome", () => {
    const a = uploadAnswer(200, {
      invoiceId: "i-1",
      status: "decided",
      outcome: { status: "paid", code: null, spendId: 2 },
      amountIssue: null,
    });
    expect(a).toMatchObject({ tone: "good", invoiceId: "i-1" });
    expect(a.text).toContain("Paid on NEAR");
  });

  it("says why a total was refused, and that the owner can pay it by hand", () => {
    const a = uploadAnswer(200, {
      invoiceId: "i-2",
      status: "decided",
      outcome: { status: "refused_by_code", code: "invoice.amount_invalid", spendId: null },
      amountIssue: "currency",
    });
    expect(a.tone).toBe("bad");
    expect(a.text).toMatch(/not in USD or USDC/);
    expect(a.text).toMatch(/by hand/);
  });

  it("passes on the server's notice for an invoice that waits or is unconfirmed", () => {
    const waiting = uploadAnswer(200, {
      invoiceId: "i-3",
      status: "awaiting_owner",
      outcome: { status: "held", code: "custom.owner_confirms_without_model", spendId: null },
      notice: "Nothing was sent. No attested model confirmed the amount the code read.",
    });
    expect(waiting).toMatchObject({ tone: "warn", invoiceId: "i-3" });
    expect(waiting.text).toMatch(/^Nothing was sent/);
    const pending = uploadAnswer(200, {
      invoiceId: "i-4",
      status: "unconfirmed",
      outcome: { status: "unconfirmed", code: "pending", spendId: null },
      notice: "Payment sent, confirmation pending. Do not send it again.",
    });
    expect(pending).toMatchObject({ tone: "warn" });
    expect(pending.text).toMatch(/Do not send it again/);
  });

  it("links the existing invoice of a duplicate", () => {
    const a = uploadAnswer(409, {
      error: "duplicate",
      detail: "This invoice was already processed.",
      invoiceId: "i-0",
      status: "decided",
    });
    expect(a).toMatchObject({ tone: "warn", invoiceId: "i-0" });
    expect(a.text).toMatch(/^Duplicate: This invoice was already processed/);
  });

  it("asks for the PO document hashed into the mandate when no mandate matches", () => {
    const a = uploadAnswer(409, {
      error: "no_mandate",
      detail:
        "Attach the purpose document: the PO or contract you hashed when you created the mandate.",
    });
    expect(a.tone).toBe("bad");
    expect(a.text).toMatch(/Attach the PO or contract document whose hash is in the mandate/);
    expect(a.text).toMatch(/Attach the purpose document/);
    expect(a.invoiceId).toBeNull();
  });

  it("gives the size limit for a 413", () => {
    expect(
      uploadAnswer(413, {
        error: "too_large",
        detail: "The invoice is larger than 4 MiB (4,194,304 bytes).",
      }).text,
    ).toMatch(/larger than 4 MiB/);
    expect(uploadAnswer(413, null).text).toMatch(/4 MiB/);
  });

  it("does not throw on a gateway answer that is not JSON", () => {
    for (const status of [502, 504, 500, 0]) {
      const a = uploadAnswer(status, null);
      expect(a.tone).toBe("bad");
      expect(a.text).toMatch(
        /the server did not answer; check the invoice list before you upload again/,
      );
    }
    // A JSON body of an unexpected shape is not trusted either.
    expect(uploadAnswer(502, "oops").text).toMatch(/did not answer/);
  });

  it("shows any other refusal with its code and detail, made safe", () => {
    const a = uploadAnswer(429, { error: "rate_limited", detail: "Try again in 12 s\u202E\n" });
    expect(a.text).toBe("rate_limited: Try again in 12 s\uFFFD\uFFFD");
  });
});
