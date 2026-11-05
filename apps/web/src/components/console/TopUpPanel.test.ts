import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

// What the static render above cannot show, because it needs a browser and a wallet: the wiring that keeps a
// signature, an unconfirmed deposit and a new quote request from stepping on each other. The decisions are tested in
// lib/topup/panel.test.ts and block.test.ts; this holds the component to using them.
describe("the Base top-up panel's wiring", () => {
  const source = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "TopUpPanel.tsx"),
    "utf8",
  );

  it("keys the wallet button by deposit address, so a result is never shown under another quote", () => {
    expect(source).toContain("key={quoted.quote.depositAddress}");
  });

  it("keys the double-sign lock by the vault, so a new quote does not end an unconfirmed send's lock", () => {
    expect(source).toMatch(/lockKey=\{lockKeyFor\(`topup-intents:\$\{vault\}`\)\}/);
  });

  it("switches the quote request off while the wallet is open, and the sign button off for a blocked quote", () => {
    expect(source).toContain('onBusyChange={(busy) => dispatch({ type: "signing", busy })}');
    expect(source).toMatch(/disabled=\{requesting \|\| state\.signing \|\| "problem" in parsed\}/);
    expect(source).toContain("<fieldset disabled={block !== null}");
  });

  it("asks the reducer, not a flag of its own, whether the quote may be signed", () => {
    expect(source).toContain("blockOf(state, amount, now)");
    expect(source).not.toMatch(/attempted/);
  });

  it("words the landed transfer through describeDeposit, and tells 1Click only what onDepositResult allows", () => {
    expect(source).toContain("describe={describeDeposit}");
    expect(source).toContain("onDepositResult(result).submit");
  });
});
