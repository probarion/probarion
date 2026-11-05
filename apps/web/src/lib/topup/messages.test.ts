import { describe, expect, it } from "vitest";
import { quoteErrorText } from "./messages";

describe("what the owner reads when a quote is not offered", () => {
  it("says the real reason for each answer the quote route gives", () => {
    expect(quoteErrorText(409, { error: "mainnet_only" })).toBe(
      "NEAR Intents and 1Click exist on mainnet only.",
    );
    expect(quoteErrorText(503, { error: "not_configured" })).toBe(
      "1Click quotes are not set up on this server.",
    );
    expect(
      quoteErrorText(400, { error: "invalid_amount", detail: "Between 1 and 1000 USDC" }),
    ).toBe("Between 1 and 1000 USDC");
    expect(quoteErrorText(409, { error: "asset_not_allowed" })).toBe(
      "This vault does not allow Base USDC, so it could not pay a Base payee from it.",
    );
    expect(quoteErrorText(502, { error: "quote_rejected", detail: "mismatch:recipient" })).toBe(
      "Probarion's checks refused the quote (mismatch:recipient), so nothing is offered to sign. Try again.",
    );
    expect(
      quoteErrorText(502, { error: "quote_unavailable", detail: "1Click could not be reached" }),
    ).toBe("1Click gave no quote: 1Click could not be reached");
    expect(quoteErrorText(429, { error: "rate_limited", detail: "Try again in 12 s" })).toBe(
      "Too many quote requests. Try again in 12 s",
    );
    expect(
      quoteErrorText(503, {
        error: "chain_unavailable",
        detail: "The vault could not be read from NEAR. Try again.",
      }),
    ).toBe("The vault could not be read from NEAR. Try again.");
  });

  it("tells a signed-out or wrong account apart", () => {
    expect(quoteErrorText(401, { error: "unauthenticated" })).toBe(
      "Your session ended. Sign in again.",
    );
    expect(quoteErrorText(403, { error: "forbidden" })).toBe(
      "Only this vault's owner can top it up.",
    );
  });

  it("never shows 1Click's or the server's text as markup: it returns plain text for the page to escape", () => {
    expect(quoteErrorText(502, { error: "quote_unavailable", detail: "<b>x</b>" })).toBe(
      "1Click gave no quote: <b>x</b>",
    );
  });

  it("falls back to the code, or the status, for an answer it does not know", () => {
    expect(quoteErrorText(500, { error: "internal" })).toBe(
      "The quote could not be requested (internal).",
    );
    expect(quoteErrorText(502, {})).toBe("The quote could not be requested (HTTP 502).");
    expect(quoteErrorText(500, null)).toBe("The quote could not be requested (HTTP 500).");
    expect(quoteErrorText(500, { error: 5, detail: {} })).toBe(
      "The quote could not be requested (HTTP 500).",
    );
  });

  it("gives a missing detail a sentence of its own", () => {
    expect(quoteErrorText(400, { error: "invalid_amount" })).toBe(
      "Enter an amount between 1 and 1000 USDC.",
    );
    expect(quoteErrorText(502, { error: "quote_rejected" })).toBe(
      "Probarion's checks refused the quote, so nothing is offered to sign. Try again.",
    );
    expect(quoteErrorText(502, { error: "quote_unavailable" })).toBe("1Click gave no quote.");
    expect(quoteErrorText(429, { error: "rate_limited" })).toBe(
      "Too many quote requests. Try again in a minute.",
    );
  });
});
