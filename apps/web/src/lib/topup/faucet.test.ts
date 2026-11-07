import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORKS, USDC_DECIMALS } from "@probarion/core";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { quietLogs } from "../../../test/fixtures/quiet-logs";
import { faucetCopy } from "./copy";
import {
  FAUCET_BUCKETS,
  FAUCET_GAS,
  FAUCET_SIGNER,
  FAUCET_UNITS,
  FAUCET_USDC,
  faucetMintTx,
  faucetSender,
} from "./faucet";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const logs = quietLogs();

describe("the faucet's mint", () => {
  it("mints the fixed 25 test USDC, in the token's 6 decimals", () => {
    expect(USDC_DECIMALS).toBe(6);
    expect(FAUCET_USDC).toBe("25");
    expect(FAUCET_UNITS).toBe("25000000");
    expect(faucetCopy(FAUCET_USDC).title).toBe("Add 25 test USDC to this vault");
  });

  it("calls mint on this network's test USDC, for the vault, with no deposit", () => {
    expect(faucetMintTx("acme.vaults.probarion.testnet")).toEqual({
      receiverId: NETWORKS.testnet.usdc,
      methodName: "mint",
      args: { account_id: "acme.vaults.probarion.testnet", amount: "25000000" },
      gas: 30_000_000_000_000n,
      deposit: 0n,
    });
    expect(NETWORKS.testnet.usdc).toBe("usdc.probarion.testnet");
    expect(FAUCET_GAS).toBe(30_000_000_000_000n);
  });

  it("matches the test token: mint is not payable, owner-only, and registers the account itself", () => {
    const src = read("contracts", "test-ft", "src", "lib.rs");
    const mint =
      /(#\[payable\]\s*)?pub fn mint\(&mut self, account_id: AccountId, amount: U128\)/.exec(src);
    expect(mint).not.toBeNull();
    // A function-call key cannot attach a deposit, so a payable mint could not be called with one.
    expect(mint?.[1]).toBeUndefined();
    expect(src).toContain("env::predecessor_account_id() == self.owner_id");
    expect(src).toContain("self.token.internal_register_account(&account_id);");
  });

  it("signs as the token's owner: the account deploy.sh gives as owner_id", () => {
    const deploy = read("scripts", "testnet", "deploy.sh");
    expect(deploy).toMatch(/^ROOT="\$\{ROOT:-probarion\.testnet\}"$/m);
    expect(deploy).toContain('"{\\"owner_id\\":\\"$ROOT\\"');
    expect(FAUCET_SIGNER).toBe("probarion.testnet");
  });

  it("keeps one counter per vault and one for all vaults, each on testnet", () => {
    expect(FAUCET_BUCKETS.vault("acme.vaults.probarion.testnet")).toBe(
      "faucet:testnet:acme.vaults.probarion.testnet",
    );
    expect(FAUCET_BUCKETS.global).toBe("faucet:testnet");
    // A bucket is at most 200 characters, and an account id at most 64.
    expect(FAUCET_BUCKETS.vault("a".repeat(64)).length).toBeLessThanOrEqual(200);
  });
});

describe("faucetSender", () => {
  it("signs with the key as probarion.testnet", () => {
    const pair = KeyPair.fromRandom("ed25519");
    const sender = faucetSender("testnet", pair.toString());
    expect(sender?.accountId).toBe("probarion.testnet");
    expect(sender?.publicKey).toBe(pair.getPublicKey().toString());
  });

  it("is null for a value that is not a secret key, and logs neither the value nor its text", () => {
    for (const bad of ["ed25519:abc", "not-a-key", "ed25519:".padEnd(100, "Z")]) {
      expect(faucetSender("testnet", bad)).toBeNull();
    }
    expect(logs.lines.length).toBe(3);
    for (const line of logs.lines) {
      expect(line).toContain("faucet.key_invalid");
      expect(line).not.toContain("not-a-key");
      expect(line).not.toContain("ZZZZ");
    }
  });
});
