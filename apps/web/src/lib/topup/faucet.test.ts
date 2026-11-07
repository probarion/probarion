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
  faucetConfigured,
  faucetDay,
  faucetDeadline,
  faucetLate,
  faucetMintTx,
  faucetSender,
  MIN_ALLOWANCE,
  SEND_MIN_MS,
  untilMidnightUtc,
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

  it("keeps one counter per vault, per owner account and for all vaults, each on testnet and for one UTC day", () => {
    const day = "2026-11-07";
    expect(FAUCET_BUCKETS.vault("acme.vaults.probarion.testnet", day)).toBe(
      "faucet:testnet:vault:acme.vaults.probarion.testnet:2026-11-07",
    );
    expect(FAUCET_BUCKETS.account("acme.testnet", day)).toBe(
      "faucet:testnet:account:acme.testnet:2026-11-07",
    );
    expect(FAUCET_BUCKETS.global(day)).toBe("faucet:testnet:all:2026-11-07");
    // A bucket is at most 200 characters, and an account id at most 64.
    expect(FAUCET_BUCKETS.vault("a".repeat(64), day).length).toBeLessThanOrEqual(200);
    expect(FAUCET_BUCKETS.account("a".repeat(64), day).length).toBeLessThanOrEqual(200);
  });

  it("names the day in UTC, and counts the seconds to the next midnight UTC", () => {
    expect(faucetDay(new Date("2026-11-07T23:59:59.999Z"))).toBe("2026-11-07");
    expect(faucetDay(new Date("2026-11-08T00:00:00.000Z"))).toBe("2026-11-08");
    expect(untilMidnightUtc(new Date("2026-11-07T19:00:00.000Z"))).toBe(5 * 3600);
    expect(untilMidnightUtc(new Date("2026-11-08T00:00:00.000Z"))).toBe(86_400);
    expect(untilMidnightUtc(new Date("2026-11-07T23:59:59.999Z"))).toBe(1);
    expect(untilMidnightUtc(new Date("2026-12-31T12:00:00.000Z"))).toBe(12 * 3600);
  });

  it("lets the key's allowance run down to 0.01 NEAR, a few mints' worth", () => {
    expect(MIN_ALLOWANCE).toBe(10_000_000_000_000_000_000_000n);
  });
});

describe("the faucet's time on NEAR", () => {
  it("leaves the send at least SEND_MIN_MS of the 45 s budget, else refuses before counting", async () => {
    const start = 1_000_000;
    const deadline = faucetDeadline(start);
    expect(deadline - start).toBe(45_000);
    expect(SEND_MIN_MS).toBe(30_000);
    expect(faucetLate(deadline, start + 15_000)).toBeNull();
    const late = faucetLate(deadline, start + 15_001);
    expect(late?.status).toBe(503);
    expect(await late?.json()).toEqual({
      error: "unavailable",
      detail: faucetCopy(FAUCET_USDC).slow,
    });
  });
});

describe("faucetSender", () => {
  it("signs with the key as probarion.testnet", () => {
    const pair = KeyPair.fromRandom("ed25519");
    const sender = faucetSender("testnet", pair.toString(), faucetDeadline());
    expect(sender?.accountId).toBe("probarion.testnet");
    expect(sender?.publicKey).toBe(pair.getPublicKey().toString());
    expect(faucetConfigured("testnet", pair.toString())).toBe(true);
  });

  it("is null for a value that is not a secret key, and logs neither the value nor its text", () => {
    for (const bad of ["ed25519:abc", "not-a-key", "ed25519:".padEnd(100, "Z")]) {
      expect(faucetSender("testnet", bad, faucetDeadline())).toBeNull();
    }
    expect(logs.lines.length).toBe(3);
    // The page shows the button only for a key the route can sign with.
    expect(faucetConfigured("testnet", null)).toBe(false);
    expect(faucetConfigured("testnet", "not-a-key")).toBe(false);
    for (const line of logs.lines) {
      expect(line).toContain("faucet.key_invalid");
      expect(line).not.toContain("not-a-key");
      expect(line).not.toContain("ZZZZ");
    }
  });
});
