import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CANARY_LIMITS } from "@/lib/canary/limits";
import type { Network } from "@/lib/config";
import { CanaryForm } from "./CanaryForm";

const render = (mode: "live" | "code-only" = "code-only", network: Network = "testnet") =>
  renderToStaticMarkup(createElement(CanaryForm, { network, mode }));
const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
const attr = (html: string, tag: string, name: string) =>
  new RegExp(`<${tag}\\b[^>]*?\\s${name}="([^"]*)"`).exec(html)?.[1];

describe("the attempt form, before anything is typed", () => {
  it("has a visible label that points at the textarea", () => {
    const html = render();
    const labelFor = attr(html, "label", "for");
    expect(labelFor).toBeTruthy();
    expect(attr(html, "textarea", "id")).toBe(labelFor);
    expect(html).toMatch(/<label[^>]*>Your message to the agent<\/label>/);
  });

  it("limits the text to what the server accepts and counts the characters as they are typed", () => {
    const html = render();
    expect(attr(html, "textarea", "maxLength")).toBe(String(CANARY_LIMITS.maxTextChars));
    expect(CANARY_LIMITS.maxTextChars).toBe(4000);
    expect(visible(html)).toContain("0 / 4,000");
  });

  it("gives the note about personal data, and ties it to the textarea", () => {
    const html = render();
    expect(visible(html)).toContain(
      "Up to 4,000 characters. Don't include personal data: we store a hash of your text and the result.",
    );
    const note = attr(html, "textarea", "aria-describedby");
    expect(note).toBeTruthy();
    expect(html).toContain(`id="${note}"`);
  });

  it("has a button in ink that reads Try to get paid, and it is disabled until there is text", () => {
    const html = render();
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*disabled=""[^>]*>Try to get paid<\/button>/,
    );
    expect(html).toContain("bg-ink");
  });

  it("is not a form that could send the text in an address: no form element, and the textarea has no name", () => {
    const html = render();
    expect(html).not.toContain("<form");
    expect(attr(html, "textarea", "name")).toBeUndefined();
  });

  it("says Code only today in code-only mode and Raw mode on in live mode", () => {
    expect(visible(render("code-only"))).toContain("Code only today");
    expect(visible(render("code-only"))).not.toContain("Raw mode on");
    expect(visible(render("live"))).toContain("Raw mode on");
    expect(visible(render("live"))).not.toContain("Code only today");
  });

  it("has a live region, empty at first, so that an answer is announced when it comes", () => {
    const html = render();
    expect(html).toMatch(/<div[^>]*aria-live="polite"[^>]*><\/div>/);
  });
});
