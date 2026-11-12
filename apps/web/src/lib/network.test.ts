import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envFrom, REQUIRED_ENV } from "../../test/fixtures/env";
import { assertSameOrigin } from "./http";
import { networkForRequestHost, originFor, otherNetwork, routingOf } from "./network";
import { requestHost } from "./site/network";

// The server side of "the network is the address" (W-NET-R2): the same rule as lib/site/network.ts, over the settings
// loadEnv parsed, and the wrappers that read the request's Host header.
const MAINNET = "https://mainnet.probarion.xyz";
const TESTNET = "https://probarion.xyz";
const both = () =>
  envFrom({ NEAR_NETWORK: "testnet", APP_ORIGIN_MAINNET: MAINNET, APP_ORIGIN_TESTNET: TESTNET });
const one = () =>
  envFrom({ NEAR_NETWORK: "testnet", VERCEL_PROJECT_PRODUCTION_URL: "probarion.vercel.app" });

describe("networkForRequestHost", () => {
  it("is the network whose origin has that host, whatever the case", () => {
    const env = both();
    expect(networkForRequestHost("mainnet.probarion.xyz", env)).toBe("mainnet");
    expect(networkForRequestHost("MAINNET.Probarion.XYZ", env)).toBe("mainnet");
    expect(networkForRequestHost("probarion.xyz", env)).toBe("testnet");
  });

  it("is the default network for any other host, a deployment URL and localhost included", () => {
    const env = both();
    for (const host of [
      "probarion-git-feature-eric.vercel.app",
      "localhost:3000",
      "evil.example",
      "mainnet.probarion.xyz.evil.example",
      "",
      null,
      undefined,
    ]) {
      expect(networkForRequestHost(host, env), String(host)).toBe("testnet");
    }
    const mainDefault = envFrom({
      NEAR_NETWORK: "mainnet",
      APP_ORIGIN_MAINNET: MAINNET,
      APP_ORIGIN_TESTNET: TESTNET,
    });
    expect(networkForRequestHost("preview.vercel.app", mainDefault)).toBe("mainnet");
  });

  it("reads the port: another port is another address", () => {
    const env = envFrom({
      NEAR_NETWORK: "testnet",
      APP_ORIGIN_MAINNET: "http://localhost:3001",
      APP_ORIGIN_TESTNET: "http://localhost:3000",
    });
    expect(networkForRequestHost("localhost:3001", env)).toBe("mainnet");
    expect(networkForRequestHost("localhost:3000", env)).toBe("testnet");
    expect(networkForRequestHost("localhost:3002", env)).toBe("testnet");
  });

  it("never finds the network that is not served: its host is any other host", () => {
    const env = one();
    expect(env.networks.mainnet.enabled).toBe(false);
    expect(networkForRequestHost("mainnet.probarion.xyz", env)).toBe("testnet");
    expect(networkForRequestHost("probarion.vercel.app", env)).toBe("testnet");
  });
});

describe("routingOf, originFor and otherNetwork", () => {
  it("gives a served network its origin and a network that is not served none", () => {
    expect(routingOf(both())).toEqual({
      defaultNetwork: "testnet",
      origins: { mainnet: MAINNET, testnet: TESTNET },
    });
    expect(routingOf(one())).toEqual({
      defaultNetwork: "testnet",
      origins: { mainnet: null, testnet: "https://probarion.vercel.app" },
    });
  });

  it("answers the origin of a network or null", () => {
    expect(originFor("mainnet", both())).toBe(MAINNET);
    expect(originFor("testnet", both())).toBe(TESTNET);
    expect(originFor("mainnet", one())).toBeNull();
  });

  it("names the other network", () => {
    expect(otherNetwork("mainnet")).toBe("testnet");
    expect(otherNetwork("testnet")).toBe("mainnet");
  });
});

