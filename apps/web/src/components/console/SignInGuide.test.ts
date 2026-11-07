import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Network } from "@/lib/config";
import { createDepositPlan } from "@/lib/near/runway";
import { JustLooking, SignInIntro, TESTNET_VAULT_DEPOSIT_NEAR } from "./SignInGuide";

// What /login says before the wallet list: what signing in is for, what it takes, and a way to look around with no
// wallet (site audit P1-7).
const intro = (network: Network) =>
  renderToStaticMarkup(createElement(SignInIntro, { network })).replaceAll("&#x27;", "'");
const looking = () => renderToStaticMarkup(createElement(JustLooking));
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,:)])/g, "$1")
    .trim();
const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("SignInIntro", () => {
  it("says what signing in is for: a vault, a mandate and a key that can only call spend, or approving a held payment", () => {
    for (const network of ["testnet", "mainnet"] as const) {
      const html = intro(network);
      expect(text(html), network).toContain(
        "Sign in to set up your agent's guardrails: create a vault, sign a mandate, and give your agent a key that can only call spend. A vault's approvers sign in here too, to approve or reject a held payment.",
      );
      expect(html, network).toContain("<code>spend</code>");
    }
  });

  it("says on testnet that it takes a testnet account, and about how much test NEAR a vault keeps", () => {
    expect(text(intro("testnet"))).toContain(
      `You need a NEAR testnet account, such as name.testnet. Creating a vault later takes about ${TESTNET_VAULT_DEPOSIT_NEAR} test NEAR, which stays in the vault for its storage and gas and cannot be withdrawn.`,
    );
  });

  it("says on mainnet that vaults cannot be created there yet, and names no amount or test token", () => {
    const t = text(intro("mainnet"));
    expect(t).toContain(
      "You need a NEAR mainnet account. Vaults cannot be created on mainnet yet: its factory is not deployed.",
    );
    expect(t).not.toMatch(/\d|\btest\b|testnet/);
  });

  it("says the mainnet factory is not deployed only while its record has no deploy and no version", () => {
    // Once the mainnet factory is deployed, this fails: the sentence above then needs the mainnet deposit instead.
    const record = JSON.parse(source("../../../../../contracts/deployments/mainnet.json")) as {
      factory: { deploy_tx: string | null; versions: unknown[] };
    };
    expect(record.factory.deploy_tx).toBeNull();
    expect(record.factory.versions).toEqual([]);
  });

  it("gives the deposit the console asks on testnet, rounded up to a tenth: the min_deposit plus the code storage", () => {
    const record = JSON.parse(source("../../../../../contracts/deployments/testnet.json")) as {
      factory: { min_deposit: string; versions: { mode: "embedded" | "global" }[] };
    };
    // The console plans with the version the factory reports as current_version; the record's last version stands in.
    const latest = record.factory.versions.at(-1);
    expect(latest).toBeDefined();
    const required = createDepositPlan(
      record.factory.min_deposit,
      latest?.mode ?? "global",
      0n,
    ).requiredYocto;
    const near = Number(required) / 1e24;
    expect(TESTNET_VAULT_DEPOSIT_NEAR).toBeGreaterThanOrEqual(near);
    expect(TESTNET_VAULT_DEPOSIT_NEAR - near).toBeLessThan(0.1);
  });
});

describe("JustLooking", () => {
  it("offers the ledger test, which needs no wallet, in this tab", () => {
    const html = looking();
    expect(text(html)).toContain("Just looking? Break a signed record → (no wallet needed)");
    expect(html).toMatch(
      /<a[^>]*href="\/#verify"[^>]*>Break a signed record <span aria-hidden="true">→<\/span><\/a>/,
    );
    expect(html).not.toContain("target=");
  });

  it("links the terms and the privacy notice", () => {
    const html = looking();
    expect(html).toMatch(/<a[^>]*href="\/terms"[^>]*>Terms<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/privacy"[^>]*>Privacy<\/a>/);
    expect(html).toContain('<span aria-hidden="true">·</span>');
  });
});

describe("the sign-in page", () => {
  it("names no wallet, because the list depends on the network", () => {
    for (const html of [intro("testnet"), intro("mainnet"), looking()]) {
      expect(html).not.toMatch(/\b(HOT|Meteor|Intear|MyNearWallet|near-connect)\b/);
    }
  });

  it("says what it is for and what it takes before the wallet list, and the way to look around after it", () => {
    // Read from the source: the page's sign-in button needs a mounted app router to render.
    const page = source("../../app/login/page.tsx");
    const at = (s: string) => {
      const i = page.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at("<SignInIntro network={network} />"),
      at("Your wallet signs a message (NEP-413)."),
      at("<SignInButton next={safeNext} />"),
      at("<JustLooking />"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
