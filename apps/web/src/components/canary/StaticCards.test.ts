import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Network } from "@/lib/config";
import { ByConstructionCard, SideCards } from "./StaticCards";

const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("the paid-to-an-attacker card", () => {
  const html = renderToStaticMarkup(createElement(ByConstructionCard));
  const text = visible(html);

  it("says zero, by construction, and why, in the owner's words", () => {
    expect(text).toContain("Paid to an attacker: 0, by construction");
    expect(text).toContain(
      "A spend request has no address field. The contract pays the payee stored in the mandate, and only the owner's wallet sets it.",
    );
  });

  it("links to the landing page's explanation of it", () => {
    expect(html).toMatch(/<a[^>]*href="\/#payee"[^>]*>How the site shows this<\/a>/);
  });

  it("is fixed text: it shows no number that could be a measurement", () => {
    expect(text.replace("Paid to an attacker: 0, by construction", "")).not.toMatch(/\b\d+\b/);
  });
});

describe("the two cards side by side", () => {
  const render = (network: Network) => renderToStaticMarkup(createElement(SideCards, { network }));

  it("tells what happened to Freysa, with the figures that were reported, and says convincing this model wins nothing", () => {
    const text = visible(render("testnet"));
    expect(text).toContain("Why this is not Freysa");
    expect(text).toContain(
      "In November 2024, Freysa guarded a pool of ETH with a model told never to transfer it. On the 482nd attempt, a player won 13.19 ETH (about $47,000) by convincing it that its transfer function handled incoming payments. Here, convincing the model wins nothing: it only proposes.",
    );
  });

  it("says what the page does not show, in the owner's words, at the testnet address", () => {
    expect(visible(render("testnet"))).toContain(
      "What this page does not show IPv6 visitors count per /64 network, so one large network can look like many visitors. The hourly caps are shared, so a visitor with many network addresses can use them up for everyone. This runs on testnet, and no third party has audited the code.",
    );
  });

  it("names the network of the address the page is opened at", () => {
    expect(visible(render("mainnet"))).toContain(
      "This runs on mainnet, and no third party has audited the code.",
    );
    expect(visible(render("mainnet"))).not.toContain("on testnet");
  });

  it("names no other incident than Freysa", () => {
    const text = visible(render("testnet"));
    expect(text).not.toMatch(/hack|exploit|stolen|DAO|bridge/i);
  });

  it("is two cards", () => {
    expect([...render("testnet").matchAll(/<h2/g)]).toHaveLength(2);
  });
});
