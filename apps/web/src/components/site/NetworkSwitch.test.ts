import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NetworkSwitchModel } from "@/lib/site/network";
import { elements, mount, textOf } from "../../../test/fixtures/mini-react";

// The switch in the header and in the phone menu (W-NET-R6): what it renders for a model, and when the model exists. The
// hooks run as plain functions (test/fixtures/mini-react.ts), the way the other client components are tested.
const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  ...(await import("../../../test/fixtures/mini-react")).hooks,
}));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

import { BetaStrip, BetaStripView } from "./BetaStrip";
import { NetworkSwitch, NetworkSwitchView } from "./NetworkSwitch";
import { SiteHeader } from "./SiteHeader";

const MAINNET = "https://mainnet.probarion.test";
const TESTNET = "https://testnet.probarion.test";

const onTestnet: NetworkSwitchModel = {
  current: "testnet",
  other: "mainnet",
  href: `${MAINNET}/usage`,
};
const onMainnet: NetworkSwitchModel = {
  current: "mainnet",
  other: "testnet",
  href: `${TESTNET}/usage`,
};
const markup = (model: NetworkSwitchModel | null, variant: "pill" | "menu") =>
  renderToStaticMarkup(createElement(NetworkSwitchView, { model, variant }));
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the header's pair", () => {
  it("shows nothing when the other network is not served", () => {
    expect(markup(null, "pill")).toBe("");
    expect(markup(null, "menu")).toBe("");
  });

  it("on testnet: Testnet filled with aria-current and no link, Mainnet a link to its address with an arrow", () => {
    const html = markup(onTestnet, "pill");
    expect(text(html)).toBe("Testnet Mainnet ↗");
    // Testnet is the current network: a span with aria-current, not a link.
    expect(html).toMatch(/<span[^>]*aria-current="true"[^>]*>Testnet<\/span>/);
    expect(html).not.toMatch(/<a[^>]*>\s*Testnet/);
    // Mainnet is the quiet link to the other origin.
    expect(html).toMatch(new RegExp(`<a[^>]*href="${MAINNET}/usage"[^>]*>Mainnet `));
    expect(html).toMatch(/<span aria-hidden="true">↗<\/span>/);
    expect([...html.matchAll(/aria-current/g)]).toHaveLength(1);
    expect([...html.matchAll(/<a\b/g)]).toHaveLength(1);
  });

  it("on mainnet: the same pair in the same order, Mainnet current and Testnet the link", () => {
    const html = markup(onMainnet, "pill");
    expect(text(html)).toBe("Testnet ↗ Mainnet");
    expect(html).toMatch(/<span[^>]*aria-current="true"[^>]*>Mainnet<\/span>/);
    expect(html).toMatch(new RegExp(`<a[^>]*href="${TESTNET}/usage"[^>]*>Testnet `));
    expect([...html.matchAll(/<a\b/g)]).toHaveLength(1);
  });

  it("is a labelled list, so a screen reader hears one group of two", () => {
    const html = markup(onTestnet, "pill");
    expect(html).toMatch(/^<ul [^>]*aria-label="Network"/);
    expect([...html.matchAll(/<li\b/g)]).toHaveLength(2);
  });
});

describe("the phone menu's last row", () => {
  it("reads 'Network: Testnet' on the left and the other network as a link on the right", () => {
    const html = markup(onTestnet, "menu");
    expect(text(html)).toBe("Network: Testnet Mainnet ↗");
    expect(html).toMatch(/Network: <b[^>]*>Testnet<\/b>/);
    expect(html).toMatch(new RegExp(`<a [^>]*href="${MAINNET}/usage"[^>]*>Mainnet `));
    // The row has no aria-current pill, and no list: it is a sentence and a link.
    expect(html).not.toContain("aria-current");
  });

  it("is the other way round on mainnet", () => {
    const html = markup(onMainnet, "menu");
    expect(text(html)).toBe("Network: Mainnet Testnet ↗");
    expect(html).toMatch(new RegExp(`<a [^>]*href="${TESTNET}/usage"[^>]*>Testnet `));
  });
});

describe("the header itself", () => {
  it("has the pair between the links and Proof, and the row last in the phone menu", () => {
    const all = elements(SiteHeader());
    const kinds = all.filter((e) => e.type === NetworkSwitch).map((e) => e.props.variant);
    expect(kinds).toEqual(["pill", "menu"]);
    const at = (pred: (e: (typeof all)[number]) => boolean) => all.findIndex(pred);
    const pill = at((e) => e.type === NetworkSwitch && e.props.variant === "pill");
    const proof = at((e) => e.props.route === "/proof" && textOf(e) === "Proof");
    const links = at(
      (e) => typeof e.props.className === "string" && /navLinks/.test(e.props.className),
    );
    expect(links).toBeGreaterThanOrEqual(0);
    expect(pill).toBeGreaterThan(links);
    expect(pill).toBeLessThan(proof);
    // The menu's row is the last thing in the menu's panel.
    const menu = at((e) => e.type === NetworkSwitch && e.props.variant === "menu");
    const github = all.map((e, i) =>
      e.props.href === "https://github.com/probarion/probarion" ? i : -1,
    );
    expect(menu).toBeGreaterThan(Math.max(...github));
  });
});

