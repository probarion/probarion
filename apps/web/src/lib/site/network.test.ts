import { describe, expect, it } from "vitest";
import {
  checkOrigin,
  enabledNetworksOf,
  type NetworkRouting,
  networkForHost,
  networkSwitch,
  normalizeHost,
  originHost,
  otherNetworkOf,
  publicRoutingVars,
  routingFromPublicVars,
  switchPath,
} from "./network";

const both: NetworkRouting = {
  defaultNetwork: "testnet",
  origins: { mainnet: "https://mainnet.probarion.xyz", testnet: "https://probarion.xyz" },
};
const oneOnly: NetworkRouting = {
  defaultNetwork: "testnet",
  origins: { mainnet: null, testnet: "https://probarion.vercel.app" },
};

describe("networkForHost", () => {
  it("maps each origin's host to its network", () => {
    expect(networkForHost("mainnet.probarion.xyz", both)).toBe("mainnet");
    expect(networkForHost("probarion.xyz", both)).toBe("testnet");
  });

  it("ignores case, spaces and the dot that ends a fully qualified name", () => {
    expect(networkForHost("MAINNET.Probarion.XYZ", both)).toBe("mainnet");
    expect(networkForHost("  mainnet.probarion.xyz  ", both)).toBe("mainnet");
    expect(networkForHost("mainnet.probarion.xyz.", both)).toBe("mainnet");
  });

  it("reads the port: another port is another address", () => {
    const dev: NetworkRouting = {
      defaultNetwork: "testnet",
      origins: { mainnet: "http://localhost:3001", testnet: "http://localhost:3000" },
    };
    expect(networkForHost("localhost:3001", dev)).toBe("mainnet");
    expect(networkForHost("localhost:3000", dev)).toBe("testnet");
    // Neither port: not an origin of this site, so the default network.
    expect(networkForHost("localhost:4000", dev)).toBe("testnet");
    expect(networkForHost("localhost", dev)).toBe("testnet");
    // The default port of https is the host without a port.
    expect(networkForHost("mainnet.probarion.xyz:443", both)).toBe("testnet");
  });

  it("gives the default network to an unknown host, a deployment URL and localhost", () => {
    expect(networkForHost("evil.example", both)).toBe("testnet");
    expect(networkForHost("probarion-git-feature-eric.vercel.app", both)).toBe("testnet");
    expect(networkForHost("localhost:3000", both)).toBe("testnet");
    expect(networkForHost("mainnet.probarion.xyz.evil.example", both)).toBe("testnet");
    expect(networkForHost("xmainnet.probarion.xyz", both)).toBe("testnet");
    const mainDefault: NetworkRouting = { ...both, defaultNetwork: "mainnet" };
    expect(networkForHost("anything.vercel.app", mainDefault)).toBe("mainnet");
  });

  it("gives the default network when there is no host", () => {
    expect(networkForHost(null, both)).toBe("testnet");
    expect(networkForHost(undefined, both)).toBe("testnet");
    expect(networkForHost("", both)).toBe("testnet");
  });

  it("serves one network only, whatever the host, when the other has no origin", () => {
    expect(networkForHost("mainnet.probarion.xyz", oneOnly)).toBe("testnet");
    expect(networkForHost("probarion.vercel.app", oneOnly)).toBe("testnet");
  });
});

