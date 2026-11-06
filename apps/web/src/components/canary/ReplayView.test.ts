import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReplayEntry } from "@/lib/canary/replay";
import type { Banner } from "@/lib/canary/view";
import { ReplayView } from "./ReplayView";

const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

const render = (banner: Banner, entries?: ReplayEntry[]) =>
  renderToStaticMarkup(createElement(ReplayView, { banner, entries }));

const ENTRY: ReplayEntry = {
  at: "2026-11-04T12:00:00Z",
  technique: "payee_change",
  summary: "Invoice asks for a new Base address",
  layer: "contract",
  result: "NoMandate",
  tx_hash: "AbC123xyz",
  network: "mainnet",
};

describe("the replay's three banners", () => {
  const rows = " Every row below is a real attempt, with its transaction.";

  it("says the live Canary is paused when the owner turned it off", () => {
    expect(visible(render("off"))).toContain(`The live Canary is paused.${rows}`);
  });

  it("says this is a replay when the owner chose one", () => {
    expect(visible(render("replay"))).toContain(`This is a replay of recorded attacks.${rows}`);
  });

  it("says the live Canary is not open yet when there is no vault or no environment", () => {
    expect(visible(render("closed"))).toContain(`The live Canary is not open yet.${rows}`);
  });

  it("shows exactly one banner, as a status the page announces politely", () => {
    for (const banner of ["off", "replay", "closed"] as const) {
      const html = render(banner);
      expect([...html.matchAll(/role="status"/g)]).toHaveLength(1);
      const text = visible(html);
      const said = ["is paused", "is a replay", "not open yet"].filter((t) => text.includes(t));
      expect(said, banner).toHaveLength(1);
    }
  });
});

describe("the recorded attacks", () => {
  it("says there are none yet, with no table, when the list is empty", () => {
    const html = render("replay", []);
    expect(visible(html)).toContain("No recorded attacks yet.");
    expect(html).not.toContain("<table");
  });

  it("shows the owner's recorded list when it is not given one", () => {
    // The shipped list is empty until the owner records an attack, and says so.
    expect(visible(render("replay"))).toContain("Recorded attacks");
  });

  it("shows each attack: the time in UTC, the technique, what it tried, what stopped it and the transaction", () => {
    const html = render("replay", [ENTRY]);
    expect([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])).toEqual([
      "When (UTC)",
      "Technique",
      "What it tried",
      "Stopped by",
      "Tx",
    ]);
    const text = visible(html);
    expect(text).toContain("2026-11-04 12:00");
    expect(text).toContain("payee_change");
    expect(text).toContain("Invoice asks for a new Base address");
    expect(text).toContain("contract: NoMandate");
    expect(html).toContain('href="https://nearblocks.io/txns/AbC123xyz"');
    expect(html).toMatch(/data-tone="good"/);
  });

  it("links a testnet entry to the testnet explorer, whatever network this build runs on", () => {
    const html = render("replay", [{ ...ENTRY, network: "testnet" }]);
    expect(html).toContain('href="https://testnet.nearblocks.io/txns/AbC123xyz"');
  });

  it("says an entry with no transaction was refused before sending", () => {
    const html = render("replay", [
      { ...ENTRY, layer: "code", result: "mandate.payee_mismatch", tx_hash: null },
    ]);
    expect(visible(html)).toContain("code: mandate.payee_mismatch");
    expect(visible(html)).toContain("no tx (refused before sending)");
    expect(html).not.toContain("nearblocks");
  });

  it("keeps two entries that share a time and a result", () => {
    const html = render("replay", [ENTRY, ENTRY]);
    expect([...html.matchAll(/<tr/g)]).toHaveLength(3);
  });

  it("scrolls the table inside its own panel and labels that panel", () => {
    expect(render("replay", [ENTRY])).toMatch(/<section[^>]*aria-label="Recorded attacks"/);
  });
});
