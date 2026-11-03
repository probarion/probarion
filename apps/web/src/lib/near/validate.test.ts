import { isEvmAddress } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { isNearAccountId, parseBaseAddress } from "./validate";

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

  // The grammar is a chain of runs that each end in one separator, so the engine can only back off one run
  // at a time (polynomial at worst, never exponential), and the length check runs first, so the input is at
  // most 64 characters when the pattern sees it. These are the shapes that are slow in a badly written
  // version of this pattern; each one must simply be answered.
  it("answers hostile inputs of 64 characters or fewer", () => {
    const cases: [string, boolean][] = [
      [`${"a-".repeat(31)}!`, false],
      [`${"a.".repeat(31)}!`, false],
      [`${"a-a.".repeat(15)}!`, false],
      [`${"a_".repeat(32)}`, false], // 64 characters, ends in a separator
      [`${"a".repeat(63)}!`, false],
      [`${"a".repeat(62)}--`, false],
      [`${"a-".repeat(31)}a`, true], // 63 characters, as long as a valid one gets with this shape
      [`${"a.".repeat(31)}a`, true],
      [`${"1-".repeat(32)}`, false],
      ["-".repeat(64), false],
      [".".repeat(64), false],
      ["a".repeat(32) + "-".repeat(32), false],
      [`${"ab".repeat(15)}_${"cd".repeat(15)}.`, false],
    ];
    for (const [id, ok] of cases) {
      expect(id.length, id).toBeLessThanOrEqual(64);
      expect(isNearAccountId(id), id).toBe(ok);
    }
  });
});

// The vault accepts `0x` and 40 hex digits in any case and stores them as written (validate.rs is_evm_address,
// the same shape as core's isEvmAddress). parseBaseAddress is stricter on purpose, in two ways the contract
// cannot be: a mixed-case address must carry a valid EIP-55 checksum (a typo in a mixed-case address is
// caught here, not paid out to the wrong place), and the zero address is refused. What it returns is
// always something the contract accepts, in the checksummed form.
describe("parseBaseAddress", () => {
  const CHECKSUMMED = "0x52908400098527886E0F7030069857D2E4169EE7"; // the EIP-55 specification's own vector
  const ALL_LOWER_VALID = "0xde709f2102306220921060314715629080e2fb77"; // EIP-55 form that is all lower case
  const DIGITS_ONLY = `0x${"1".repeat(40)}`; // the vault's own test address

  it.each([
    [CHECKSUMMED, CHECKSUMMED],
    [CHECKSUMMED.toLowerCase(), CHECKSUMMED],
    [`0x${CHECKSUMMED.slice(2).toUpperCase()}`, CHECKSUMMED],
    [
      ` ${ALL_LOWER_VALID}
`,
      ALL_LOWER_VALID,
    ],
    [DIGITS_ONLY, DIGITS_ONLY],
  ])("accepts %s", (input, out) => expect(parseBaseAddress(input)).toBe(out));

  it.each([
    ["a bad EIP-55 checksum", "0x52908400098527886e0F7030069857D2E4169EE7"],
    [
      "the vault's mixed-case test address, which is not checksummed",
      "0xAbCdEf0123456789abcdef0123456789ABCDEF01",
    ],
    ["a space inside", "0x5290840009852788 6E0F7030069857D2E4169EE7"],
    ["an ENS name", "acme.eth"],
    ["the zero address", `0x${"0".repeat(40)}`],
    ["a short address", "0x1234"],
    ["39 digits", `0x${"1".repeat(39)}`],
    ["41 digits", `0x${"1".repeat(41)}`],
    ["an upper-case 0X prefix", `0X${"1".repeat(40)}`],
    ["no 0x prefix", "1".repeat(40)],
    ["a non-hex digit", `0x${"1".repeat(39)}g`],
    ["empty", ""],
    ["a NEAR account id", "designer.near"],
    ["a fullwidth digit", `0x${"1".repeat(39)}１`],
  ])("rejects %s", (_why, input) => expect(parseBaseAddress(input)).toBeNull());

  it("accepts an all-capitals or all-lower-case address that is not its own checksum (written without one)", () => {
    // 0x + AB x 20: its EIP-55 form mixes cases, so all-caps is NOT the checksum here; the vault accepts it as written
    const allCaps = `0x${"AB".repeat(20)}`;
    const checksummed = parseBaseAddress(allCaps);
    expect(checksummed).not.toBeNull();
    expect(checksummed).not.toBe(allCaps);
    expect(checksummed?.toLowerCase()).toBe(allCaps.toLowerCase());
    expect(parseBaseAddress(allCaps.toLowerCase())).toBe(checksummed);
    // while the same letters with ONE case flipped by hand (a typo) are refused
    expect(parseBaseAddress(`0x${"AB".repeat(19)}Ab`)).toBeNull();
  });

  it("returns the checksummed form for every case of the same address, and is idempotent", () => {
    const forms = [
      CHECKSUMMED,
      CHECKSUMMED.toLowerCase(),
      `0x${CHECKSUMMED.slice(2).toUpperCase()}`,
    ];
    for (const f of forms) {
      const out = parseBaseAddress(f);
      expect(out).toBe(CHECKSUMMED);
      expect(parseBaseAddress(out as string)).toBe(out);
    }
  });

  it("only ever returns an address the vault and core's A8 shape accept", () => {
    for (const f of [CHECKSUMMED, CHECKSUMMED.toLowerCase(), ALL_LOWER_VALID, DIGITS_ONLY]) {
      const out = parseBaseAddress(f) as string;
      expect(out).toMatch(/^0x[0-9a-fA-F]{40}$/); // validate.rs is_evm_address
      expect(isEvmAddress(out)).toBe(true);
    }
  });

  it("is null for anything that is not a string", () => {
    for (const bad of [undefined, null, 12, {}, [CHECKSUMMED]]) {
      expect(parseBaseAddress(bad as unknown as string)).toBeNull();
    }
  });
});
