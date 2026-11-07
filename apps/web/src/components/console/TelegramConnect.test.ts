import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddEmailForm } from "./AddEmailForm";
import { TelegramConnect } from "./TelegramConnect";

describe("TelegramConnect", () => {
  it("starts as a button and nothing else", () => {
    const out = renderToStaticMarkup(
      createElement(TelegramConnect, { connect: async () => ({ ok: false as const, error: "x" }) }),
    );
    expect(out).toContain("Create a Telegram link");
    expect(out).toContain('type="button"');
    expect(out).not.toContain("t.me");
    expect(out).not.toContain("Press Start");
  });
});

describe("AddEmailForm", () => {
  const out = renderToStaticMarkup(createElement(AddEmailForm, { add: async () => null }));

  it("is one email field and one button, and sends nothing by itself", () => {
    expect(out).toContain('type="email"');
    expect(out).toContain('name="email"');
    expect(out).toContain('maxLength="254"');
    expect(out).toContain("required");
    expect(out).toContain('aria-label="Email address"');
    expect(out).toContain("Send confirmation");
    expect(out).not.toContain("alert-");
  });
});