/** Runs a client component as the browser would: the first render, then the effects, then the render they asked for. */
function inBrowser(host: string, pathname: string, vars: Record<string, string>) {
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  nav.pathname = pathname;
  vi.stubGlobal("window", { location: { host } });
}
const BOTH = {
  NEXT_PUBLIC_DEFAULT_NETWORK: "testnet",
  NEXT_PUBLIC_ORIGIN_MAINNET: MAINNET,
  NEXT_PUBLIC_ORIGIN_TESTNET: TESTNET,
};
const ONE = {
  NEXT_PUBLIC_DEFAULT_NETWORK: "testnet",
  NEXT_PUBLIC_ORIGIN_MAINNET: "",
  NEXT_PUBLIC_ORIGIN_TESTNET: "https://probarion.vercel.app",
};

describe("the switch, once the browser has told it where it is", () => {
  it("has no model on the first render, and the other address after mount", () => {
    inBrowser("testnet.probarion.test", "/usage", BOTH);
    const view = mount(() => NetworkSwitch({ variant: "pill" }));
    expect(view.result.props.model).toBeNull(); // the server render and hydration
    view.flush();
    expect(view.result.props.model).toEqual({
      current: "testnet",
      other: "mainnet",
      href: `${MAINNET}/usage`,
    });
    view.unmount();
  });

  it("knows mainnet from the address bar", () => {
    inBrowser("mainnet.probarion.test", "/canary/rules", BOTH);
    const view = mount(() => NetworkSwitch({ variant: "menu" }));
    view.flush();
    expect(view.result.props.model).toEqual({
      current: "mainnet",
      other: "testnet",
      href: `${TESTNET}/canary/rules`,
    });
  });

  it("takes any other address for the default network (a preview, localhost)", () => {
    inBrowser("probarion-git-x-eric.vercel.app", "/", BOTH);
    const view = mount(() => NetworkSwitch({ variant: "pill" }));
    view.flush();
    expect(view.result.props.model).toMatchObject({ current: "testnet", other: "mainnet" });
  });

  it("is never shown when the other network has no address: with no new setting there is no switch", () => {
    inBrowser("probarion.vercel.app", "/", ONE);
    const view = mount(() => NetworkSwitch({ variant: "pill" }));
    view.flush();
    expect(view.result.props.model).toBeNull();
    expect(markup(view.result.props.model, "pill")).toBe("");
  });

  it("is never shown with no published map at all", () => {
    inBrowser("probarion.vercel.app", "/", {
      NEXT_PUBLIC_DEFAULT_NETWORK: "",
      NEXT_PUBLIC_ORIGIN_MAINNET: "",
      NEXT_PUBLIC_ORIGIN_TESTNET: "",
    });
    const view = mount(() => NetworkSwitch({ variant: "pill" }));
    view.flush();
    expect(view.result.props.model).toBeNull();
  });

  it("sends a vault page to the list on the other network, and keeps a public page's path", () => {
    inBrowser("testnet.probarion.test", "/console/acme.vaults.probarion.testnet/keys", BOTH);
    const vault = mount(() => NetworkSwitch({ variant: "pill" }));
    vault.flush();
    expect(vault.result.props.model.href).toBe(`${MAINNET}/console`);
    inBrowser("testnet.probarion.test", "/proof/acme.vaults.probarion.testnet", BOTH);
    const proof = mount(() => NetworkSwitch({ variant: "pill" }));
    proof.flush();
    expect(proof.result.props.model.href).toBe(`${MAINNET}/proof`);
  });
});

describe("the beta strip, in the browser", () => {
  it("has no network on the first render, and the network of the address after mount", () => {
    for (const [host, network] of [
      ["testnet.probarion.test", "testnet"],
      ["mainnet.probarion.test", "mainnet"],
      ["preview.vercel.app", "testnet"],
    ] as const) {
      inBrowser(host, "/", BOTH);
      const view = mount(() => BetaStrip());
      expect(view.result.type).toBe(BetaStripView);
      expect(view.result.props.network, host).toBeNull();
      view.flush();
      expect(view.result.props.network, host).toBe(network);
    }
  });

  it("never says mainnet on a build that serves testnet alone", () => {
    inBrowser("probarion.vercel.app", "/", ONE);
    const view = mount(() => BetaStrip());
    view.flush();
    expect(view.result.props.network).toBe("testnet");
  });
});
