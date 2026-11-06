import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VaultOnOtherNetwork, type VaultOnOtherNetworkProps } from "./VaultOnOtherNetwork";

// The card a member sees instead of the page of a vault that is registered on the other network (W-NET-R4).
const VAULT = "acme.vaults.probarion.near";
const render = (props: VaultOnOtherNetworkProps) =>
  renderToStaticMarkup(createElement(VaultOnOtherNetwork, props)).replaceAll("&#x27;", "'");
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("VaultOnOtherNetwork", () => {
  it("says which network the vault is on, which console this is, and what to do", () => {
    const html = render({
      vaultId: VAULT,
      vaultNetwork: "mainnet",
      requestNetwork: "testnet",
      href: `https://mainnet.probarion.xyz/console/${VAULT}`,
    });
    const t = text(html);
    expect(t).toContain("This vault is on NEAR mainnet");
    expect(t).toContain(
      "You are on the testnet console. Open it at the mainnet address and sign in there with your mainnet wallet.",
    );
    expect(t).toContain(VAULT);
  });

  it("offers a secondary button to the vault at its own address, with the arrow", () => {
    const html = render({
      vaultId: VAULT,
      vaultNetwork: "mainnet",
      requestNetwork: "testnet",
      href: `https://mainnet.probarion.xyz/console/${VAULT}`,
    });
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/mainnet\.probarion\.xyz\/console\/acme\.vaults\.probarion\.near"[^>]*>Open on mainnet <span aria-hidden="true">↗<\/span><\/a>/,
    );
    // The secondary button of the site (the line pill), not the primary ink one.
    expect(html).toMatch(/<a [^>]*class="[^"]*border-ink\/15[^"]*"/);
    expect([...html.matchAll(/<a\b/g)]).toHaveLength(1);
  });

  it("swaps the names for the other direction", () => {
    const html = render({
      vaultId: "acme.vaults.probarion.testnet",
      vaultNetwork: "testnet",
      requestNetwork: "mainnet",
      href: "https://testnet.probarion.xyz/console/acme.vaults.probarion.testnet",
    });
    const t = text(html);
    expect(t).toContain("This vault is on NEAR testnet");
    expect(t).toContain(
      "You are on the mainnet console. Open it at the testnet address and sign in there with your testnet wallet.",
    );
    expect(t).toContain("Open on testnet");
    expect(t).not.toMatch(/Open on mainnet|mainnet wallet/);
  });

  it("has no button, and says the network is not served yet, when this site has no address for it", () => {
    for (const [vaultNetwork, requestNetwork] of [
      ["mainnet", "testnet"],
      ["testnet", "mainnet"],
    ] as const) {
      const html = render({ vaultId: VAULT, vaultNetwork, requestNetwork, href: null });
      const t = text(html);
      expect(t).toContain(`This vault is on NEAR ${vaultNetwork}`);
      expect(t).toContain(
        `You are on the ${requestNetwork} console. NEAR ${vaultNetwork} is not served by this site yet.`,
      );
      expect(html).not.toContain("<a ");
      expect(t).not.toContain("Open on");
      expect(t).not.toContain("sign in there");
    }
  });
});
