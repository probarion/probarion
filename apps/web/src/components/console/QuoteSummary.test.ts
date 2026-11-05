import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { VerifiedQuote } from "@/lib/topup/oneclick";
import { QuoteSummary } from "./QuoteSummary";

const quote: VerifiedQuote = {
  depositAddress: "ab".repeat(32),
  depositMemo: null,
  amountIn: "20208197",
  amountInFormatted: "20.208197",
  amountOut: "20000000",
  amountOutFormatted: "20",
  deadline: "2026-11-08T10:30:00.000Z",
  timeEstimate: 12,
  correlationId: "corr-1",
  signature: "ed25519:sig",
  timestamp: "2026-11-08T10:00:00.000Z",
  recipient: "acme.vaults.probarion.near",
  refundTo: "acme.near",
};

const html = (q: VerifiedQuote = quote) =>
  renderToStaticMarkup(createElement(QuoteSummary, { quote: q }));
const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

describe("a verified quote as the owner reads it", () => {
  it("shows a badge only for each fact the server checked, with the values it checked", () => {
    const badges = [
      ...html().matchAll(/<span class="[^"]*bg-emerald-100[^"]*">([^<]*)<\/span>/g),
    ].map((m) => m[1] ?? "");
    expect(badges).toEqual([
      "Signature verified",
      "Recipient = acme.vaults.probarion.near (Intents account)",
      "Refund address = acme.near",
    ]);
  });

  it("says what the owner sends and what the quote has 1Click credit", () => {
    const t = text(html());
    expect(t).toContain("You send 20.208197 USDC on NEAR.");
    expect(t).toContain(
      "credit 20 Base USDC to acme.vaults.probarion.near's account in NEAR Intents",
    );
  });

  it("lists what the server checked before showing it, and no more", () => {
    const t = text(html());
    expect(t).toContain("the signature (against the 1Click key built into the SDK)");
    expect(t).toContain("that the quote is for this vault and this refund address");
    expect(t).toContain("that it delivers at least what you asked for");
    expect(t).toContain("that you pay at most 5% more than that");
    expect(t).toContain("that it was signed less than 5 minutes ago");
  });

  it("gives the refund as 1Click's documented rule, not as something this console checked", () => {
    const t = text(html());
    expect(t).toContain("Per 1Click's API documentation");
    expect(t).toContain(
      "input above what the swap needs is refunded to acme.near on NEAR once the swap completes",
    );
  });

  it("gives the deadline in UTC, with what 1Click says happens after it", () => {
    const t = text(html());
    expect(t).toContain("Sign before 2026-11-08 10:30 UTC.");
    expect(t).toContain("1Click says the deposit address becomes inactive and funds may be lost");
  });

  it("shows the deposit address, the estimate and the quote id", () => {
    const t = text(html());
    expect(t).toContain(`Deposit address ${"ab".repeat(32)}`);
    expect(t).toContain("1Click estimates about 12 s");
    expect(t).toContain("quote corr-1");
  });

  it("leaves out the estimate when 1Click gave none", () => {
    expect(text(html({ ...quote, timeEstimate: 0 }))).not.toContain("estimates");
  });

  it("writes everything it was given as text, never as markup", () => {
    const out = html({
      ...quote,
      recipient: "<img src=x onerror=alert(1)>",
      correlationId: "<b>c</b>",
    });
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>c</b>");
  });
});
