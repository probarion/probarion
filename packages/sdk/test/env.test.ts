import { describe, expect, it } from "vitest";
import { envValue } from "../src/env.js";

describe("envValue (R12)", () => {
  it("returns a set value", () => {
    expect(envValue({ NEAR_NETWORK: "mainnet" }, "NEAR_NETWORK")).toBe("mainnet");
  });

  it("treats a missing, empty or whitespace-only value as unset", () => {
    expect(envValue({}, "NEAR_NETWORK")).toBeUndefined();
    expect(envValue({ NEAR_NETWORK: undefined }, "NEAR_NETWORK")).toBeUndefined();
    expect(envValue({ NEAR_NETWORK: "" }, "NEAR_NETWORK")).toBeUndefined();
    expect(envValue({ NEAR_NETWORK: "   " }, "NEAR_NETWORK")).toBeUndefined();
    expect(envValue({ PROBARION_LEDGER_PATH: "" }, "PROBARION_LEDGER_PATH")).toBeUndefined();
    expect(envValue({ NEARAI_MODEL: "\t\n" }, "NEARAI_MODEL")).toBeUndefined();
  });

  it("trims surrounding whitespace from a set value", () => {
    expect(envValue({ NEARAI_MODEL: "  auto  " }, "NEARAI_MODEL")).toBe("auto");
  });
});
