import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "./page";

const html = renderToStaticMarkup(createElement(PrivacyPage));

describe("/privacy", () => {
  it("ends its container with its last section, where plan 06 Task 1 adds the extension's", () => {
    expect(html).toMatch(/<\/section><\/div>$/);
  });

  it("has no browser-extension section of its own", () => {
    expect(html).not.toContain('id="browser-extension"');
  });

  it("says when it was last updated, above the first section", () => {
    const updated = html.indexOf("Last updated");
    expect(updated).toBeGreaterThan(-1);
    expect(updated).toBeLessThan(html.indexOf("<section"));
  });

  it("gives every section the shape the extension's section has", () => {
    const sections =
      html.match(/<section id="[a-z-]+" class="mb-8"><h2 class="mb-2 text-lg font-semibold">/g) ??
      [];
    expect(sections.length).toBe((html.match(/<section/g) ?? []).length);
  });
});
