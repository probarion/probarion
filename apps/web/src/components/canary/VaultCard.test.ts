import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { VaultSummary } from "@/lib/canary/vault";
import type { Network } from "@/lib/config";
import { VaultCard } from "./VaultCard";

/** The text a visitor reads: a block ends a sentence, an inline element (the payee in mono, a link) does not. */
const visible = (html: string) =>
  html
    .replace(/<\/?(?:p|h2|h3|section|div|li)\b[^>]*>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const VAULT = "canary.vaults.probarion.testnet";

const summary = (over: Partial<VaultSummary> = {}): VaultSummary => ({
  balance: "25.5",
  base: null,
  mandate: {
    kind: "active",
    count: 1,
    payee: "canary-payee.probarion.testnet",
    maxPerPayment: "1",
    holdsEverySpend: true,
  },
  frozen: false,
  ...over,
});

const render = (s: VaultSummary, network: Network = "testnet") =>
  renderToStaticMarkup(createElement(VaultCard, { network, vault: VAULT, summary: s }));

describe("the vault card", () => {
  it("shows the balance as test USDC on testnet and USDC on mainnet", () => {
    expect(visible(render(summary()))).toContain("25.5 test USDC");
    expect(visible(render(summary(), "mainnet"))).toContain("25.5 USDC");
    expect(visible(render(summary(), "mainnet"))).not.toContain("test USDC");
  });

  it("links the vault to the explorer of its network", () => {
    expect(render(summary())).toContain(`href="https://testnet.nearblocks.io/address/${VAULT}"`);
    expect(render(summary(), "mainnet")).toContain(`href="https://nearblocks.io/address/${VAULT}"`);
    expect(visible(render(summary()))).toContain(`Vault ${VAULT}`);
  });

  it("says the only mandate pays its payee, up to its limit, and holds every spend for a human", () => {
    expect(visible(render(summary()))).toContain(
      "Its only mandate pays canary-payee.probarion.testnet, at most 1 test USDC per payment, and holds every spend for a human.",
    );
  });

  it("leaves the human out when the mandate lets small spends through", () => {
    const s = summary({
      mandate: {
        kind: "active",
        count: 1,
        payee: "p.testnet",
        maxPerPayment: "1",
        holdsEverySpend: false,
      },
    });
    const text = visible(render(s));
    expect(text).toContain("at most 1 test USDC per payment.");
    expect(text).not.toContain("holds every spend");
  });

  it("shows a Base payee as base:<address>", () => {
    const s = summary({
      mandate: {
        kind: "active",
        count: 1,
        payee: "base:0xabc",
        maxPerPayment: "1",
        holdsEverySpend: true,
      },
    });
    expect(visible(render(s))).toContain("pays base:0xabc");
  });

  it("does not call a mandate the only one when there are several", () => {
    const s = summary({
      mandate: {
        kind: "active",
        count: 2,
        payee: "a.testnet",
        maxPerPayment: "1",
        holdsEverySpend: true,
      },
    });
    const text = visible(render(s));
    expect(text).toContain("It has 2 active mandates. The first pays a.testnet");
    expect(text).not.toContain("Its only mandate");
  });

  it("says there is no active mandate, rather than naming a payee", () => {
    const text = visible(render(summary({ mandate: { kind: "none" } })));
    expect(text).toContain("It has no active mandate right now.");
    expect(text).not.toContain("Its only mandate");
  });

  it("shows the Base balance in Intents only when there is one", () => {
    expect(visible(render(summary({ base: "5" })))).toContain(
      "plus 5 test USDC for Base payees, held in Intents",
    );
    expect(visible(render(summary()))).not.toContain("Base payees");
  });

  it("says it could not read the chain, and shows no zero, when a read failed", () => {
    const text = visible(
      render({ balance: null, base: null, mandate: { kind: "unreadable" }, frozen: false }),
    );
    expect(text.match(/Could not read the chain right now/g)).toHaveLength(2);
    expect(text).not.toContain(" 0 ");
    expect(text).not.toContain("USDC");
  });

  it("still shows a balance that was read when the mandates could not be", () => {
    const text = visible(render(summary({ mandate: { kind: "unreadable" } })));
    expect(text).toContain("25.5 test USDC");
    expect(text.match(/Could not read the chain right now/g)).toHaveLength(1);
  });

  it("shows a zero balance that was read as zero", () => {
    expect(visible(render(summary({ balance: "0" })))).toContain("0 test USDC");
  });

  it("says the owner froze the vault, and only when it is frozen", () => {
    const FROZEN =
      "Frozen by its owner: the vault refuses every spend and every approval until the owner unfreezes it.";
    expect(visible(render(summary({ frozen: true })))).toContain(FROZEN);
    expect(visible(render(summary()))).not.toContain("Frozen");
  });
});
