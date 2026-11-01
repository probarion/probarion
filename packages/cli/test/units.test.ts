import { TEST_KEYS } from "@probarion/sdk/testing";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { parsePayeeArg } from "../src/payee.js";
import {
  assertPositive,
  canonicalNear,
  hoursToNs,
  nearToYocto,
  parseExpiry,
  positiveInt,
  toSmallestUnits,
  yoctoToNear,
} from "../src/units.js";
import { NOW } from "./helpers.js";

// A valid Solana address built at run time (an ed25519 public key is base58 of 32 bytes), so no
// address-shaped literal sits in the source for the history scanner to flag.
const SOLANA_ADDRESS = TEST_KEYS.agent.publicKey.slice("ed25519:".length);

describe("amount conversions", () => {
  it("converts human USDC with USDC_DECIMALS", () => {
    expect(toSmallestUnits("25")).toBe("25000000");
    expect(toSmallestUnits("0.000001")).toBe("1");
    expect(toSmallestUnits(" 100.5 ")).toBe("100500000");
  });

  it.each(["1.2345678", "-1", "1e3", "", "025", ".5", "1,5"])("rejects %j", (value) => {
    expect(() => toSmallestUnits(value)).toThrow(CliError);
  });

  it("refuses an amount that does not fit the contract's U128", () => {
    const u128Max = (1n << 128n) - 1n;
    expect(nearToYocto("340282366920938.463463374607431768211455")).toBe(u128Max.toString());
    expect(() => nearToYocto("340282366920938.463463374607431768211456")).toThrow(/too large/);
    expect(() => toSmallestUnits("9".repeat(40))).toThrow(/too large/);
  });

  it("converts NEAR to yocto and back", () => {
    expect(nearToYocto("1")).toBe(`1${"0".repeat(24)}`);
    expect(nearToYocto("0.00125")).toBe("1250000000000000000000");
    expect(yoctoToNear("5000000000000000000000000")).toBe("5");
    expect(yoctoToNear("1250000000000000000000")).toBe("0.00125");
  });

  it("prints a NEAR amount in one canonical form, whatever spelling it was typed in", () => {
    expect(canonicalNear("5.00", "--deposit")).toBe("5");
    expect(canonicalNear(" 0.10 ", "--deposit")).toBe("0.1");
    expect(canonicalNear("2.49", "--deposit")).toBe("2.49");
    expect(() => canonicalNear("5 NEAR", "--deposit")).toThrow(CliError);
  });

  it("refuses a zero amount where the contract does", () => {
    expect(assertPositive("1", "--amount")).toBe("1");
    expect(() => assertPositive("0", "--amount")).toThrow(/above 0/);
  });

  it("converts hours and expiry dates to nanoseconds", () => {
    expect(hoursToNs("72")).toBe("259200000000000");
    expect(parseExpiry("2026-12-31", NOW)).toBe("1798761599999000000");
    expect(parseExpiry("2027-01-01T00:00:00Z", NOW)).toBe("1798761600000000000");
    expect(() => parseExpiry("2026-01-01", NOW)).toThrow(/not in the future/);
    expect(() => parseExpiry("next week", NOW)).toThrow(CliError);
  });

  it("reads an ISO time with an offset, and fractions of a second, exactly", () => {
    // 2027-01-01T00:00:00+07:00 is 2026-12-31T17:00:00Z.
    expect(parseExpiry("2027-01-01T00:00:00+07:00", NOW)).toBe("1798736400000000000");
    expect(parseExpiry("2027-01-01T00:00:00.5Z", NOW)).toBe("1798761600500000000");
    expect(parseExpiry("2027-01-01T00:00:00.123456789Z", NOW)).toBe("1798761600123456789");
    expect(parseExpiry("2027-01-01T00:00Z", NOW)).toBe("1798761600000000000");
  });

  it.each([
    ["a day that does not exist", "2026-02-31"],
    ["a leap day in a common year", "2027-02-29T00:00:00Z"],
    ["month 13", "2026-13-01"],
    ["a time without a zone", "2026-12-31T10:00:00"],
    ["a local-time spelling", "2026-12-31 10:00"],
    ["a month name", "Dec 31 2026"],
    ["hour 24", "2026-12-31T24:00:00Z"],
    ["a year past what u64 nanoseconds can hold", "9999-12-31"],
  ])("rejects an expiry with %s", (_name, value) => {
    expect(() => parseExpiry(value, NOW)).toThrow(CliError);
  });

  it("accepts a leap day in a leap year", () => {
    expect(parseExpiry("2028-02-29", NOW)).toBe("1835481599999000000");
  });

  it("parses positive integers only", () => {
    expect(positiveInt("10", "--uses")).toBe(10);
    for (const bad of ["0", "-1", "1.5", "", "01", "1000000000"]) {
      expect(() => positiveInt(bad, "--uses")).toThrow(CliError);
    }
  });
});

describe("parsePayeeArg", () => {
  it("parses NEAR, Base and Solana payees with the network's POA asset", () => {
    expect(parsePayeeArg("near:vendor.testnet", "testnet")).toEqual({
      type: "near",
      account_id: "vendor.testnet",
    });
    expect(parsePayeeArg("base:0x1111111111111111111111111111111111111111", "mainnet")).toEqual({
      type: "intents",
      chain: "base",
      address: "0x1111111111111111111111111111111111111111",
      asset: "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    });
    expect(parsePayeeArg(`solana:${SOLANA_ADDRESS}`, "testnet")).toMatchObject({
      chain: "solana",
      address: SOLANA_ADDRESS,
      asset: "sol-usdc.probarion.testnet",
    });
  });

  it.each([
    "vendor.testnet",
    "near:Vendor.testnet",
    "base:0x123",
    "eth:0x1111111111111111111111111111111111111111",
  ])("rejects %j", (value) => {
    expect(() => parsePayeeArg(value, "testnet")).toThrow(CliError);
  });
});
