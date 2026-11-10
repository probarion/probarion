import { join } from "node:path";
import { generateKeyPair } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const HOME = "/home/pilot";
// Keys made from fixed seeds when the test runs, so no secret sits in the repository.
const AGENT = generateKeyPair(new Uint8Array(32).fill(7));
const LEDGER = generateKeyPair(new Uint8Array(32).fill(8));
const valid = {
  NEAR_NETWORK: "testnet",
  PROBARION_VAULT_ID: "acme.vaults.probarion.testnet",
  PROBARION_AGENT_KEY: AGENT.secretKey,
  PROBARION_LEDGER_KEY: LEDGER.secretKey,
};

describe("loadConfig", () => {
  it("reads a full config and defaults the RPC URLs and the ledger path", () => {
    expect(loadConfig(valid, HOME)).toMatchObject({
      network: "testnet",
      vault: "acme.vaults.probarion.testnet",
      readOnly: false,
      rpcUrls: ["https://rpc.testnet.fastnear.com"],
      archivalRpcUrls: null,
      agentPublicKey: AGENT.publicKey,
      ledgerPath: join(HOME, ".probarion", "acme.vaults.probarion.testnet", "ledger.jsonl"),
    });
  });

  it("refuses a key that has the prefix but is not an ed25519 secret key, naming only the variable", () => {
    const bad = `ed25519:${"1".repeat(40)}`;
    try {
      loadConfig({ ...valid, PROBARION_LEDGER_KEY: bad }, HOME);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain(
        "PROBARION_LEDGER_KEY is not a valid ed25519 secret key",
      );
      expect((e as Error).message).not.toContain(bad);
    }
  });

  it("refuses an RPC URL with a user name or password, or plain http to another host, archival URLs included", () => {
    for (const [name, url] of [
      ["NEAR_RPC_URLS", "https://user:pass@rpc.example"],
      ["NEAR_RPC_URLS", "http://rpc.example"],
      ["NEAR_RPC_URLS", "not a url"],
      ["NEAR_ARCHIVAL_RPC_URLS", "https://key@archival.example"],
      ["NEAR_ARCHIVAL_RPC_URLS", "http://archival.example"],
    ] as const) {
      try {
        loadConfig({ ...valid, [name]: url }, HOME);
        expect.unreachable(url);
      } catch (e) {
        expect(e, url).toBeInstanceOf(ConfigError);
        expect((e as Error).message, url).toContain(name);
        expect((e as Error).message, url).not.toContain(url);
      }
    }
    expect(
      loadConfig(
        {
          ...valid,
          NEAR_RPC_URLS: "http://127.0.0.1:3030",
          NEAR_ARCHIVAL_RPC_URLS: "https://a.example",
        },
        HOME,
      ),
    ).toMatchObject({ rpcUrls: ["http://127.0.0.1:3030"], archivalRpcUrls: ["https://a.example"] });
  });

  it("runs read-only when neither key is set, and honours NEAR_RPC_URLS and PROBARION_LEDGER_PATH", () => {
    const c = loadConfig(
      {
        NEAR_NETWORK: "mainnet",
        PROBARION_VAULT_ID: "acme.vaults.probarion.near",
        NEAR_RPC_URLS: "https://a.example, https://b.example",
        PROBARION_LEDGER_PATH: "/data/l.jsonl",
      },
      HOME,
    );
    expect(c).toMatchObject({
      readOnly: true,
      agentKey: null,
      ledgerKey: null,
      rpcUrls: ["https://a.example", "https://b.example"],
      ledgerPath: "/data/l.jsonl",
    });
  });

  it("takes the network from the vault's name when NEAR_NETWORK is not set", () => {
    const { NEAR_NETWORK: _, ...rest } = valid;
    expect(loadConfig(rest, HOME).network).toBe("testnet");
    expect(
      loadConfig({ PROBARION_VAULT_ID: "acme.vaults.probarion.near", NEAR_NETWORK: " " }, HOME)
        .network,
    ).toBe("mainnet");
    expect(() => loadConfig({ PROBARION_VAULT_ID: "0".repeat(64) }, HOME)).toThrow(
      /NEAR_NETWORK must be "mainnet" or "testnet"/,
    );
  });

  it("treats empty values from .env.example as unset", () => {
    const c = loadConfig(
      { ...valid, PROBARION_AGENT_KEY: " ", PROBARION_LEDGER_KEY: "", PROBARION_LEDGER_PATH: "" },
      HOME,
    );
    expect(c.readOnly).toBe(true);
    expect(c.ledgerPath).toBe(join(HOME, ".probarion", valid.PROBARION_VAULT_ID, "ledger.jsonl"));
  });

  it("names every problem and prints no value", () => {
    try {
      loadConfig(
        {
          NEAR_NETWORK: "devnet",
          PROBARION_VAULT_ID: "Bad Vault",
          PROBARION_AGENT_KEY: "secret-agent-value",
          NEAR_RPC_URLS: "http://insecure.example",
        },
        HOME,
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const m = (e as Error).message;
      for (const name of [
        "NEAR_NETWORK",
        "PROBARION_VAULT_ID",
        "PROBARION_AGENT_KEY",
        "PROBARION_LEDGER_KEY",
        "NEAR_RPC_URLS",
      ]) {
        expect(m).toContain(name);
      }
      expect(m).not.toContain("secret-agent-value");
      expect(m).not.toContain("insecure.example");
    }
  });

  it("catches a testnet vault configured for mainnet, and the other way round", () => {
    expect(() => loadConfig({ ...valid, NEAR_NETWORK: "mainnet" }, HOME)).toThrow(
      /looks like a testnet account/,
    );
    expect(() =>
      loadConfig({ ...valid, PROBARION_VAULT_ID: "acme.vaults.probarion.near" }, HOME),
    ).toThrow(/looks like a mainnet account/);
  });

  it("treats an unexpanded variable reference from an MCP client's config as an invalid key", () => {
    expect(() =>
      loadConfig({ ...valid, PROBARION_AGENT_KEY: ["$", "{PROBARION_AGENT_KEY}"].join("") }, HOME),
    ).toThrow(/must start with "ed25519:"/);
  });
});
