import { describe, expect, it } from "vitest";
import { isNearAccountId } from "./validate";

describe("isNearAccountId", () => {
  it.each([
    ["alice.near", true],
    ["acme.vaults.probarion.near", true],
    ["a1_b-c.near", true],
    ["0".repeat(64), true],
    [`0x${"ab".repeat(20)}`, true],
    ["Alice.near", false],
    ["a", false],
    ["-alice.near", false],
    ["alice..near", false],
    ["alice.near.", false],
    ["al ice.near", false],
    ["x".repeat(65), false],
  ])("%s -> %s", (id, ok) => {
    expect(isNearAccountId(id)).toBe(ok);
  });

  it("holds the length bounds exactly: 2 to 64 characters", () => {
    expect(isNearAccountId("ab")).toBe(true);
    expect(isNearAccountId("x".repeat(64))).toBe(true);
    expect(isNearAccountId("x".repeat(65))).toBe(false);
    expect(isNearAccountId("")).toBe(false);
    // 63 characters of name plus a separator and one more is 65
    expect(isNearAccountId(`${"x".repeat(61)}.ab`)).toBe(true);
    expect(isNearAccountId(`${"x".repeat(62)}.ab`)).toBe(false);
  });

  it("allows a single separator between name parts, never at either end", () => {
    for (const ok of ["a-b", "a_b", "a.b", "a-b.c_d", "1.2", "a-b-c", "a_b_c.d.e-f"]) {
      expect(isNearAccountId(ok), ok).toBe(true);
    }
    for (const bad of [
      "_ab",
      "ab_",
      "ab-",
      ".ab",
      "a--b",
      "a__b",
      "a-_b",
      "a_-b",
      "a.-b",
      "a-.b",
      "a._b",
      "a_.b",
      "a..b",
      ".",
      "..",
      "a.",
    ]) {
      expect(isNearAccountId(bad), bad).toBe(false);
    }
  });

  it("refuses any character outside a-z, 0-9 and the three separators", () => {
    for (const bad of [
      "ALICE.near",
      "aliCe.near",
      "alice@near",
      "alice near",
      " alice.near",
      "alice.near ",
      "alice\n",
      "alice.near\n",
      "al\nice",
      "ali\u0000ce",
      "alice/near",
      "alice:near",
      "alice+near",
      "alice$near",
      "ålice.near",
      "alice.néar",
      "alice‮.near",
      "ａlice.near", // fullwidth "a"
      "alice.near​",
      "٣٣.near", // Arabic-Indic digits
    ]) {
      expect(isNearAccountId(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("accepts implicit accounts: 64 hex characters, and the 0x form", () => {
    expect(isNearAccountId("ab".repeat(32))).toBe(true);
    expect(isNearAccountId(`0x${"cd".repeat(20)}`)).toBe(true);
    expect(isNearAccountId("ab".repeat(33))).toBe(false);
  });

  it("is false for anything that is not a string", () => {
    for (const bad of [undefined, null, 12, {}, [], ["alice.near"], true]) {
      expect(isNearAccountId(bad as unknown as string)).toBe(false);
    }
  });

  it("does not take long on a hostile input", () => {
    const start = Date.now();
    isNearAccountId(`${"a-".repeat(2000)}!`);
    isNearAccountId(`${"a.".repeat(2000)}!`);
    expect(Date.now() - start).toBeLessThan(200);
  });
});