// The wrappers read the Host header and the process settings: each scenario gets a fresh copy of the module and of
// getEnv's cache.
describe("requestNetwork and softRequestNetwork", () => {
  const request = { host: null as string | null };

  async function load(env: Record<string, string>) {
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      headers: async () => ({ get: (name: string) => (name === "host" ? request.host : null) }),
    }));
    vi.unstubAllEnvs();
    for (const [name, value] of Object.entries({ ...REQUIRED_ENV, ...env }))
      vi.stubEnv(name, value);
    return import("./network");
  }
  beforeEach(() => {
    request.host = null;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("next/headers");
    vi.resetModules();
  });

  const SERVED = {
    NEAR_NETWORK: "testnet",
    APP_ORIGIN_MAINNET: MAINNET,
    APP_ORIGIN_TESTNET: TESTNET,
  };

  it("reads the host of the request, and nothing else", async () => {
    const { requestNetwork } = await load(SERVED);
    request.host = "mainnet.probarion.xyz";
    expect(await requestNetwork()).toBe("mainnet");
    request.host = "probarion.xyz";
    expect(await requestNetwork()).toBe("testnet");
    request.host = "preview.vercel.app";
    expect(await requestNetwork()).toBe("testnet");
    request.host = null;
    expect(await requestNetwork()).toBe("testnet");
  });

  it("fails when the settings cannot be read: a request that touches a vault must not guess", async () => {
    const { requestNetwork } = await load({
      ...SERVED,
      APP_ORIGIN_MAINNET: "https://a.example/path",
    });
    request.host = "mainnet.probarion.xyz";
    await expect(requestNetwork()).rejects.toThrow(/APP_ORIGIN_MAINNET/);
  });

  it("falls back to the public map built into the page when the settings cannot be read", async () => {
    const { softRequestNetwork } = await load({
      ...SERVED,
      KEY_ENCRYPTION_SECRET: "not-a-key",
      NEXT_PUBLIC_DEFAULT_NETWORK: "testnet",
      NEXT_PUBLIC_ORIGIN_MAINNET: MAINNET,
      NEXT_PUBLIC_ORIGIN_TESTNET: TESTNET,
    });
    request.host = "mainnet.probarion.xyz";
    expect(await softRequestNetwork()).toBe("mainnet");
    request.host = "probarion.xyz";
    expect(await softRequestNetwork()).toBe("testnet");
    request.host = "preview.vercel.app";
    expect(await softRequestNetwork()).toBe("testnet");
  });

  it("agrees with requestNetwork when the settings are fine", async () => {
    const { softRequestNetwork, requestNetwork } = await load(SERVED);
    for (const host of ["mainnet.probarion.xyz", "probarion.xyz", "x.vercel.app", null]) {
      request.host = host;
      expect(await softRequestNetwork(), String(host)).toBe(await requestNetwork());
    }
  });

  // A canonical link names the page at the address of its own network: never the other network's (metadataBase is one
  // origin), and a preview or deployment URL names the default network's address.
  it("builds a page's canonical address from the origin of the request's own network", async () => {
    const { canonicalUrl } = await load(SERVED);
    request.host = "mainnet.probarion.xyz";
    expect(await canonicalUrl("/status")).toBe(`${MAINNET}/status`);
    request.host = "probarion.xyz";
    expect(await canonicalUrl("/status")).toBe(`${TESTNET}/status`);
    for (const host of ["preview.vercel.app", null]) {
      request.host = host;
      expect(await canonicalUrl("/canary"), String(host)).toBe(`${TESTNET}/canary`);
    }
  });

  it("keeps the canonical on the request's network when the settings cannot be read", async () => {
    const { canonicalUrl } = await load({
      ...SERVED,
      KEY_ENCRYPTION_SECRET: "not-a-key",
      NEXT_PUBLIC_DEFAULT_NETWORK: "testnet",
      NEXT_PUBLIC_ORIGIN_MAINNET: MAINNET,
      NEXT_PUBLIC_ORIGIN_TESTNET: TESTNET,
    });
    request.host = "mainnet.probarion.xyz";
    expect(await canonicalUrl("/proof")).toBe(`${MAINNET}/proof`);
    request.host = "probarion.xyz";
    expect(await canonicalUrl("/proof")).toBe(`${TESTNET}/proof`);
  });
});

// W-NET-R4 (fix round 1): the network of a request and the CSRF check read one host, so a request cannot pass the origin check
// for one address and be answered as the network of another.
describe("the network and the origin check read the same host", () => {
  const env = both();
  const ORIGINS = { mainnet: MAINNET, testnet: TESTNET } as const;
  const HOSTS = {
    mainnet: "mainnet.probarion.xyz",
    testnet: "probarion.xyz",
    other: "preview.vercel.app",
  };
  const requests: [string, Record<string, string>][] = [
    ["Host only", { host: HOSTS.mainnet }],
    ["Host only, upper case", { host: "MAINNET.probarion.XYZ" }],
    ["forwarded host only", { "x-forwarded-host": HOSTS.testnet }],
    ["both, the same", { "x-forwarded-host": HOSTS.mainnet, host: HOSTS.mainnet }],
    [
      "both, different: the forwarded one wins",
      { "x-forwarded-host": HOSTS.mainnet, host: HOSTS.testnet },
    ],
    ["both, different the other way", { "x-forwarded-host": HOSTS.testnet, host: HOSTS.mainnet }],
    [
      "a list of forwarded hosts",
      { "x-forwarded-host": `${HOSTS.mainnet}, ${HOSTS.testnet}`, host: HOSTS.testnet },
    ],
    [
      "a list that starts with the other",
      { "x-forwarded-host": `${HOSTS.testnet}, ${HOSTS.mainnet}`, host: HOSTS.mainnet },
    ],
    [
      "an unknown forwarded host over a known one",
      { "x-forwarded-host": HOSTS.other, host: HOSTS.mainnet },
    ],
    [
      "a known forwarded host over an unknown one",
      { "x-forwarded-host": HOSTS.mainnet, host: HOSTS.other },
    ],
  ];

  it.each(requests)(
    "%s: the origin check accepts an origin only for the network the request is answered as",
    (_name, headers) => {
      const network = networkForRequestHost(requestHost(new Headers(headers)), env);
      for (const candidate of ["mainnet", "testnet"] as const) {
        const req = new Request("https://internal.local/api/x", {
          method: "POST",
          headers: { ...headers, origin: ORIGINS[candidate] },
        });
        const accepted = assertSameOrigin(req) === null;
        // An address of one of the two networks is accepted exactly when the request is for that network; a request for
        // an unknown host is the default network's, and no origin of a network matches it.
        const hostIsKnown = [HOSTS.mainnet, HOSTS.testnet].includes(
          requestHost(new Headers(headers)) ?? "",
        );
        expect(accepted, `${candidate}`).toBe(hostIsKnown && network === candidate);
      }
    },
  );
});
