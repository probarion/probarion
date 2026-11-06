import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quietLogs } from "../../../../test/fixtures/quiet-logs";

type Net = "mainnet" | "testnet";

// The settings and the address's network are replaced; the probes, the cache and the routes are the real ones, with
// fetch stubbed (unit tests never reach the network: test/setup/no-network.ts).
const mocks = vi.hoisted(() => ({
  env: vi.fn(),
  network: { value: "testnet" as "mainnet" | "testnet" },
}));
vi.mock("@/lib/env", () => ({ getEnv: mocks.env }));
vi.mock("@/lib/network", () => ({
  softRequestNetwork: async () => mocks.network.value,
  otherNetwork: (n: Net): Net => (n === "mainnet" ? "testnet" : "mainnet"),
  originFor: (n: Net, env: { networks: Record<Net, { origin: string | null }> }) =>
    env.networks[n].origin,
}));

import { clearHealthCache } from "@/lib/health";
import { healthReport } from "@/lib/health-server";
import { GET as nearai } from "./nearai/route";
import { GET as health } from "./route";
import { GET as rpc } from "./rpc/route";

const logs = quietLogs();

const ENV = {
  networks: {
    mainnet: {
      enabled: false,
      origin: null as string | null,
      rpcUrls: ["https://rpc.mainnet.fastnear.com", "https://rpc.intea.rs"],
      rpcUrlsVariable: "NEAR_RPC_URLS_MAINNET",
    },
    testnet: {
      enabled: true,
      origin: "https://probarion.xyz" as string | null,
      rpcUrls: ["https://rpc.testnet.fastnear.com"],
      rpcUrlsVariable: "NEAR_RPC_URLS_TESTNET",
    },
  },
  NEARAI_API_KEY: null as string | null,
};

const answer = (body: unknown, code = 200) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json" },
  });
const status = (chain: string) => ({
  jsonrpc: "2.0",
  id: "health",
  result: {
    chain_id: chain,
    sync_info: {
      latest_block_height: 42,
      latest_block_time: new Date(Date.now() - 2_000).toISOString(),
      syncing: false,
    },
  },
});
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  clearHealthCache();
  mocks.env.mockReset();
  mocks.env.mockReturnValue(ENV);
  mocks.network.value = "testnet";
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) =>
    input.includes("/model/list")
      ? answer({ models: [{ modelId: "m", metadata: {} }], total: 1 })
      : answer(status(input.includes("testnet") ? "testnet" : "mainnet")),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/health", () => {
  it("answers 200 for the network of the address, never cached, and calls nothing", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef0123");
    const res = await health();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      ok: true,
      service: "probarion-web",
      network: "testnet",
      commit: "0123456789ab",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 settings when the settings cannot be read, and names no variable in the body", async () => {
    mocks.env.mockImplementation(() => {
      throw new Error("Invalid environment: CRON_SECRET is required");
    });
    const res = await health();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, network: "testnet", detail: "settings" });
    expect(JSON.stringify(body)).not.toContain("CRON_SECRET");
    expect(logs.lines.join("\n")).toContain("health.settings_invalid");
  });
});

describe("GET /api/health/rpc", () => {
  const get = (query: string) => rpc(new Request(`http://localhost/api/health/rpc${query}`));

  it("probes provider 0 by default with one status call", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: "rpc.testnet.fastnear.com",
      ok: true,
      network: "testnet",
      provider: 0,
      providers: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://rpc.testnet.fastnear.com");
    expect(JSON.parse(String(init?.body))).toMatchObject({ method: "status" });
  });

  it("answers 404 for an index the list does not have, and makes no call", async () => {
    for (const q of [
      "?provider=1",
      "?provider=abc",
      "?provider=-1",
      "?provider=100",
      "?provider=1.5",
    ]) {
      expect((await get(q)).status, q).toBe(404);
    }
    expect(await (await get("?provider=1")).json()).toEqual({
      ok: false,
      network: "testnet",
      providers: 1,
      detail: "provider must be between 0 and 0",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 wrong chain for an RPC that serves the other network", async () => {
    fetchMock.mockImplementation(async () => answer(status("mainnet")));
    const res = await get("?provider=0");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, detail: "wrong chain" });
  });

  it("answers 503 settings when the settings cannot be read", async () => {
    mocks.env.mockImplementation(() => {
      throw new Error("bad");
    });
    const res = await get("?provider=0");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, network: "testnet", detail: "settings" });
  });

  it("names a configured URL by its variable and place, never its host", async () => {
    mocks.env.mockReturnValue({
      ...ENV,
      networks: {
        ...ENV.networks,
        testnet: { ...ENV.networks.testnet, rpcUrls: ["https://key-abc.rpc.example.com/secret"] },
      },
    });
    const text = await (await get("?provider=0")).text();
    expect(text).toContain("NEAR_RPC_URLS_TESTNET entry 1");
    expect(text).not.toContain("example.com");
    expect(text).not.toContain("secret");
  });

  it("keeps one answer per network and provider for 30 seconds", async () => {
    await get("?provider=0");
    await get("?provider=0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mocks.network.value = "mainnet";
    const res = await get("?provider=0");
    expect(await res.json()).toMatchObject({
      name: "rpc.mainnet.fastnear.com",
      network: "mainnet",
      providers: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/health/nearai", () => {
  it("reads the public list without the key, and says whether the key is set", async () => {
    mocks.env.mockReturnValue({ ...ENV, NEARAI_API_KEY: "sk-test-not-sent" });
    const res = await nearai();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "NEAR AI Cloud", ok: true, configured: true });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://cloud-api.near.ai/v1/model/list?limit=100&offset=0");
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization|sk-test/i);
  });

  it("answers 503 when the list is empty", async () => {
    fetchMock.mockImplementation(async () => answer({ models: [], total: 0 }));
    const res = await nearai();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      ok: false,
      detail: "no models listed",
      configured: false,
    });
  });
});

describe("healthReport", () => {
  it("probes every provider of the network and the model list, and names the other address", async () => {
    mocks.env.mockReturnValue({
      ...ENV,
      networks: {
        mainnet: { ...ENV.networks.mainnet, origin: "https://probarion.xyz" },
        testnet: { ...ENV.networks.testnet, origin: "https://testnet.probarion.xyz" },
      },
    });
    const report = await healthReport("mainnet");
    expect(report.settings).toBe(true);
    expect(report.rpc.map((r) => r.probe.name)).toEqual([
      "rpc.mainnet.fastnear.com",
      "rpc.intea.rs",
    ]);
    expect(report.rpc.every((r) => r.probe.ok)).toBe(true);
    expect(report.other).toEqual({ network: "testnet", origin: "https://testnet.probarion.xyz" });
  });

  it("never throws when the settings cannot be read", async () => {
    mocks.env.mockImplementation(() => {
      throw new Error("bad");
    });
    const report = await healthReport("testnet");
    expect(report).toMatchObject({
      settings: false,
      rpc: [],
      other: { network: "mainnet", origin: null },
    });
    expect(report.nearai.configured).toBe(false);
  });
});
