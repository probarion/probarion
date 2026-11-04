import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NETWORKS } from "@probarion/core";
import { TEST_KEYS } from "@probarion/sdk/testing";
import { describe, expect, it } from "vitest";
import {
  factoryIdFor,
  fileExists,
  readPurpose,
  requireVault,
  resolveNetwork,
  rpcUrlsFor,
  splitList,
  writeNewFile,
} from "../src/context.js";
import { CliError } from "../src/errors.js";
import { runCli } from "../src/program.js";
import { tempDir, testIo } from "./helpers.js";

const VAULT = "acme.vaults.probarion.testnet";

describe("resolveNetwork (R12: an empty environment value is unset)", () => {
  it("falls back to testnet when NEAR_NETWORK is empty or blank", () => {
    expect(resolveNetwork({}, { NEAR_NETWORK: "" })).toBe("testnet");
    expect(resolveNetwork({}, { NEAR_NETWORK: "   " })).toBe("testnet");
    expect(resolveNetwork({}, {})).toBe("testnet");
  });

  it("reads NEAR_NETWORK when it is set, and lets the flag win", () => {
    expect(resolveNetwork({}, { NEAR_NETWORK: "mainnet" })).toBe("mainnet");
    expect(resolveNetwork({}, { NEAR_NETWORK: " mainnet " })).toBe("mainnet");
    expect(resolveNetwork({ network: "testnet" }, { NEAR_NETWORK: "mainnet" })).toBe("testnet");
  });

  it("refuses anything else, including an explicitly empty flag", () => {
    expect(() => resolveNetwork({ network: "devnet" }, {})).toThrow(CliError);
    expect(() => resolveNetwork({}, { NEAR_NETWORK: "devnet" })).toThrow(/NEAR_NETWORK|--network/);
    expect(() => resolveNetwork({ network: "" }, { NEAR_NETWORK: "mainnet" })).toThrow(CliError);
  });
});

describe("requireVault, factoryIdFor and rpcUrlsFor read the environment through envValue", () => {
  it("treats an empty PROBARION_VAULT_ID as missing", () => {
    expect(() => requireVault(undefined, { PROBARION_VAULT_ID: "" })).toThrow(/PROBARION_VAULT_ID/);
    expect(() => requireVault(undefined, { PROBARION_VAULT_ID: "  " })).toThrow(
      /PROBARION_VAULT_ID/,
    );
    expect(requireVault(undefined, { PROBARION_VAULT_ID: VAULT })).toBe(VAULT);
    expect(requireVault("other.testnet", { PROBARION_VAULT_ID: VAULT })).toBe("other.testnet");
  });

  it("rejects a vault id that is not an account id", () => {
    expect(() => requireVault("Not A Vault", {})).toThrow(CliError);
  });

  it("uses the network's factory unless PROBARION_FACTORY_ID is really set", () => {
    expect(factoryIdFor("testnet", {})).toBe(NETWORKS.testnet.factory);
    expect(factoryIdFor("testnet", { PROBARION_FACTORY_ID: "" })).toBe(NETWORKS.testnet.factory);
    expect(factoryIdFor("mainnet", { PROBARION_FACTORY_ID: " " })).toBe(NETWORKS.mainnet.factory);
    expect(factoryIdFor("mainnet", { PROBARION_FACTORY_ID: "f.near" })).toBe("f.near");
    expect(() => factoryIdFor("mainnet", { PROBARION_FACTORY_ID: "No Way" })).toThrow(
      /PROBARION_FACTORY_ID/,
    );
  });

  it("falls back to the network RPC URLs when NEAR_RPC_URLS is empty", () => {
    expect(rpcUrlsFor({}, { NEAR_RPC_URLS: "" }, "testnet")).toEqual([...NETWORKS.testnet.rpcUrls]);
    expect(
      rpcUrlsFor({}, { NEAR_RPC_URLS: "http://127.0.0.1:1, http://127.0.0.1:2" }, "testnet"),
    ).toEqual(["http://127.0.0.1:1", "http://127.0.0.1:2"]);
    expect(
      rpcUrlsFor({ rpc: "http://127.0.0.1:3" }, { NEAR_RPC_URLS: "http://127.0.0.1:1" }, "testnet"),
    ).toEqual(["http://127.0.0.1:3"]);
    expect(() => rpcUrlsFor({ rpc: " , " }, {}, "testnet")).toThrow(/--rpc/);
  });

  it("splits a comma list and drops blanks", () => {
    expect(splitList(" a , b,,c ")).toEqual(["a", "b", "c"]);
    expect(splitList("")).toEqual([]);
  });
});

describe("readPurpose", () => {
  it("passes a 64-hex hash through and refuses uppercase hex, which the vault would refuse", async () => {
    const dir = await tempDir();
    const hash = "ab".repeat(32);
    expect(await readPurpose(` ${hash} `, dir)).toBe(hash);
    await expect(readPurpose(hash.toUpperCase(), dir)).rejects.toThrow(CliError);
  });
});

describe("the environment reaches the commands (R12, end to end)", () => {
  it("an empty NEAR_NETWORK prints the testnet default; a set one is honoured", async () => {
    const dir = await tempDir();
    const argv = ["agent", "add", "--vault", VAULT, "--pk", TEST_KEYS.agent.publicKey];
    const empty = testIo(dir, { NEAR_NETWORK: "" });
    expect(await runCli(argv, empty.io)).toBe(0);
    expect(empty.state.out).toContain("network-config testnet sign-with-keychain send");
    const main = testIo(dir, { NEAR_NETWORK: "mainnet" });
    expect(await runCli(argv, main.io)).toBe(0);
    expect(main.state.out).toContain("network-config mainnet sign-with-keychain send");
    const flag = testIo(dir, { NEAR_NETWORK: "mainnet" });
    expect(await runCli(["--network", "testnet", ...argv], flag.io)).toBe(0);
    expect(flag.state.out).toContain("network-config testnet sign-with-keychain send");
  });

  it("an empty PROBARION_VAULT_ID is reported as missing", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir, { PROBARION_VAULT_ID: "" });
    expect(await runCli(["vault", "freeze"], io)).toBe(1);
    expect(state.err).toContain("PROBARION_VAULT_ID");
  });

  it("a mainnet withdraw-intents token resolves to the mainnet POA assets", async () => {
    const dir = await tempDir();
    const { io, state } = testIo(dir, { PROBARION_VAULT_ID: "acme.vaults.probarion.near" });
    expect(
      await runCli(
        ["--network", "mainnet", "vault", "withdraw-intents", "--token", "base", "--amount", "1"],
        io,
      ),
    ).toBe(0);
    expect(state.out).toContain(`"token": "${NETWORKS.mainnet.allowedAssets.base}"`);
    expect(state.out).toContain("network-config mainnet");
  });
});

describe("writeNewFile: an export or a snapshot goes to a new file, never over one", () => {
  it("writes a file that is not there, and refuses one that is (written meanwhile, too)", async () => {
    const dir = await tempDir();
    const path = join(dir, "out.json");
    expect(await fileExists(path)).toBe(false);
    await writeNewFile(path, "first\n", "--snapshot", "out.json");
    expect(await readFile(path, "utf8")).toBe("first\n");
    expect(await fileExists(path)).toBe(true);
    const refused = writeNewFile(path, "second\n", "--snapshot", "out.json");
    await expect(refused).rejects.toThrow("--snapshot out.json already exists: choose a new file");
    await expect(refused).rejects.toBeInstanceOf(CliError);
    expect(await readFile(path, "utf8")).toBe("first\n");
  });
});
