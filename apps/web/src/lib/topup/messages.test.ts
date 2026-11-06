import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ONLY_ON_MAINNET } from "./copy";
import { quoteErrorText } from "./messages";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

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

  it("shows the guard's sentence for a vault on the other network, with one of its own as a fallback", () => {
    expect(
      quoteErrorText(409, {
        error: "wrong_network",
        detail: "This vault is on NEAR mainnet. Open it at the mainnet address.",
      }),
    ).toBe("This vault is on NEAR mainnet. Open it at the mainnet address.");
    expect(quoteErrorText(409, { error: "wrong_network" })).toBe(
      "This vault is on the other network. Open it at that network's address.",
    );
  });

  it("says the 'mainnet only' sentence from the one place it is written", () => {
    expect(quoteErrorText(409, { error: "mainnet_only" })).toBe(`${ONLY_ON_MAINNET}.`);
  });

  it("has a sentence for the codes that were falling through", () => {
    expect(quoteErrorText(403, { error: "bad_origin" })).toBe(
      "The request did not come from this site, so it was refused. Reload the page and try again.",
    );
    expect(quoteErrorText(400, { error: "invalid_input" })).toBe(
      "The request was not understood. Reload the page and try again.",
    );
    expect(quoteErrorText(503, { error: "unavailable", detail: "Try again in a minute." })).toBe(
      "A service this page needs is not available. Try again in a minute.",
    );
    expect(quoteErrorText(503, { error: "unavailable" })).toBe(
      "A service this page needs is not available. Try again in a minute.",
    );
    expect(
      quoteErrorText(502, { error: "status_unavailable", detail: "1Click status failed (404)" }),
    ).toBe("1Click status failed (404)");
    expect(quoteErrorText(502, { error: "status_unavailable" })).toBe(
      "1Click could not report the deposit's status right now.",
    );
  });

  it("has a sentence for every code the three routes, their shared gate, the guard and the helpers can answer", () => {
    const files = [
      "src/app/api/topup/quote/route.ts",
      "src/app/api/topup/submit/route.ts",
      "src/app/api/topup/status/route.ts",
      "src/lib/topup/gate.ts",
      "src/lib/auth/guard.ts",
      "src/lib/http.ts",
    ];
    const codes = new Set<string>();
    for (const file of files) {
      const text = readFileSync(join(WEB, file), "utf8");
      for (const m of text.matchAll(/problem\(\s*\d{3},\s*"([a-z_]+)"/g)) codes.add(m[1] ?? "");
    }
    // The scan must see the codes it is meant to guard, or it guards nothing.
    for (const known of [
      "mainnet_only",
      "not_configured",
      "unavailable",
      "rate_limited",
      "bad_origin",
      "invalid_input",
      "quote_rejected",
      "status_unavailable",
      "forbidden",
      "unauthenticated",
    ]) {
      expect([...codes], known).toContain(known);
    }
    for (const code of codes) {
      expect(quoteErrorText(500, { error: code }), code).not.toMatch(
        /^The quote could not be requested/,
      );
    }
  });
});
