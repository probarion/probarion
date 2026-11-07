import { NETWORKS } from "@probarion/core";
import { KeyPair } from "near-api-js";
import { notFound } from "next/navigation";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestUsdcFaucet } from "@/components/console/TestUsdcFaucet";
import { faucetCopy, testnetBaseText } from "@/lib/topup/copy";
import { OWNER, VAULT, vaultConfig } from "../../../../../test/fixtures/topup";

const h = vi.hoisted(() => ({
  network: "mainnet" as "mainnet" | "testnet",
  jwt: "" as string | null,
  faucetKey: null as string | null,
  /** The signed-in account's role in the vault, or null for a stranger. */
  role: "owner" as "owner" | "approver" | "viewer" | null,
  account: "acme.near",
  config: null as unknown,
  configError: null as null | Error,
  reads: 0,
  buttons: [] as { label: string; expectedSigner?: string; lockKey?: string }[],
}));

vi.mock("@/lib/auth/guard", () => ({
  requireMember: async (vault: string, roles?: string[]) => {
    if (h.role === null || (roles && !roles.includes(h.role))) notFound();
    return {
      session: { accountId: h.account },
      member: { vault_id: vault, role: h.role, tenant_id: "t-1", network: h.network },
    };
  },
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ ONECLICK_JWT: h.jwt, TESTNET_FAUCET_KEY: h.faucetKey }),
}));
vi.mock("@/lib/near/server", async () => {
  const { NETWORKS: networks } = await import("@probarion/core");
  return {
    chainConsts: () => networks[h.network],
    getReader: () => ({
      getConfig: async () => {
        h.reads++;
        if (h.configError) throw h.configError;
        return h.config;
      },
    }),
  };
});
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
// The wallet button needs the browser wallet; here it only shows what it would sign.
vi.mock("@/components/wallet/TxButton", () => ({
  TxButton: (p: (typeof h.buttons)[number]) => {
    h.buttons.push(p);
    return createElement("button", { type: "button" }, p.label);
  },
}));

const { default: TopUpPage, maxDuration, metadata } = await import("./page");

const JWT = "jwt-page-secret";
/** A real secret key: the page shows the button only for a key the route can sign with. */
const FAUCET_KEY = KeyPair.fromRandom("ed25519").toString();
const FAUCET = faucetCopy("25");
const html = async () =>
  renderToStaticMarkup(await TopUpPage({ params: Promise.resolve({ vault: VAULT }) }));
/** Every element of `type` in the tree the page returns, before rendering: what a client component is handed. */
function elementsOf(node: ReactNode, type: unknown): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((n) => elementsOf(n, type));
  if (!isValidElement(node)) return [];
  const { children } = node.props as { children?: ReactNode };
  return [...(node.type === type ? [node] : []), ...elementsOf(children, type)];
}
const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

beforeEach(() => {
  h.network = "mainnet";
  h.jwt = JWT;
  h.faucetKey = FAUCET_KEY;
  h.role = "owner";
  h.account = OWNER;
  h.config = vaultConfig("mainnet");
  h.configError = null;
  h.reads = 0;
  h.buttons.length = 0;
});