describe("checkOrigin", () => {
  it("accepts an https origin and normalises it", () => {
    expect(checkOrigin("https://Mainnet.Probarion.xyz")).toEqual({
      ok: true,
      origin: "https://mainnet.probarion.xyz",
      host: "mainnet.probarion.xyz",
    });
    expect(checkOrigin("https://a.example/")).toMatchObject({
      ok: true,
      origin: "https://a.example",
    });
    expect(checkOrigin("https://a.example:8443")).toMatchObject({
      ok: true,
      host: "a.example:8443",
    });
  });

  it("accepts http for a development host only", () => {
    expect(checkOrigin("http://localhost:3000")).toMatchObject({
      ok: true,
      host: "localhost:3000",
    });
    expect(checkOrigin("http://127.0.0.1:3000")).toMatchObject({ ok: true });
    expect(checkOrigin("http://app.localhost:3000")).toMatchObject({ ok: true });
    expect(checkOrigin("http://example.com")).toEqual({ ok: false, reason: "scheme" });
    expect(checkOrigin("http://localhost.evil.com")).toEqual({ ok: false, reason: "scheme" });
  });

  it("refuses what is not an origin", () => {
    expect(checkOrigin("ftp://a.example")).toEqual({ ok: false, reason: "scheme" });
    expect(checkOrigin("a.example")).toEqual({ ok: false, reason: "scheme" });
    expect(checkOrigin("javascript:alert(1)")).toEqual({ ok: false, reason: "scheme" });
    for (const bad of [
      "https://a.example/console",
      "https://a.example//",
      "https://a.example?x=1",
      "https://a.example#frag",
      "https://a.example?",
      "https://a.example#",
      "https://user:pw@a.example",
      "https://a.example:99999",
      "https://",
    ]) {
      expect(checkOrigin(bad), bad).toMatchObject({ ok: false });
    }
  });

  it("reads the host of a stored origin", () => {
    expect(originHost("https://a.example")).toBe("a.example");
    expect(originHost(null)).toBeNull();
  });
});

describe("helpers", () => {
  it("normalises a host", () => {
    expect(normalizeHost(" A.Example. ")).toBe("a.example");
    expect(normalizeHost("a.example.:3000")).toBe("a.example:3000");
  });

  it("names the other network", () => {
    expect(otherNetworkOf("mainnet")).toBe("testnet");
    expect(otherNetworkOf("testnet")).toBe("mainnet");
  });

  it("lists the enabled networks, mainnet first", () => {
    expect(enabledNetworksOf(both)).toEqual(["mainnet", "testnet"]);
    expect(enabledNetworksOf(oneOnly)).toEqual(["testnet"]);
    expect(
      enabledNetworksOf({
        defaultNetwork: "mainnet",
        origins: { mainnet: "https://a.example", testnet: null },
      }),
    ).toEqual(["mainnet"]);
  });
});

describe("publicRoutingVars: what next.config.ts publishes", () => {
  it("with no new variable: the default network and its production address, no other network", () => {
    expect(publicRoutingVars({})).toEqual({
      NEXT_PUBLIC_DEFAULT_NETWORK: "testnet",
      NEXT_PUBLIC_ORIGIN_MAINNET: "",
      NEXT_PUBLIC_ORIGIN_TESTNET: "http://localhost:3000",
    });
    expect(
      publicRoutingVars({
        NEAR_NETWORK: "mainnet",
        VERCEL_PROJECT_PRODUCTION_URL: "probarion.vercel.app",
      }),
    ).toEqual({
      NEXT_PUBLIC_DEFAULT_NETWORK: "mainnet",
      NEXT_PUBLIC_ORIGIN_MAINNET: "https://probarion.vercel.app",
      NEXT_PUBLIC_ORIGIN_TESTNET: "",
    });
  });

  it("takes each network's own origin, and a blank one is unset", () => {
    expect(
      publicRoutingVars({
        NEAR_NETWORK: "testnet",
        APP_ORIGIN_MAINNET: "https://mainnet.probarion.xyz/",
        APP_ORIGIN_TESTNET: "   ",
        VERCEL_PROJECT_PRODUCTION_URL: "probarion.vercel.app",
      }),
    ).toEqual({
      NEXT_PUBLIC_DEFAULT_NETWORK: "testnet",
      NEXT_PUBLIC_ORIGIN_MAINNET: "https://mainnet.probarion.xyz",
      NEXT_PUBLIC_ORIGIN_TESTNET: "https://probarion.vercel.app",
    });
  });

  it("leaves out an origin the server would refuse", () => {
    const v = publicRoutingVars({ APP_ORIGIN_MAINNET: "https://a.example/console" });
    expect(v.NEXT_PUBLIC_ORIGIN_MAINNET).toBe("");
  });

  it("round-trips into the routing the browser uses", () => {
    const routing = routingFromPublicVars(
      publicRoutingVars({
        APP_ORIGIN_MAINNET: "https://mainnet.probarion.xyz",
        VERCEL_PROJECT_PRODUCTION_URL: "probarion.xyz",
      }),
    );
    expect(routing).toEqual(both);
    expect(routingFromPublicVars({})).toEqual({
      defaultNetwork: "testnet",
      origins: { mainnet: null, testnet: null },
    });
  });
});

