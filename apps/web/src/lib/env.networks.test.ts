import { describe, expect, it } from "vitest";
import { EnvError, loadEnv, PER_NETWORK_ENV_NAMES } from "./env";

// 32 distinct bytes: a key that is one repeated byte is rejected.
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256)).toString("base64");
const base = {
  NEAR_NETWORK: "testnet",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x",
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_x",
  KEY_ENCRYPTION_SECRET: KEY,
  CRON_SECRET: "c".repeat(40),
};

// W-NET-R1, R10: both networks from one deployment. The first block pins "no new variable set" to BASE's behaviour.
describe("loadEnv: both networks (W-NET-R1)", () => {
  it("with no new variable, behaves exactly as one network per deployment", () => {
    const env = loadEnv({
      ...base,
      NEAR_RPC_URLS: "https://rpc.example/key",
      NEAR_ARCHIVAL_RPC_URLS: "https://archival.example",
      PROBARION_FACTORY_ID: "vaults.staging.testnet",
      PROBARION_VAULT_ID: "demo.vaults.staging.testnet",
      CANARY_VAULT_ID: "canary.vaults.staging.testnet",
      TEAM_VAULT_IDS: "team.vaults.staging.testnet",
    });
    expect(env.defaultNetwork).toBe("testnet");
    expect(env.enabledNetworks).toEqual(["testnet"]);
    expect(env.networks.testnet).toEqual({
      enabled: true,
      origin: "http://localhost:3000",
      rpcUrls: ["https://rpc.example/key"],
      archivalRpcUrls: ["https://archival.example"],
      factoryId: "vaults.staging.testnet",
      demoVaultId: "demo.vaults.staging.testnet",
      canaryVaultId: "canary.vaults.staging.testnet",
      teamVaultIds: ["team.vaults.staging.testnet"],
    });
    // The other network is not served and takes nothing from the unsuffixed variables: only its own built-ins.
    expect(env.networks.mainnet).toEqual({
      enabled: false,
      origin: null,
      rpcUrls: ["https://rpc.mainnet.fastnear.com", "https://rpc.intea.rs"],
      archivalRpcUrls: [],
      factoryId: "vaults.probarion.near",
      demoVaultId: null,
      canaryVaultId: null,
      teamVaultIds: [],
    });
  });

  it("takes the default network's origin from the production address when it sets none", () => {
    const env = loadEnv({ ...base, VERCEL_PROJECT_PRODUCTION_URL: "probarion.vercel.app" });
    expect(env.networks.testnet.origin).toBe("https://probarion.vercel.app");
    expect(env.networks.mainnet.origin).toBeNull();
    expect(env.enabledNetworks).toEqual(["testnet"]);
  });

  it("enables the other network when its origin is set, and lists mainnet first", () => {
    const env = loadEnv({
      ...base,
      VERCEL_PROJECT_PRODUCTION_URL: "probarion.vercel.app",
      APP_ORIGIN_MAINNET: "https://mainnet.probarion.xyz/",
    });
    expect(env.enabledNetworks).toEqual(["mainnet", "testnet"]);
    expect(env.networks.mainnet).toMatchObject({
      enabled: true,
      origin: "https://mainnet.probarion.xyz",
    });
    expect(env.networks.testnet).toMatchObject({
      enabled: true,
      origin: "https://probarion.vercel.app",
    });
  });

  it("lets the default network's own origin win over the production address", () => {
    const env = loadEnv({
      ...base,
      VERCEL_PROJECT_PRODUCTION_URL: "probarion.vercel.app",
      APP_ORIGIN_TESTNET: "https://testnet.probarion.xyz",
    });
    expect(env.networks.testnet.origin).toBe("https://testnet.probarion.xyz");
  });

  it("serves the default network when it is mainnet, with the other off", () => {
    const env = loadEnv({
      ...base,
      NEAR_NETWORK: "mainnet",
      VERCEL_PROJECT_PRODUCTION_URL: "probarion.vercel.app",
    });
    expect(env.enabledNetworks).toEqual(["mainnet"]);
    expect(env.networks.testnet.enabled).toBe(false);
  });

  describe("a suffixed variable wins over the unsuffixed one, for its network", () => {
    const both = {
      ...base,
      APP_ORIGIN_MAINNET: "https://mainnet.probarion.xyz",
      NEAR_RPC_URLS: "https://bare.example",
      NEAR_ARCHIVAL_RPC_URLS: "https://bare-archival.example",
      PROBARION_FACTORY_ID: "bare.factory.testnet",
      PROBARION_VAULT_ID: "bare-demo.testnet",
      CANARY_VAULT_ID: "bare-canary.testnet",
      TEAM_VAULT_IDS: "bare-team.testnet",
      NEAR_RPC_URLS_TESTNET: "https://t.example,https://t2.example",
      NEAR_ARCHIVAL_RPC_URLS_TESTNET: "https://t-archival.example",
      PROBARION_FACTORY_ID_TESTNET: "vaults.t.testnet",
      PROBARION_VAULT_ID_TESTNET: "demo.t.testnet",
      CANARY_VAULT_ID_TESTNET: "canary.t.testnet",
      TEAM_VAULT_IDS_TESTNET: "team-a.t.testnet, team-b.t.testnet",
      NEAR_RPC_URLS_MAINNET: "https://m.example",
      NEAR_ARCHIVAL_RPC_URLS_MAINNET: "https://m-archival.example",
      PROBARION_FACTORY_ID_MAINNET: "vaults.m.near",
      PROBARION_VAULT_ID_MAINNET: "demo.m.near",
      CANARY_VAULT_ID_MAINNET: "canary.m.near",
      TEAM_VAULT_IDS_MAINNET: "team.m.near",
    };

    it("for the default network", () => {
      expect(loadEnv(both).networks.testnet).toMatchObject({
        rpcUrls: ["https://t.example", "https://t2.example"],
        archivalRpcUrls: ["https://t-archival.example"],
        factoryId: "vaults.t.testnet",
        demoVaultId: "demo.t.testnet",
        canaryVaultId: "canary.t.testnet",
        teamVaultIds: ["team-a.t.testnet", "team-b.t.testnet"],
      });
    });

    it("for the other network, which takes nothing from the unsuffixed ones", () => {
      expect(loadEnv(both).networks.mainnet).toMatchObject({
        rpcUrls: ["https://m.example"],
        archivalRpcUrls: ["https://m-archival.example"],
        factoryId: "vaults.m.near",
        demoVaultId: "demo.m.near",
        canaryVaultId: "canary.m.near",
        teamVaultIds: ["team.m.near"],
      });
    });

    it("falls back to the unsuffixed variable (default network only) when the suffixed one names nothing", () => {
      const env = loadEnv({
        ...both,
        NEAR_RPC_URLS_TESTNET: " , ",
        TEAM_VAULT_IDS_TESTNET: ",",
        PROBARION_VAULT_ID_TESTNET: "  ",
      });
      expect(env.networks.testnet.rpcUrls).toEqual(["https://bare.example"]);
      expect(env.networks.testnet.teamVaultIds).toEqual(["bare-team.testnet"]);
      expect(env.networks.testnet.demoVaultId).toBe("bare-demo.testnet");
    });
  });

  describe("an unsuffixed variable never applies to the other network", () => {
    const unsuffixedOnly = {
      NEAR_RPC_URLS: "https://testnet-only.example/key",
      NEAR_ARCHIVAL_RPC_URLS: "https://testnet-archival.example",
      PROBARION_FACTORY_ID: "vaults.staging.testnet",
      PROBARION_VAULT_ID: "demo.staging.testnet",
      CANARY_VAULT_ID: "canary.staging.testnet",
      TEAM_VAULT_IDS: "team.staging.testnet",
    };

    it("not testnet's RPCs, factory, demo, Canary or team vaults on mainnet", () => {
      const env = loadEnv({
        ...base,
        ...unsuffixedOnly,
        APP_ORIGIN_MAINNET: "https://mainnet.probarion.xyz",
      });
      expect(env.networks.mainnet.enabled).toBe(true);
      expect(env.networks.mainnet).toMatchObject({
        rpcUrls: ["https://rpc.mainnet.fastnear.com", "https://rpc.intea.rs"],
        archivalRpcUrls: [],
        factoryId: "vaults.probarion.near",
        demoVaultId: null,
        canaryVaultId: null,
        teamVaultIds: [],
      });
      expect(JSON.stringify(env.networks.mainnet)).not.toContain("staging");
      expect(JSON.stringify(env.networks.mainnet)).not.toContain("testnet-only");
    });

    it("and the same the other way round: nothing reaches testnet when mainnet is the default", () => {
      const env = loadEnv({
        ...base,
        NEAR_NETWORK: "mainnet",
        ...unsuffixedOnly,
        APP_ORIGIN_TESTNET: "https://testnet.probarion.xyz",
      });
      expect(env.networks.mainnet.rpcUrls).toEqual(["https://testnet-only.example/key"]);
      expect(env.networks.testnet).toMatchObject({
        rpcUrls: ["https://rpc.testnet.fastnear.com"],
        archivalRpcUrls: [],
        factoryId: "vaults.probarion.testnet",
        demoVaultId: null,
        canaryVaultId: null,
        teamVaultIds: [],
      });
    });

    it("also when the other network is not served at all", () => {
      const env = loadEnv({ ...base, ...unsuffixedOnly });
      expect(env.networks.mainnet.rpcUrls).not.toContain("https://testnet-only.example/key");
      expect(env.networks.mainnet.factoryId).toBe("vaults.probarion.near");
    });
  });

  describe("refuses a bad origin, naming the variable and never the value", () => {
    const SENTINEL = "SENTINEL";

    function messageFor(src: Record<string, string>): string {
      try {
        loadEnv({ ...base, ...src });
      } catch (e) {
        expect(e).toBeInstanceOf(EnvError);
        return (e as Error).message;
      }
      return expect.unreachable("loadEnv should have thrown");
    }

    it("two origins with the same host", () => {
      const message = messageFor({
        APP_ORIGIN_MAINNET: "https://sentinel-host.example",
        APP_ORIGIN_TESTNET: "https://sentinel-host.example",
      });
      expect(message).toMatch(/APP_ORIGIN_MAINNET must not have the same host/);
      expect(message).not.toContain("sentinel-host");
    });

    it("two origins with the same host, spelled differently (case, a trailing slash)", () => {
      expect(() =>
        loadEnv({
          ...base,
          APP_ORIGIN_MAINNET: "https://Probarion.example/",
          APP_ORIGIN_TESTNET: "https://probarion.example",
        }),
      ).toThrow(/APP_ORIGIN_MAINNET must not have the same host/);
    });

    it("the other network on the production address of the default network", () => {
      expect(() =>
        loadEnv({
          ...base,
          VERCEL_PROJECT_PRODUCTION_URL: "probarion.vercel.app",
          APP_ORIGIN_MAINNET: "https://probarion.vercel.app",
        }),
      ).toThrow(/APP_ORIGIN_MAINNET must not have the same host/);
    });

    it("one host on two ports is two origins", () => {
      const env = loadEnv({
        ...base,
        APP_ORIGIN_MAINNET: "http://localhost:3001",
        APP_ORIGIN_TESTNET: "http://localhost:3000",
      });
      expect(env.enabledNetworks).toEqual(["mainnet", "testnet"]);
    });

    it("an origin with a path, a query, a fragment or credentials", () => {
      for (const bad of [
        `https://${SENTINEL}.example/console`,
        `https://${SENTINEL}.example//`,
        `https://${SENTINEL}.example?x=1`,
        `https://${SENTINEL}.example#top`,
        `https://user:${SENTINEL}@host.example`,
      ]) {
        const message = messageFor({ APP_ORIGIN_MAINNET: bad });
        expect(message, bad).toMatch(/APP_ORIGIN_MAINNET must be an origin/);
        expect(message, bad).not.toContain(SENTINEL);
      }
      expect(messageFor({ APP_ORIGIN_TESTNET: "https://a.example/x" })).toMatch(
        /APP_ORIGIN_TESTNET must be an origin/,
      );
    });

    it("an origin that is not http(s), or http for a host that is not local", () => {
      for (const bad of [
        `ftp://${SENTINEL}.example`,
        `javascript:${SENTINEL}`,
        `${SENTINEL}.example`,
        `http://${SENTINEL}.example`,
        `http://localhost.${SENTINEL}.example`,
      ]) {
        const message = messageFor({ APP_ORIGIN_MAINNET: bad });
        expect(message, bad).toMatch(/APP_ORIGIN_MAINNET must be https/);
        expect(message, bad).not.toContain(SENTINEL);
      }
    });

    it("accepts http on localhost for development", () => {
      const env = loadEnv({ ...base, APP_ORIGIN_MAINNET: "http://localhost:3001" });
      expect(env.networks.mainnet.origin).toBe("http://localhost:3001");
    });

    it("treats a blank origin as unset (R12)", () => {
      const env = loadEnv({ ...base, APP_ORIGIN_MAINNET: "   ", APP_ORIGIN_TESTNET: "" });
      expect(env.enabledNetworks).toEqual(["testnet"]);
    });

    it("names the suffixed variable of a refused entry, by position, never its value", () => {
      const message = messageFor({
        NEAR_RPC_URLS_MAINNET: `https://ok.example,http://${SENTINEL}-rpc.example`,
        NEAR_ARCHIVAL_RPC_URLS_TESTNET: `http://${SENTINEL}-archival.example`,
        TEAM_VAULT_IDS_MAINNET: `Not An Account ${SENTINEL}`,
      });
      expect(message).toMatch(/NEAR_RPC_URLS_MAINNET entry 2 must be https/);
      expect(message).toMatch(/NEAR_ARCHIVAL_RPC_URLS_TESTNET entry 1 must be https/);
      expect(message).toMatch(/TEAM_VAULT_IDS_MAINNET entry 1 is not a NEAR account id/);
      expect(message).not.toContain(SENTINEL);
    });

    it("still validates a network that is not served (its rows can be shown)", () => {
      expect(() => loadEnv({ ...base, NEAR_RPC_URLS_MAINNET: "http://insecure.example" })).toThrow(
        /NEAR_RPC_URLS_MAINNET entry 1 must be https/,
      );
    });
  });

  it("lists the per-network variables, so the docs can be checked against them", () => {
    expect(PER_NETWORK_ENV_NAMES).toEqual([
      "NEAR_RPC_URLS",
      "NEAR_ARCHIVAL_RPC_URLS",
      "PROBARION_FACTORY_ID",
      "PROBARION_VAULT_ID",
      "CANARY_VAULT_ID",
      "TEAM_VAULT_IDS",
    ]);
  });
});