describe("the Top-up page", () => {
  it("allows 60 s for the wallet buttons' chain confirmation, and is called Top-up", () => {
    expect(maxDuration).toBe(60);
    expect(metadata).toEqual({ title: "Top-up" });
  });

  it("answers a stranger with a 404, and reads nothing", async () => {
    h.role = null;
    await expect(html()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    expect(h.reads).toBe(0);
  });

  it.each(["approver", "viewer"] as const)(
    "tells a %s that only the owner tops up, and offers nothing",
    async (role) => {
      h.role = role;
      const out = await html();
      expect(text(out)).toContain("Only this vault's owner can top it up.");
      expect(text(out)).toContain(`you are ${role}`);
      expect(out).not.toContain("<input");
      expect(h.buttons).toEqual([]);
      expect(h.reads).toBe(0);
    },
  );

  it("offers the owner both top-ups on mainnet", async () => {
    const out = await html();
    const t = text(out);
    expect(t).toContain("USDC on NEAR (for NEAR payees)");
    expect(t).toContain("Base USDC inside NEAR Intents (for Base payees)");
    expect(t).toContain("A top-up moves real money out of your wallet.");
    expect(t).toContain(`Token: ${NETWORKS.mainnet.usdc}`);
    expect(t).toContain("Get a 1Click quote");
    expect(h.buttons).toEqual([
      {
        label: "Send USDC to the vault from my wallet",
        network: "mainnet",
        expectedSigner: OWNER,
        prepare: expect.any(Function),
        lockKey: `probarion:txlock:fund-usdc:${VAULT}`,
      },
    ]);
  });

  it("renders no empty paragraph in either card, whatever is offered", async () => {
    const cases: [typeof h.network, unknown, string | null][] = [
      ["mainnet", vaultConfig("mainnet"), JWT],
      ["mainnet", vaultConfig("mainnet"), null],
      ["mainnet", { ...vaultConfig("mainnet"), allowed_assets: [] }, JWT],
      ["mainnet", { ...vaultConfig("mainnet"), usdc: "other.near" }, JWT],
      ["testnet", vaultConfig("testnet"), JWT],
      ["mainnet", null, JWT],
    ];
    for (const [network, config, jwt] of cases) {
      h.network = network;
      h.config = config;
      h.configError = config === null ? new Error("down") : null;
      h.jwt = jwt;
      const out = await html();
      expect(out).not.toMatch(/<p[^>]*><\/p>/);
      expect(out).not.toMatch(/<p[^>]*>\s+<\/p>/);
    }
  });

  it("never puts the partner JWT in the page", async () => {
    expect(await html()).not.toContain(JWT);
  });

  it("on testnet offers only the funding in NEAR USDC, and says what stands in for Intents", async () => {
    h.network = "testnet";
    h.config = vaultConfig("testnet");
    const out = await html();
    const t = text(out);
    expect(t).toContain("This is testnet, so the tokens here are test tokens.");
    expect(t).toContain("Amount (test USDC)");
    expect(t).toContain(`Token: ${NETWORKS.testnet.usdc}`);
    expect(t).toContain(testnetBaseText(NETWORKS.testnet));
    expect(t).not.toContain("Get a 1Click quote");
    expect(t).not.toContain("real money");
    expect(h.buttons.map((b) => b.label)).toEqual(["Send USDC to the vault from my wallet"]);
  });

  it("points at no page that is not built", async () => {
    for (const network of ["mainnet", "testnet"] as const) {
      h.network = network;
      h.config = vaultConfig(network);
      const out = await html();
      expect(out).not.toContain("/security");
      const links = [...out.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1] ?? "");
      expect(links).toContain(`/console/${VAULT}/topup`);
      // the Alerts tab is built, so its link is there
      expect(links).toContain(`/console/${VAULT}/alerts`);
      for (const planned of ["/status", "/canary", "/terms", "/privacy"]) {
        expect(links.filter((l) => l.endsWith(planned))).toEqual([]);
      }
    }
  });

  it("does not offer the Base top-up without a partner JWT", async () => {
    h.jwt = null;
    const t = text(await html());
    expect(t).toContain("1Click quotes are not set up on this server");
    expect(t).not.toContain("Get a 1Click quote");
  });

  it("does not offer the Base top-up to a vault that does not allow Base USDC", async () => {
    h.config = { ...vaultConfig("mainnet"), allowed_assets: [] };
    const t = text(await html());
    expect(t).toContain("This vault does not allow Base USDC");
    expect(t).not.toContain("Get a 1Click quote");
    expect(t).toContain("Send USDC to the vault from my wallet");
  });

  it("offers nothing, and says so, when the vault cannot be read or the chain names another owner", async () => {
    h.configError = new Error("all RPC endpoints failed");
    let t = text(await html());
    expect(t).toContain("The vault could not be read from NEAR, so nothing is offered here.");
    h.configError = null;
    h.config = { ...vaultConfig("mainnet"), owner: "someone-else.near" };
    t = text(await html());
    expect(t).toContain("The chain names someone-else.near as this vault's owner, not acme.near");
    for (const gone of ["Get a 1Click quote", "Send USDC to the vault from my wallet"]) {
      expect(t).not.toContain(gone);
    }
    expect(h.buttons).toEqual([]);
  });

  it("on testnet offers the owner the faucet above the wallet button, and keeps the wallet button", async () => {
    h.network = "testnet";
    h.config = vaultConfig("testnet");
    const out = await html();
    const t = text(out);
    expect(t).toContain("Add 25 test USDC to this vault");
    expect(t).toContain("Test tokens from the Probarion team, no value. Once a day per vault.");
    expect(t).toContain(FAUCET.signer);
    expect(t).toContain("Add test USDC");
    expect(t.indexOf(FAUCET.title)).toBeLessThan(t.indexOf("Amount (test USDC)"));
    expect(t).not.toContain(FAUCET.fallback);
    expect(h.buttons.map((b) => b.label)).toEqual(["Send USDC to the vault from my wallet"]);
    expect(out).not.toContain(FAUCET_KEY);
    expect(out).not.toContain(FAUCET_KEY.slice(8, 40));
  });

  it("hands the faucet button only the vault, its words and whether it is set up: never the key", async () => {
    h.network = "testnet";
    h.config = vaultConfig("testnet");
    const tree = await TopUpPage({ params: Promise.resolve({ vault: VAULT }) });
    const [faucet, ...more] = elementsOf(tree, TestUsdcFaucet);
    expect(more).toEqual([]);
    expect(faucet?.props).toEqual({ vault: VAULT, copy: FAUCET, configured: true });
    expect(JSON.stringify(faucet?.props)).not.toContain(FAUCET_KEY.slice(8, 40));
  });

  it("on testnet without a faucet key, or with one that is not a key, says whom to ask and offers no button", async () => {
    h.network = "testnet";
    h.config = vaultConfig("testnet");
    for (const key of [null, "ed25519:not-a-key"]) {
      h.faucetKey = key;
      const t = text(await html());
      expect(t).toContain(FAUCET.fallback);
      expect(t).not.toContain("Add test USDC");
      expect(t).toContain("Send USDC to the vault from my wallet");
    }
  });

  it("offers no faucet on mainnet, to a vault of another token, or when the chain names another owner", async () => {
    let t = text(await html());
    expect(t).not.toContain("test USDC to this vault");
    expect(t).not.toContain(FAUCET.fallback);
    h.network = "testnet";
    for (const config of [
      { ...vaultConfig("testnet"), usdc: "other-usdc.testnet" },
      { ...vaultConfig("testnet"), owner: "someone-else.testnet" },
    ]) {
      h.config = config;
      t = text(await html());
      expect(t).not.toContain("Add test USDC");
      expect(t).not.toContain(FAUCET.fallback);
    }
  });
});