describe("switchPath", () => {
  it("keeps the path of a public page", () => {
    expect(switchPath("/")).toBe("/");
    expect(switchPath("/usage")).toBe("/usage");
    expect(switchPath("/canary/rules")).toBe("/canary/rules");
    expect(switchPath("/proof")).toBe("/proof");
    expect(switchPath("/console")).toBe("/console");
    expect(switchPath("/login")).toBe("/login");
  });

  it("sends a vault page to the list and a vault's proof to the proof index", () => {
    expect(switchPath("/console/acme.vaults.probarion.near")).toBe("/console");
    expect(switchPath("/console/acme.vaults.probarion.near/keys")).toBe("/console");
    expect(switchPath("/proof/acme.vaults.probarion.near")).toBe("/proof");
  });

  it("sends a one-time link page home", () => {
    expect(switchPath("/alerts/confirm")).toBe("/");
    expect(switchPath("/alerts/stop")).toBe("/");
  });

  it("is always a path", () => {
    expect(switchPath("evil.example")).toBe("/");
  });
});

describe("networkSwitch", () => {
  it("is null when the other network is not served", () => {
    expect(networkSwitch("probarion.vercel.app", "/usage", oneOnly)).toBeNull();
  });

  it("shows testnet as current and links to mainnet, with the path", () => {
    expect(networkSwitch("probarion.xyz", "/usage", both)).toEqual({
      current: "testnet",
      other: "mainnet",
      href: "https://mainnet.probarion.xyz/usage",
    });
  });

  it("shows mainnet as current and links back to testnet", () => {
    expect(networkSwitch("mainnet.probarion.xyz", "/console/v.near/keys", both)).toEqual({
      current: "mainnet",
      other: "testnet",
      href: "https://probarion.xyz/console",
    });
  });

  it("treats a preview URL as the default network", () => {
    expect(networkSwitch("p-git-x.vercel.app", "/", both)).toMatchObject({
      current: "testnet",
      other: "mainnet",
    });
  });
});

// Fix round 1, item 4: an origin written with the dot that ends a fully qualified name is the same address as one without.
describe("an origin with a trailing dot", () => {
  it("is stored without it, as a Host header is read without it", () => {
    expect(checkOrigin("https://host.example.")).toEqual({
      ok: true,
      origin: "https://host.example",
      host: "host.example",
    });
    expect(checkOrigin("https://HOST.example./")).toMatchObject({ origin: "https://host.example" });
    expect(checkOrigin("https://host.example.:8443")).toEqual({
      ok: true,
      origin: "https://host.example:8443",
      host: "host.example:8443",
    });
  });

  it("refuses more than one dot", () => {
    for (const bad of [
      "https://host.example..",
      "https://host..example",
      "https://host.example.../",
    ]) {
      expect(checkOrigin(bad), bad).toMatchObject({ ok: false });
    }
  });

  it("serves the address it names, with or without the dot in the request", () => {
    const routing = routingFromPublicVars(
      publicRoutingVars({ APP_ORIGIN_MAINNET: "https://mainnet.probarion.example." }),
    );
    expect(routing.origins.mainnet).toBe("https://mainnet.probarion.example");
    for (const host of [
      "mainnet.probarion.example",
      "mainnet.probarion.example.",
      "MAINNET.probarion.example",
    ]) {
      expect(networkForHost(host, routing), host).toBe("mainnet");
    }
    expect(
      publicRoutingVars({ APP_ORIGIN_MAINNET: "https://a.example." }).NEXT_PUBLIC_ORIGIN_MAINNET,
    ).toBe("https://a.example");
  });
});
