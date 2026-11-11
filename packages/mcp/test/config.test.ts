import { join } from "node:path";
import { generateKeyPair } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const HOME = "/home/pilot";
/** A disk with no keys file on it. */
const NO_FILE = () => null;
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
    expect(loadConfig(valid, HOME, NO_FILE)).toMatchObject({
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
      loadConfig({ ...valid, PROBARION_LEDGER_KEY: bad }, HOME, NO_FILE);
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
        loadConfig({ ...valid, [name]: url }, HOME, NO_FILE);
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
        NO_FILE,
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
      NO_FILE,
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
    expect(loadConfig(rest, HOME, NO_FILE).network).toBe("testnet");
    expect(
      loadConfig(
        { PROBARION_VAULT_ID: "acme.vaults.probarion.near", NEAR_NETWORK: " " },
        HOME,
        NO_FILE,
      ).network,
    ).toBe("mainnet");
    expect(() => loadConfig({ PROBARION_VAULT_ID: "0".repeat(64) }, HOME, NO_FILE)).toThrow(
      /NEAR_NETWORK must be "mainnet" or "testnet"/,
    );
  });

  it("treats empty values from .env.example as unset", () => {
    const c = loadConfig(
      { ...valid, PROBARION_AGENT_KEY: " ", PROBARION_LEDGER_KEY: "", PROBARION_LEDGER_PATH: "" },
      HOME,
      NO_FILE,
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
        NO_FILE,
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
    expect(() => loadConfig({ ...valid, NEAR_NETWORK: "mainnet" }, HOME, NO_FILE)).toThrow(
      /looks like a testnet account/,
    );
    expect(() =>
      loadConfig({ ...valid, PROBARION_VAULT_ID: "acme.vaults.probarion.near" }, HOME, NO_FILE),
    ).toThrow(/looks like a mainnet account/);
  });

  it("treats an unexpanded variable reference from an MCP client's config as an invalid key", () => {
    expect(() =>
      loadConfig(
        { ...valid, PROBARION_AGENT_KEY: ["$", "{PROBARION_AGENT_KEY}"].join("") },
        HOME,
        NO_FILE,
      ),
    ).toThrow(/must start with "ed25519:"/);
  });
});

