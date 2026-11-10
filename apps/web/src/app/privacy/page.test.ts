import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "./page";

const html = renderToStaticMarkup(createElement(PrivacyPage));

describe("/privacy", () => {
  it("ends its container with its last section, the browser extension's", () => {
    expect(html).toMatch(/<\/section><\/div>$/);
  });

  it("has the browser extension's section once, as the last section, linking the Browser extension page", () => {
    expect(html.match(/id="browser-extension"/g) ?? []).toHaveLength(1);
    expect(html.lastIndexOf("<section")).toBe(html.indexOf('<section id="browser-extension"'));
    expect(html).toContain('href="/extension"');
    for (const fact of [
      "last four characters",
      "ten minutes",
      "pending Chrome Web Store review",
      "with your own session for that site",
      "set to end and revoked",
      "its record is deleted the next time a code is made, for anyone",
      "a sixth connection on the same network ends the oldest one",
    ]) {
      expect(html, fact).toContain(fact);
    }
    // The sweep is the first statement of ext_code_create (migration 0013): it runs only when a code is made.
    expect(html).not.toContain("anyone asks for a code");
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
