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
  const rows = " Each row is a recorded attempt, with its transaction when one was sent.";
  const banner = (html: string) => /<p[^>]*role="status"[^>]*>(.*?)<\/p>/.exec(html)?.[1] ?? "";

  it("says the live Canary is paused when the owner turned it off", () => {
    expect(visible(render("off", [ENTRY]))).toContain(`The live Canary is paused.${rows}`);
  });

  it("says this is a replay when the owner chose one", () => {
    expect(visible(render("replay", [ENTRY]))).toContain(
      `This is a replay of recorded attacks.${rows}`,
    );
  });

  it("is its first sentence alone, then No recorded attacks yet, when the list is empty", () => {
    const expected = {
      off: "The live Canary is paused.",
      replay: "This is a replay of recorded attacks.",
      closed: "The live Canary is not open yet.",
    } as const;
    for (const b of ["off", "replay", "closed"] as const) {
      const html = render(b, []);
      expect(visible(banner(html)).trim(), b).toBe(expected[b]);
      expect(visible(html), b).not.toContain("Each row");
      expect(visible(html), b).not.toContain("Every row");
      expect(visible(html), b).toContain(
        `${expected[b]} Recorded attacks No recorded attacks yet.`,
      );
    }
  });

  it("says each row is a recorded attempt, and a transaction only when one was sent", () => {
    expect(visible(render("replay", [ENTRY]))).toContain(
      "Each row is a recorded attempt, with its transaction when one was sent.",
    );
    expect(visible(render("replay", [ENTRY]))).not.toContain("Every row below");
  });

  it("says the live Canary is not open yet when there is no vault or no environment", () => {
    expect(visible(render("closed", [ENTRY]))).toContain(`The live Canary is not open yet.${rows}`);
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
