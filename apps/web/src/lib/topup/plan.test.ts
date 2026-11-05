import { NETWORKS } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { OWNER, vaultConfig } from "../../../test/fixtures/topup";
import { baseCardNotAllowed, baseCardNotConfigured, testnetBaseText } from "./copy";
import { topupPlan } from "./plan";

const main = NETWORKS.mainnet;
const test = NETWORKS.testnet;
const plan = (o: Partial<Parameters<typeof topupPlan>[0]> = {}) =>
  topupPlan({
    network: "mainnet",
    config: vaultConfig("mainnet"),
    account: OWNER,
    consts: main,
    quotesConfigured: true,
    ...o,
  });

describe("what the Top-up tab offers", () => {
  it("offers both on mainnet to the owner of a vault that allows Base USDC, when quotes are set up", () => {
    expect(plan()).toMatchObject({ fund: { offer: true }, base: { offer: true } });
  });

  it("offers only the NEAR USDC funding on testnet, and says what stands in for Intents there", () => {
    const p = plan({ network: "testnet", config: vaultConfig("testnet"), consts: test });
    expect(p.fund).toEqual({ offer: true });
    expect(p.base).toEqual({ offer: false, why: testnetBaseText(test) });
  });

  it("says the testnet text whatever the vault's config, because it is about the network", () => {
    const p = plan({ network: "testnet", config: null, consts: test });
    expect(p.base).toEqual({ offer: false, why: testnetBaseText(test) });
    expect(p.fund.offer).toBe(false);
  });

  it("offers nothing when the vault's config could not be read", () => {
    const p = plan({ config: null });
    expect(p.fund).toEqual({
      offer: false,
      why: "The vault could not be read from NEAR, so nothing is offered here. Try again in a minute.",
    });
    expect(p.base).toEqual(p.fund);
  });

  it("offers nothing when the chain names another owner than the signed-in account", () => {
    const p = plan({ config: { ...vaultConfig("mainnet"), owner: "someone-else.near" } });
    const why =
      "The chain names someone-else.near as this vault's owner, not acme.near, so nothing is offered here.";
    expect(p.fund).toEqual({ offer: false, why });
    expect(p.base).toEqual({ offer: false, why });
  });

  it("does not offer to fund a vault that holds another token than the network's USDC, but may still offer Base", () => {
    const p = plan({ config: { ...vaultConfig("mainnet"), usdc: "other-token.near" } });
    expect(p.fund).toEqual({
      offer: false,
      why: `This vault's token is other-token.near, not this network's USDC (${main.usdc}), so nothing is offered here.`,
    });
    expect(p.base.offer).toBe(true);
  });

  it("does not offer a Base top-up to a vault that does not allow Base USDC", () => {
    const p = plan({ config: { ...vaultConfig("mainnet"), allowed_assets: [] } });
    expect(p.base).toEqual({ offer: false, why: baseCardNotAllowed });
    expect(p.fund.offer).toBe(true);
  });

  it("does not offer a Base top-up where 1Click quotes are not set up", () => {
    expect(plan({ quotesConfigured: false }).base).toEqual({
      offer: false,
      why: baseCardNotConfigured,
    });
  });

  it("opens with the notice for its network", () => {
    expect(plan().notice).toMatch(/real money/);
    expect(
      plan({ network: "testnet", config: vaultConfig("testnet"), consts: test }).notice,
    ).toMatch(/test tokens/);
  });
});
