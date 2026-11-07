import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReplayEntry } from "@/lib/canary/replay";
import type { Banner } from "@/lib/canary/view";
import { LINKS } from "@/lib/site/facts";
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
  network: "testnet",
};

const BANNERS = {
  off: "The live Canary is paused.",
  replay: "This is a replay of recorded attacks.",
  closed: "The live Canary is not open yet.",
  full: "The live Canary is closed: its ledger is full.",
} as const;
const banners = Object.keys(BANNERS) as Banner[];

describe("the replay's four banners", () => {
  const banner = (html: string) => /<p[^>]*role="status"[^>]*>(.*?)<\/p>/.exec(html)?.[1] ?? "";

  it("says why the live Canary is not shown, then that the rows come from the team's own tests", () => {
    for (const b of banners) {
      expect(visible(banner(render(b, [ENTRY]))).trim(), b).toBe(
        `${BANNERS[b]} Below is an attack from our own tests on testnet, with what stopped it.`,
      );
    }
  });

  it("counts the attacks and names each network they ran on", () => {
    const two = render("closed", [ENTRY, { ...ENTRY, network: "mainnet" }]);
    expect(visible(banner(two)).trim()).toBe(
      `${BANNERS.closed} Below are 2 attacks from our own tests on testnet and mainnet, each with what stopped it.`,
    );
  });

  it("is its first sentence alone when the list is empty", () => {
    for (const b of banners) {
      expect(visible(banner(render(b, []))).trim(), b).toBe(BANNERS[b]);
    }
  });

  it("shows exactly one banner, as a status the page announces politely", () => {
    for (const b of banners) {
      const html = render(b);
      expect([...html.matchAll(/role="status"/g)]).toHaveLength(1);
      const text = visible(html);
      const said = Object.values(BANNERS).filter((t) => text.includes(t));
      expect(said, b).toEqual([BANNERS[b]]);
    }
  });
});

describe("what a visitor can do meanwhile", () => {
  it("offers the ledger test, which needs no wallet, and the X account, in every state", () => {
    for (const b of banners) {
      for (const entries of [[], [ENTRY]]) {
        const html = render(b, entries);
        expect(visible(html), b).toContain(
          "Meanwhile: Break a signed record (no wallet needed) · Follow @probarionhq (opens in a new tab) on X for news of the live Canary.",
        );
        expect(html).toMatch(/<a[^>]*href="\/#verify"[^>]*>Break a signed record<\/a>/);
        expect(html).toContain(`href="${LINKS.x}"`);
      }
    }
  });

  it("keeps the links out of the status, so a screen reader hears the banner alone", () => {
    const status =
      /<p[^>]*role="status"[^>]*>(.*?)<\/p>/.exec(render("closed", [ENTRY]))?.[1] ?? "";
    expect(status).not.toContain("<a");
  });
});

describe("the recorded attacks", () => {
  it("shows no card and no table when the list is empty", () => {
    const html = render("replay", []);
    expect(visible(html)).not.toContain("Recorded attacks");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<h2");
  });

  it("shows the shipped list when it is not given one", () => {
    expect(visible(render("closed"))).toContain("Recorded attacks");
    expect(render("closed")).toContain("<table");
  });

  it("shows each attack: the time in UTC, the technique, what it tried, what stopped it and the transaction", () => {
    const html = render("replay", [{ ...ENTRY, network: "mainnet" }]);
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

  it("links a testnet entry to the testnet explorer, whatever network the page is opened at", () => {
    const html = render("replay", [ENTRY]);
    expect(html).toContain('href="https://testnet.nearblocks.io/txns/AbC123xyz"');
  });

  it("says an entry with no transaction was refused before sending", () => {
    const html = render("replay", [
      { ...ENTRY, layer: "code", result: "invoice.duplicate", tx_hash: null },
    ]);
    expect(visible(html)).toContain("code: invoice.duplicate");
    expect(visible(html)).toContain("no tx (refused before sending)");
    expect(html).not.toContain("nearblocks");
  });

  it("scopes every column header to its column", () => {
    const heads = [...render("replay", [ENTRY]).matchAll(/<th\b[^>]*>/g)].map((m) => m[0]);
    expect(heads).toHaveLength(5);
    expect(heads.filter((h) => !h.includes('scope="col"'))).toEqual([]);
  });

  // renderToStaticMarkup does not report a duplicate React key (probed: no console.error for two equal keys), so this
  // checks the rows and not the keys. The key is built from the time, the result and the position (ReplayView.tsx).
  it("draws two entries that share a time and a result as two rows", () => {
    const html = render("replay", [ENTRY, ENTRY]);
    expect([...html.matchAll(/<tr/g)]).toHaveLength(3);
  });

  it("scrolls the table inside its own panel and labels that panel", () => {
    expect(render("replay", [ENTRY])).toMatch(/<section[^>]*aria-label="Recorded attacks"/);
  });
});
