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
    const suffixed = {
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
    const bare = {
      NEAR_RPC_URLS: "https://bare.example",
      NEAR_ARCHIVAL_RPC_URLS: "https://bare-archival.example",
      PROBARION_FACTORY_ID: "bare.factory.testnet",
      PROBARION_VAULT_ID: "bare-demo.testnet",
      CANARY_VAULT_ID: "bare-canary.testnet",
      TEAM_VAULT_IDS: "bare-team.testnet",
    };
    // Both networks served: only suffixed variables are accepted (the unsuffixed ones are refused, see below).
    const both = { ...base, APP_ORIGIN_MAINNET: "https://mainnet.probarion.xyz", ...suffixed };
    // One network served: the unsuffixed variables are the default network's, and a suffixed one wins over them.
    const one = { ...base, ...bare, ...suffixed };

    it("for the default network", () => {
      for (const src of [one, both]) {
        expect(loadEnv(src).networks.testnet).toMatchObject({
          rpcUrls: ["https://t.example", "https://t2.example"],
          archivalRpcUrls: ["https://t-archival.example"],
          factoryId: "vaults.t.testnet",
          demoVaultId: "demo.t.testnet",
          canaryVaultId: "canary.t.testnet",
          teamVaultIds: ["team-a.t.testnet", "team-b.t.testnet"],
        });
      }
    });

    it("for the other network, which takes nothing from the unsuffixed ones", () => {
      for (const src of [one, both]) {
        expect(loadEnv(src).networks.mainnet).toMatchObject({
          rpcUrls: ["https://m.example"],
          archivalRpcUrls: ["https://m-archival.example"],
          factoryId: "vaults.m.near",
          demoVaultId: "demo.m.near",
          canaryVaultId: "canary.m.near",
          teamVaultIds: ["team.m.near"],
        });
      }
    });

    it("falls back to the unsuffixed variable (default network only, one network served) when the suffixed one names nothing", () => {
      const env = loadEnv({
        ...one,
        NEAR_RPC_URLS_TESTNET: " , ",
        TEAM_VAULT_IDS_TESTNET: ",",
        PROBARION_VAULT_ID_TESTNET: "  ",
      });
      expect(env.networks.testnet.rpcUrls).toEqual(["https://bare.example"]);
      expect(env.networks.testnet.teamVaultIds).toEqual(["bare-team.testnet"]);
      expect(env.networks.testnet.demoVaultId).toBe("bare-demo.testnet");
    });

    it("lets the default network's suffixed form stand in for the unsuffixed one while one network is served", () => {
      // Step 1 of the flip (docs/runbooks/web-deploy.md): rename the unsuffixed variables to the default network's form.
      const renamed = loadEnv({ ...base, ...suffixed });
      expect(renamed.enabledNetworks).toEqual(["testnet"]);
      expect(renamed.networks.testnet.factoryId).toBe("vaults.t.testnet");
    });
  });

  describe("an unsuffixed variable never applies to the other network", () => {
    const testnetOnly = {
      NEAR_RPC_URLS: "https://testnet-only.example/key",
      NEAR_ARCHIVAL_RPC_URLS: "https://testnet-archival.example",
      PROBARION_FACTORY_ID: "vaults.staging.testnet",
      PROBARION_VAULT_ID: "demo.staging.testnet",
      CANARY_VAULT_ID: "canary.staging.testnet",
      TEAM_VAULT_IDS: "team.staging.testnet",
    };
    const mainnetOnly = {
      NEAR_RPC_URLS: "https://mainnet-only.example/key",
      NEAR_ARCHIVAL_RPC_URLS: "https://mainnet-archival.example",
      PROBARION_FACTORY_ID: "vaults.staging.near",
      PROBARION_VAULT_ID: "demo.staging.near",
      CANARY_VAULT_ID: "canary.staging.near",
      TEAM_VAULT_IDS: "team.staging.near",
    };

    it("not testnet's RPCs, factory, demo, Canary or team vaults on mainnet, which is not served", () => {
      const env = loadEnv({ ...base, ...testnetOnly });
      expect(env.networks.mainnet.enabled).toBe(false);
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
      const env = loadEnv({ ...base, NEAR_NETWORK: "mainnet", ...mainnetOnly });
      expect(env.networks.mainnet.rpcUrls).toEqual(["https://mainnet-only.example/key"]);
      expect(env.networks.testnet).toMatchObject({
        enabled: false,
        rpcUrls: ["https://rpc.testnet.fastnear.com"],
        archivalRpcUrls: [],
        factoryId: "vaults.probarion.testnet",
        demoVaultId: null,
        canaryVaultId: null,
        teamVaultIds: [],
      });
    });
  });

  // W-NET fix round 1, ruling 2a: a flip of NEAR_NETWORK re-points the unsuffixed variables to the other network, so
  // while both networks are served they are refused: the flip then changes nothing but the default.
  describe("both networks served: an unsuffixed per-network variable is refused", () => {
    const SENTINEL = "SENTINEL";
    const served = { ...base, APP_ORIGIN_MAINNET: "https://mainnet.probarion.xyz" };
    const values: Record<(typeof PER_NETWORK_ENV_NAMES)[number], string> = {
      NEAR_RPC_URLS: `https://${SENTINEL}.example/key`,
      NEAR_ARCHIVAL_RPC_URLS: `https://${SENTINEL}-archival.example`,
      PROBARION_FACTORY_ID: `factory-${SENTINEL.toLowerCase()}.testnet`,
      PROBARION_VAULT_ID: `demo-${SENTINEL.toLowerCase()}.testnet`,
      CANARY_VAULT_ID: `canary-${SENTINEL.toLowerCase()}.testnet`,
      TEAM_VAULT_IDS: `team-${SENTINEL.toLowerCase()}.testnet`,
    };

    it.each(PER_NETWORK_ENV_NAMES)(
      "%s: names the variable and the two forms, and never the value",
      (name) => {
        let message = "";
        try {
          loadEnv({ ...served, [name]: values[name] });
        } catch (e) {
          expect(e).toBeInstanceOf(EnvError);
          message = (e as Error).message;
        }
        expect(message).toContain(
          `${name} must not be set while both networks are served: set ${name}_MAINNET or ${name}_TESTNET`,
        );
        expect(message.toLowerCase()).not.toContain(SENTINEL.toLowerCase());
      },
    );

    it("is the same with mainnet as the default network", () => {
      expect(() =>
        loadEnv({
          ...base,
          NEAR_NETWORK: "mainnet",
          APP_ORIGIN_TESTNET: "https://testnet.probarion.xyz",
          PROBARION_FACTORY_ID: "vaults.probarion.near",
        }),
      ).toThrow(/PROBARION_FACTORY_ID must not be set while both networks are served/);
    });

    it("names every unsuffixed variable that is set, in one error", () => {
      let message = "";
      try {
        loadEnv({ ...served, ...values });
      } catch (e) {
        message = (e as Error).message;
      }
      for (const name of PER_NETWORK_ENV_NAMES)
        expect(message).toContain(`${name} must not be set`);
    });

    it("counts a blank value or a list of only commas as unset", () => {
      const env = loadEnv({
        ...served,
        NEAR_RPC_URLS: "  ",
        TEAM_VAULT_IDS: " , ,",
        CANARY_VAULT_ID: "",
      });
      expect(env.enabledNetworks).toEqual(["mainnet", "testnet"]);
    });

    it("accepts every suffixed form, and the flip then changes only the default network", () => {
      const suffixed = {
        NEAR_RPC_URLS_MAINNET: "https://m.example",
        NEAR_RPC_URLS_TESTNET: "https://t.example",
        PROBARION_FACTORY_ID_MAINNET: "vaults.m.near",
        PROBARION_FACTORY_ID_TESTNET: "vaults.t.testnet",
        CANARY_VAULT_ID_MAINNET: "canary.m.near",
        CANARY_VAULT_ID_TESTNET: "canary.t.testnet",
      };
      // Both origins are set before the flip (step 3 of the runbook): each network keeps its own address.
      const origins = { ...served, APP_ORIGIN_TESTNET: "https://testnet.probarion.xyz" };
      const before = loadEnv({ ...origins, ...suffixed });
      const after = loadEnv({ ...origins, ...suffixed, NEAR_NETWORK: "mainnet" });
      expect(after.defaultNetwork).toBe("mainnet");
      expect(after.networks).toEqual(before.networks);
    });

    it("leaves one network served exactly as it was: every unsuffixed variable still applies", () => {
      const env = loadEnv({ ...base, ...values });
      expect(env.enabledNetworks).toEqual(["testnet"]);
      expect(env.networks.testnet.factoryId).toBe(values.PROBARION_FACTORY_ID);
    });
  });

  // Ruling 2b: an account id belongs to one network. A leftover from the other one is refused, whichever variable
  // supplied it and whether or not the network is served.
  describe("an account id must match its network", () => {
    const SENTINEL = "sentinel";
    const messageFor = (src: Record<string, string>): string => {
      try {
        loadEnv({ ...base, ...src });
      } catch (e) {
        expect(e).toBeInstanceOf(EnvError);
        return (e as Error).message;
      }
      return expect.unreachable("loadEnv should have thrown");
    };

    it.each([
      ["PROBARION_FACTORY_ID_MAINNET", `vaults.${SENTINEL}.testnet`],
      ["PROBARION_VAULT_ID_MAINNET", `demo.${SENTINEL}.testnet`],
      ["CANARY_VAULT_ID_MAINNET", `canary.${SENTINEL}.testnet`],
      ["TEAM_VAULT_IDS_MAINNET", `ok.near,team.${SENTINEL}.testnet`],
    ])("refuses a testnet id in %s, naming the variable and never the value", (name, value) => {
      const message = messageFor({ [name]: value });
      expect(message).toContain(name);
      expect(message).toMatch(/is not a mainnet account/);
      expect(message).not.toContain(SENTINEL);
    });

    it.each([
      ["PROBARION_FACTORY_ID_TESTNET", `vaults.${SENTINEL}.near`],
      ["PROBARION_VAULT_ID_TESTNET", `demo.${SENTINEL}.near`],
      ["CANARY_VAULT_ID_TESTNET", `canary.${SENTINEL}.near`],
      ["TEAM_VAULT_IDS_TESTNET", `ok.testnet,team.${SENTINEL}.near`],
    ])("refuses a mainnet id in %s, naming the variable and never the value", (name, value) => {
      const message = messageFor({ [name]: value });
      expect(message).toContain(name);
      expect(message).toMatch(/is not a testnet account/);
      expect(message).not.toContain(SENTINEL);
    });

    it("names the unsuffixed variable when that is what supplied the value (one network served)", () => {
      // The flip's trap: testnet ids left in the unsuffixed names while mainnet is the default.
      const message = messageFor({
        NEAR_NETWORK: "mainnet",
        PROBARION_FACTORY_ID: "vaults.probarion.testnet",
        TEAM_VAULT_IDS: "team.probarion.testnet",
      });
      expect(message).toMatch(/PROBARION_FACTORY_ID /);
      expect(message).toMatch(/TEAM_VAULT_IDS entry 1/);
      expect(message).not.toContain("vaults.probarion.testnet");
    });

    it("names the entry by position", () => {
      expect(messageFor({ TEAM_VAULT_IDS_TESTNET: "a.testnet,b.near,c.testnet" })).toMatch(
        /TEAM_VAULT_IDS_TESTNET entry 2 /,
      );
    });

    it("accepts the ids of its own network, BASE's staging ids included", () => {
      const env = loadEnv({
        ...base,
        PROBARION_FACTORY_ID: "vaults.staging.testnet",
        PROBARION_VAULT_ID: "v0.probarion.testnet",
        TEAM_VAULT_IDS: "team.vaults.staging.testnet",
        PROBARION_FACTORY_ID_MAINNET: "vaults.probarion.near",
        CANARY_VAULT_ID_MAINNET: "canary.vaults.probarion.near",
      });
      expect(env.networks.mainnet.canaryVaultId).toBe("canary.vaults.probarion.near");
    });

    it("lets a named-by-key id through on either network: 64 hex, and 0x with 40 hex", () => {
      const implicit = "a".repeat(64);
      const eth = `0x${"b".repeat(40)}`;
      for (const id of [implicit, eth]) {
        const env = loadEnv({
          ...base,
          PROBARION_VAULT_ID_MAINNET: id,
          CANARY_VAULT_ID_TESTNET: id,
          TEAM_VAULT_IDS_MAINNET: `${id},team.near`,
          TEAM_VAULT_IDS_TESTNET: `${id},team.testnet`,
        });
        expect(env.networks.mainnet.demoVaultId).toBe(id);
        expect(env.networks.testnet.canaryVaultId).toBe(id);
      }
    });

    it("checks a network that is not served too (its rows can be shown)", () => {
      expect(() =>
        loadEnv({ ...base, CANARY_VAULT_ID_MAINNET: "canary.probarion.testnet" }),
      ).toThrow(/CANARY_VAULT_ID_MAINNET/);
    });
  });

  // Ruling 2c, config: an RPC URL whose host carries the other network's name is refused, without echoing the URL (it can
  // hold an API key).
  describe("an RPC URL must match its network", () => {
    const SENTINEL = "SENTINEL";
    const messageFor = (src: Record<string, string>): string => {
      try {
        loadEnv({ ...base, ...src });
      } catch (e) {
        expect(e).toBeInstanceOf(EnvError);
        return (e as Error).message;
      }
      return expect.unreachable("loadEnv should have thrown");
    };

    it.each([
      ["NEAR_RPC_URLS_MAINNET", `https://rpc.testnet.fastnear.com/${SENTINEL}`],
      ["NEAR_ARCHIVAL_RPC_URLS_MAINNET", `https://archival-rpc.testnet.fastnear.com/${SENTINEL}`],
      ["NEAR_RPC_URLS_MAINNET", `https://testnet.rpc.example/${SENTINEL}`],
      ["NEAR_RPC_URLS_MAINNET", `https://near-testnet.example/${SENTINEL}`],
      ["NEAR_RPC_URLS_MAINNET", `https://RPC.TESTNET.example/${SENTINEL}`],
    ])("refuses a testnet host in %s", (name, url) => {
      const message = messageFor({ [name]: `https://ok.example,${url}` });
      expect(message).toMatch(new RegExp(`${name} entry 2 `));
      expect(message).toContain("testnet");
      expect(message).not.toContain(SENTINEL);
      expect(message).not.toContain("fastnear");
    });

    it.each([
      ["NEAR_RPC_URLS_TESTNET", `https://rpc.mainnet.fastnear.com/${SENTINEL}`],
      ["NEAR_ARCHIVAL_RPC_URLS_TESTNET", `https://archival-rpc.mainnet.fastnear.com/${SENTINEL}`],
    ])("refuses a mainnet host in %s", (name, url) => {
      const message = messageFor({ [name]: url });
      expect(message).toMatch(new RegExp(`${name} entry 1 `));
      expect(message).toContain("mainnet");
      expect(message).not.toContain(SENTINEL);
    });

    it("names the unsuffixed variable that supplied the value", () => {
      const message = messageFor({
        NEAR_NETWORK: "mainnet",
        NEAR_RPC_URLS: `https://rpc.testnet.fastnear.com/${SENTINEL}`,
      });
      expect(message).toMatch(/NEAR_RPC_URLS entry 1 /);
      expect(message).not.toContain(SENTINEL);
    });

    it("looks at whole name parts of the host, and only at the host", () => {
      const env = loadEnv({
        ...base,
        NEAR_RPC_URLS_MAINNET: [
          "https://attestnet.example",
          "https://rpc.mainnet.fastnear.com/testnet",
          "https://user@rpc.example/?network=testnet",
          "http://localhost:3030",
        ].join(","),
        NEAR_RPC_URLS_TESTNET:
          "https://rpc.testnet.fastnear.com,https://mainnetwork.example,http://127.0.0.1:3030",
      });
      expect(env.networks.mainnet.rpcUrls).toHaveLength(4);
      expect(env.networks.testnet.rpcUrls).toHaveLength(3);
    });

    it("accepts the built-in providers of each network", () => {
      const env = loadEnv({
        ...base,
        NEAR_RPC_URLS_MAINNET: "https://rpc.mainnet.fastnear.com,https://rpc.intea.rs",
        NEAR_RPC_URLS_TESTNET: "https://rpc.testnet.fastnear.com",
        NEAR_ARCHIVAL_RPC_URLS_TESTNET: "https://archival-rpc.testnet.fastnear.com",
        NEAR_ARCHIVAL_RPC_URLS_MAINNET: "https://archival-rpc.mainnet.fastnear.com",
      });
      expect(env.networks.mainnet.archivalRpcUrls).toEqual([
        "https://archival-rpc.mainnet.fastnear.com",
      ]);
    });

    it("checks a network that is not served too", () => {
      expect(() =>
        loadEnv({ ...base, NEAR_RPC_URLS_MAINNET: "https://rpc.testnet.fastnear.com" }),
      ).toThrow(/NEAR_RPC_URLS_MAINNET entry 1 /);
    });
  });

  // Fix round 1, item 10: the default network's origin is built from VERCEL_PROJECT_PRODUCTION_URL when its own is unset.
  // A value that does not make an origin stops the console: a network that is served has an address.
  describe("the default network's origin", () => {
    it("is refused, naming VERCEL_PROJECT_PRODUCTION_URL, when it does not make an origin", () => {
      for (const bad of [
        "bad host with spaces",
        "probarion.vercel.app/path",
        "probarion.vercel.app?x",
        "a@b.example",
      ]) {
        let message = "";
        try {
          loadEnv({ ...base, VERCEL_PROJECT_PRODUCTION_URL: bad });
        } catch (e) {
          expect(e).toBeInstanceOf(EnvError);
          message = (e as Error).message;
        }
        expect(message, bad).toContain("VERCEL_PROJECT_PRODUCTION_URL");
        expect(message, bad).not.toContain("with spaces");
        expect(message, bad).not.toContain("/path");
      }
    });

    it("does not blame the production address when APP_ORIGIN_<NET> is what is wrong", () => {
      let message = "";
      try {
        loadEnv({
          ...base,
          APP_ORIGIN_TESTNET: "https://a.example/x",
          VERCEL_PROJECT_PRODUCTION_URL: "ok.example",
        });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("APP_ORIGIN_TESTNET");
      expect(message).not.toContain("VERCEL_PROJECT_PRODUCTION_URL");
    });

    it("never leaves a served network without an origin", () => {
      for (const src of [
        base,
        { ...base, VERCEL_PROJECT_PRODUCTION_URL: "probarion.vercel.app" },
        { ...base, VERCEL_PROJECT_PRODUCTION_URL: "  " },
        { ...base, NEAR_NETWORK: "mainnet", APP_ORIGIN_TESTNET: "https://t.example" },
      ]) {
        const env = loadEnv(src);
        for (const network of env.enabledNetworks) {
          expect(env.networks[network].origin, JSON.stringify(src)).not.toBeNull();
        }
      }
    });

    it("keeps the local-development fallback when neither variable is set", () => {
      expect(loadEnv(base).networks.testnet.origin).toBe("http://localhost:3000");
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

describe("an origin with a trailing dot (fix round 1)", () => {
  it("counts as the same host as the one without it", () => {
    expect(() =>
      loadEnv({
        ...base,
        APP_ORIGIN_MAINNET: "https://probarion.example.",
        APP_ORIGIN_TESTNET: "https://probarion.example",
      }),
    ).toThrow(/APP_ORIGIN_MAINNET must not have the same host/);
    expect(() =>
      loadEnv({
        ...base,
        VERCEL_PROJECT_PRODUCTION_URL: "probarion.example",
        APP_ORIGIN_MAINNET: "https://probarion.example.",
      }),
    ).toThrow(/APP_ORIGIN_MAINNET must not have the same host/);
  });

  it("is stored without the dot, and matches the request", async () => {
    const env = loadEnv({ ...base, APP_ORIGIN_MAINNET: "https://mainnet.probarion.example." });
    expect(env.networks.mainnet.origin).toBe("https://mainnet.probarion.example");
    const { networkForRequestHost } = await import("./network");
    expect(networkForRequestHost("mainnet.probarion.example.", env)).toBe("mainnet");
    expect(networkForRequestHost("mainnet.probarion.example", env)).toBe("mainnet");
  });
});
