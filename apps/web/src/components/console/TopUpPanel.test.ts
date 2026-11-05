import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TopUpPanel } from "./TopUpPanel";

const html = renderToStaticMarkup(
  createElement(TopUpPanel, {
    vault: "acme.vaults.probarion.near",
    owner: "acme.near",
    network: "mainnet",
  }),
);

describe("the Base top-up panel before a quote is asked for", () => {
  it("shows the amount field with its range, and a quote button that can be pressed", () => {
    expect(html).toContain('value="20"');
    expect(html).toContain("Between 1 and 1000 USDC per top-up.");
    expect(html).toMatch(/<button[^>]*>Get a 1Click quote<\/button>/);
    expect(html).not.toContain('disabled=""'); // the button's class names a disabled style, which is not the attribute
  });

  it("shows no green badge, no wallet button and no 1Click status: there is nothing verified yet", () => {
    expect(html).not.toContain("bg-emerald");
    expect(html).not.toContain("Signature verified");
    expect(html).not.toContain("Sign the deposit");
    expect(html).not.toContain("1Click status");
  });
});
