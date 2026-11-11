import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CANARY_CHIPS } from "@/lib/canary/chips";
import { CANARY_COPY } from "@/lib/canary/copy";
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

describe("the one-click chips above the textarea", () => {
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

  it("are three buttons in a group (a fieldset) named by its visible label, Try one:, none of them pressed", () => {
    const html = render();
    const group = /<fieldset[^>]*aria-labelledby="([^"]+)"[^>]*>(.*?)<\/fieldset>/.exec(html);
    expect(group).not.toBeNull();
    expect(group?.[2]).toMatch(new RegExp(`^<span[^>]*id="${group?.[1]}"[^>]*>Try one:</span>`));
    const chips = [
      ...(group?.[2] ?? "").matchAll(
        /<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g,
      ),
    ];
    expect(chips.map((m) => decode(m[2] ?? ""))).toEqual(CANARY_CHIPS.map((c) => c.label));
    expect(chips.map((m) => m[1])).toEqual(["false", "false", "false"]);
    for (const m of chips) expect(m[0]).toContain('type="button"');
  });

  it("come before the label and the textarea, with the hint about the model on the line under them", () => {
    const text = visible(render());
    const at = ["Try one:", CANARY_COPY.form.chipsHint, "Your message to the agent"].map((t) =>
      text.indexOf(t),
    );
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(render()).toMatch(/<p[^>]*aria-live="polite"[^>]*>Each one fills in a fixed message\./);
  });

  it("fit the 4,000 characters the textarea and the route accept", () => {
    for (const c of CANARY_CHIPS) {
      expect(c.text.length, c.id).toBeLessThanOrEqual(CANARY_LIMITS.maxTextChars);
    }
  });
});

describe("the chips' CSS", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../site/canary.module.css", import.meta.url)),
    "utf8",
  );
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };

  it("fills a chip in ink only while it is pressed, so the look never disagrees with aria-pressed", () => {
    expect(rule('.pick[aria-pressed="true"]')).toMatch(
      /background: var\(--color-ink\);\s*color: var\(--color-paper\);/,
    );
    // Hover is a soft tint, not the pressed fill, and only where there is hover: a tap on a phone leaves no fill.
    expect(css).not.toMatch(/^\.pick:hover/m);
    expect(css).toMatch(
      /@media \(hover: hover\) \{\s*\.pick:not\(\[aria-pressed="true"\]\):not\(\[aria-disabled="true"\]\):hover \{\s*background: var\(--color-soft\);\s*\}/,
    );
  });

  it("dims a chip while an attempt runs, as the main button is", () => {
    expect(rule('.pick[aria-disabled="true"]')).toMatch(/opacity: 0\.5;\s*cursor: not-allowed;/);
  });
});

describe("the Raw mode tooltip", () => {
  it("is in live mode only: a button described by a role=tooltip element that holds what raw mode does", () => {
    const html = render("live");
    const describedBy = /<button[^>]*aria-describedby="([^"]+)"[^>]*>Raw mode on/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    const tip = new RegExp(`<span role="tooltip" id="${describedBy}"[^>]*>([^<]*)</span>`).exec(
      html,
    );
    expect(tip?.[1]?.replace(/&#x27;/g, "'")).toBe(CANARY_COPY.form.rawTip);
    expect(render("code-only")).not.toContain('role="tooltip"');
  });
});
