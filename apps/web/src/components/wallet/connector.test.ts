// One connector per network: the library has no dispose, so a new one on every visit would leave its window listeners
// behind until a reload. The library is a fake here, because it reaches for window as it loads.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ built: [] as string[], failures: 0 }));

vi.mock("@hot-labs/near-connect", () => ({
  LocalStorage: class {},
  NearConnector: class {
    constructor(options: { network: string }) {
      if (h.failures > 0) {
        h.failures--;
        throw new Error("the connector could not start");
      }
      h.built.push(options.network);
    }
  },
}));

const fresh = async () => {
  vi.resetModules();
  return import("./connector");
};

beforeEach(() => {
  h.built = [];
  h.failures = 0;
});

describe("connectorFor", () => {
  it("builds one connector per network, however many visits ask for it", async () => {
    const { connectorFor } = await fresh();
    const first = await connectorFor("testnet");
    const again = await connectorFor("testnet");
    expect(again).toBe(first);
    expect(h.built).toEqual(["testnet"]);
  });

  it("shares one build between two visits that ask at the same time", async () => {
    const { connectorFor } = await fresh();
    const [a, b] = await Promise.all([connectorFor("testnet"), connectorFor("testnet")]);
    expect(a).toBe(b);
    expect(h.built).toEqual(["testnet"]);
  });

  it("keeps the two networks apart", async () => {
    const { connectorFor } = await fresh();
    expect(await connectorFor("mainnet")).not.toBe(await connectorFor("testnet"));
    expect(h.built).toEqual(["mainnet", "testnet"]);
  });

  it("shadows the debug-wallet door on the connector it builds", async () => {
    const { connectorFor } = await fresh();
    const connector = (await connectorFor("testnet")) as unknown as {
      registerDebugWallet: () => Promise<never>;
    };
    await expect(connector.registerDebugWallet()).rejects.toThrow("turned off");
  });

  it("tries again after a failure, instead of keeping it", async () => {
    const { connectorFor } = await fresh();
    h.failures = 1;
    await expect(connectorFor("testnet")).rejects.toThrow();
    const connector = await connectorFor("testnet");
    expect(connector).toBeDefined();
    expect(h.built).toEqual(["testnet"]);
  });
});