describe("loadConfig: where the keys come from", () => {
  const VAULT = "acme.vaults.probarion.testnet";
  const DEFAULT_FILE = join(HOME, ".probarion", VAULT, "keys.json");
  const OWN_FILE = "/secure/acme-keys.json";
  // Another pair for the files, so a test can tell which source won.
  const FILE_AGENT = generateKeyPair(new Uint8Array(32).fill(9));
  const FILE_LEDGER = generateKeyPair(new Uint8Array(32).fill(10));
  const SECRETS = [AGENT, LEDGER, FILE_AGENT, FILE_LEDGER].map((k) => k.secretKey);

  const fileText = (vault = VAULT, network = "testnet", over: Record<string, unknown> = {}) =>
    JSON.stringify({
      format: "probarion-mcp-keys/1",
      vault,
      network,
      agent: { public_key: FILE_AGENT.publicKey, secret_key: FILE_AGENT.secretKey },
      ledger: { public_key: FILE_LEDGER.publicKey, secret_key: FILE_LEDGER.secretKey },
      created_at: "2026-11-11T00:00:00.000Z",
      ...over,
    });
  /** A disk holding these files, which records every path it is asked for. */
  const disk = (files: Record<string, string>) => {
    const asked: string[] = [];
    const read = (path: string): string | null => {
      asked.push(path);
      return files[path] ?? null;
    };
    return { read, asked };
  };
  const base = { PROBARION_VAULT_ID: VAULT };
  const envKeys = {
    PROBARION_AGENT_KEY: AGENT.secretKey,
    PROBARION_LEDGER_KEY: LEDGER.secretKey,
  };
  /** The ConfigError message of a config that must not load, checked for every secret. */
  const refusal = (
    env: Record<string, string | undefined>,
    read: (p: string) => string | null,
  ): string => {
    try {
      loadConfig(env, HOME, read);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const m = (e as Error).message;
      for (const s of SECRETS) {
        expect(m.includes(s)).toBe(false);
        expect(m.includes(s.slice("ed25519:".length))).toBe(false);
      }
      return m;
    }
    return expect.unreachable("the config loaded");
  };

  it("takes both env keys first: they win over PROBARION_KEYS_FILE and the default file", () => {
    const { read } = disk({ [DEFAULT_FILE]: fileText(), [OWN_FILE]: fileText() });
    for (const env of [
      { ...base, ...envKeys },
      { ...base, ...envKeys, PROBARION_KEYS_FILE: OWN_FILE },
    ]) {
      expect(loadConfig(env, HOME, read)).toMatchObject({
        keysSource: "env",
        agentKey: AGENT.secretKey,
        ledgerKey: LEDGER.secretKey,
        agentPublicKey: AGENT.publicKey,
        ledgerPublicKey: LEDGER.publicKey,
        readOnly: false,
      });
    }
  });

  it("takes the file PROBARION_KEYS_FILE names next, over the default file", () => {
    const { read, asked } = disk({ [OWN_FILE]: fileText(), [DEFAULT_FILE]: "not even JSON" });
    expect(loadConfig({ ...base, PROBARION_KEYS_FILE: OWN_FILE }, HOME, read)).toMatchObject({
      keysSource: `file:${OWN_FILE}`,
      agentKey: FILE_AGENT.secretKey,
      ledgerKey: FILE_LEDGER.secretKey,
      agentPublicKey: FILE_AGENT.publicKey,
      ledgerPublicKey: FILE_LEDGER.publicKey,
      readOnly: false,
    });
    expect(asked).toEqual([OWN_FILE]);
  });

  it("picks up ~/.probarion/<vault>/keys.json when it exists, and is read-only when it does not", () => {
    const { read } = disk({ [DEFAULT_FILE]: fileText() });
    expect(loadConfig(base, HOME, read)).toMatchObject({
      keysSource: `file:${DEFAULT_FILE}`,
      agentPublicKey: FILE_AGENT.publicKey,
      ledgerPublicKey: FILE_LEDGER.publicKey,
      readOnly: false,
      ledgerPath: join(HOME, ".probarion", VAULT, "ledger.jsonl"),
    });
    expect(loadConfig(base, HOME, NO_FILE)).toMatchObject({
      keysSource: "none",
      agentKey: null,
      ledgerKey: null,
      agentPublicKey: null,
      ledgerPublicKey: null,
      readOnly: true,
    });
  });

  it("refuses one env key with a keys file: PROBARION_KEYS_FILE or the default file", () => {
    for (const one of [
      { PROBARION_AGENT_KEY: AGENT.secretKey },
      { PROBARION_LEDGER_KEY: LEDGER.secretKey },
    ]) {
      const named = refusal({ ...base, ...one, PROBARION_KEYS_FILE: OWN_FILE }, disk({}).read);
      expect(named).toContain(
        "or neither to take both keys from the keys file PROBARION_KEYS_FILE names: one key from the environment and the other from a file is refused",
      );
      const found = refusal({ ...base, ...one }, disk({ [DEFAULT_FILE]: fileText() }).read);
      expect(found).toContain(`or neither to take both keys from the keys file ${DEFAULT_FILE}`);
      // With no file in play, it is the plain "both or neither".
      expect(refusal({ ...base, ...one }, NO_FILE)).toContain(
        "set both PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY, or neither for read-only mode",
      );
    }
  });

  it("refuses a PROBARION_KEYS_FILE that does not exist, or is not an absolute path", () => {
    expect(refusal({ ...base, PROBARION_KEYS_FILE: OWN_FILE }, NO_FILE)).toContain(
      `PROBARION_KEYS_FILE names ${OWN_FILE}, which does not exist`,
    );
    for (const relative of ["keys.json", "./keys.json", "~/.probarion/keys.json"]) {
      expect(
        refusal({ ...base, PROBARION_KEYS_FILE: relative }, disk({ [relative]: fileText() }).read),
      ).toContain("PROBARION_KEYS_FILE must be an absolute path");
    }
  });

  it("names a keys file that cannot be read, by its error code only", () => {
    const denied = () => {
      throw Object.assign(new Error(`EACCES: permission denied, open ${AGENT.secretKey}`), {
        code: "EACCES",
      });
    };
    expect(refusal(base, denied)).toContain(
      `the keys file ${DEFAULT_FILE} could not be read (EACCES)`,
    );
    expect(refusal({ ...base, PROBARION_KEYS_FILE: OWN_FILE }, denied)).toContain(
      `the keys file ${OWN_FILE} could not be read (EACCES)`,
    );
  });

  it("refuses a keys file for another vault or network, or with a bad key, naming file and field only", () => {
    const cases: [string, string][] = [
      [fileText("other.vaults.probarion.testnet"), "vault is not acme.vaults.probarion.testnet"],
      [fileText(VAULT, "mainnet"), "network is not testnet"],
      [
        fileText(VAULT, "testnet", {
          agent: { public_key: FILE_LEDGER.publicKey, secret_key: FILE_AGENT.secretKey },
        }),
        "agent.public_key is not the public half of agent.secret_key",
      ],
      [`{"agent":{"secret_key":"${FILE_AGENT.secretKey}`, "is not valid JSON"],
    ];
    for (const [text, want] of cases) {
      const m = refusal(base, disk({ [DEFAULT_FILE]: text }).read);
      expect(m).toContain(`keys file ${DEFAULT_FILE}`);
      expect(m).toContain(want);
    }
  });

  it("refuses the same key as both env keys", () => {
    expect(
      refusal(
        { ...base, PROBARION_AGENT_KEY: AGENT.secretKey, PROBARION_LEDGER_KEY: AGENT.secretKey },
        NO_FILE,
      ),
    ).toContain("PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY are the same key");
  });

  it("reads a .near vault as mainnet, and wants a mainnet keys file for it", () => {
    const vault = "acme.vaults.probarion.near";
    const path = join(HOME, ".probarion", vault, "keys.json");
    const c = loadConfig(
      { PROBARION_VAULT_ID: vault },
      HOME,
      disk({ [path]: fileText(vault, "mainnet") }).read,
    );
    expect(c).toMatchObject({ network: "mainnet", keysSource: `file:${path}`, readOnly: false });
    expect(c.rpcUrls.some((u) => u.includes("testnet"))).toBe(false);
    expect(
      refusal({ PROBARION_VAULT_ID: vault }, disk({ [path]: fileText(vault, "testnet") }).read),
    ).toContain("network is not mainnet");
  });

  it("refuses a vault id that is not a NEAR account id before it goes into any path", () => {
    for (const vault of [
      "../escape.testnet",
      "..",
      "a/../b.testnet",
      "a/b.testnet",
      "a\\b.testnet",
      "C:\\x.testnet",
      "Acme.testnet",
      "acme..testnet",
      ".testnet",
      "acme.testnet/",
      "acme .testnet",
      "%2e%2e.testnet",
    ]) {
      const { read, asked } = disk({});
      const m = refusal({ PROBARION_VAULT_ID: vault, NEAR_NETWORK: "testnet" }, read);
      expect(m, vault).toContain("PROBARION_VAULT_ID must be a NEAR account id");
      expect(asked, vault).toEqual([]);
    }
  });
});
