import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CURATED_MANIFEST } from "@/components/wallet/manifest";
import type { Network } from "@/lib/config";
import { DEMO_VIDEO, METEOR_WEB, NEAR_FAUCET, NoAccountYet, WithoutWallet } from "./first-steps";

// What /login offers someone who cannot sign in yet (plan F11): an account and test NEAR on testnet, and a way to see
// Probarion work with no wallet.
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noAccount = (network: Network) => html(createElement(NoAccountYet, { network }));
const without = () => html(createElement(WithoutWallet));
const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const anchors = (h: string) =>
  [...h.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gs)].map((m) => ({
    href: /href="([^"]*)"/.exec(m[1] ?? "")?.[1],
    newTab: (m[1] ?? "").includes('target="_blank"'),
    words: text(m[2] ?? ""),
  }));
const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("no testnet account yet", () => {
  it("on testnet, says where to create one and where to get test NEAR, each in a new tab", () => {
    const h = noAccount("testnet");
    expect(text(h)).toBe(
      "No testnet account? Create one in Meteor Wallet (opens in a new tab) · get test NEAR (opens in a new tab)",
    );
    expect(anchors(h)).toEqual([
      { href: METEOR_WEB, newTab: true, words: "Create one in Meteor Wallet (opens in a new tab)" },
      { href: NEAR_FAUCET, newTab: true, words: "get test NEAR (opens in a new tab)" },
    ]);
  });

  it("says nothing on mainnet, where a testnet account does not help", () => {
    expect(noAccount("mainnet")).toBe("");
  });

  it("names a wallet the testnet list offers, at the address the list gives it", () => {
    const meteor = CURATED_MANIFEST.wallets.find((w) => w.name === "Meteor Wallet");
    expect(meteor?.features.testnet).toBe(true);
    expect(meteor?.platform.web).toBe(METEOR_WEB);
  });

  it("links the faucet service the owner quickstart names, on NEAR's own docs", () => {
    expect(NEAR_FAUCET).toMatch(/^https:\/\/docs\.near\.org\//);
    const quickstart = source("../../../content/docs/start/owner-quickstart.mdx");
    expect(quickstart).toContain(
      "Probarion does not hand out test NEAR. NEAR's faucet service funds new testnet accounts",
    );
  });
});

describe("without a wallet", () => {
  it("links the proof page in this tab and the demo video in a new one", () => {
    const h = without();
    expect(text(h)).toBe("See it without a wallet → or watch the demo video (opens in a new tab)");
    expect(anchors(h)).toEqual([
      { href: "/proof", newTab: false, words: "See it without a wallet →" },
      { href: DEMO_VIDEO, newTab: true, words: "watch the demo video (opens in a new tab)" },
    ]);
    expect(h).toContain('<span aria-hidden="true">→</span>');
  });

  it("is the demo video the README links", () => {
    expect(source("../../../../../README.md")).toContain(`**[Demo video](${DEMO_VIDEO})**`);
  });
});

describe("the sign-in page", () => {
  it("puts the account line under what signing in takes, and the no-wallet line between the wallet list and the ledger test", () => {
    const page = source("./page.tsx");
    const at = (s: string) => {
      const i = page.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at("<SignInIntro network={network} />"),
      at("<NoAccountYet network={network} />"),
      at("Your wallet signs a message (NEP-413)."),
      at("<SignInButton next={safeNext} />"),
      at("<WithoutWallet />"),
      at("<JustLooking />"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("uses no word the site's copy rules keep out", () => {
    for (const h of [noAccount("testnet"), without()]) {
      // An em dash or an en dash, written as escapes so that this file has none either.
      expect(text(h)).not.toMatch(/\bnever\b|guarantee|\bonly\b|\bfirst\b|\u2014|\u2013/i);
    }
  });
});
