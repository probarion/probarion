import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/crypto/sodium";
import {
  bearerToken,
  cleanLabel,
  codeHash,
  newPairCode,
  newToken,
  readNonce,
  readPairCode,
  showCode,
  TOKEN_RE,
  tokenHash,
} from "./token";

/** A random source that answers `n` copies of one byte. */
const fixed = (b: number) => (n: number) => Buffer.alloc(n, b);

describe("extension tokens", () => {
  it("are pbx_ and 43 base64url characters, kept only as their sha256", () => {
    const t = newToken(fixed(0xab));
    expect(t.token).toMatch(TOKEN_RE);
    expect(t.token).toBe(`pbx_${Buffer.alloc(32, 0xab).toString("base64url")}`);
    expect(t.sha256).toBe(sha256Hex(t.token));
    expect(tokenHash(t.token)).toBe(t.sha256);
    expect(t.hint).toBe(t.token.slice(-4));
    expect(newToken().token).not.toBe(newToken().token);
  });

  it("is read only from an exact `Bearer` header", () => {
    const t = newToken(fixed(1)).token;
    const h = (v?: string) => new Headers(v === undefined ? {} : { authorization: v });
    expect(bearerToken(h(`Bearer ${t}`))).toBe(t);
    for (const bad of [
      undefined,
      "",
      t,
      `bearer ${t}`,
      `Bearer  ${t}`,
      `Basic ${t}`,
      "Bearer pbx_short",
      `Bearer ${t}x`,
    ]) {
      expect(bearerToken(h(bad))).toBeNull();
    }
  });
});

describe("pairing codes", () => {
  it("are 8 Crockford base32 characters from 40 random bits", () => {
    expect(newPairCode(fixed(0))).toBe("00000000");
    expect(newPairCode(fixed(0xff))).toBe("ZZZZZZZZ");
    for (let i = 0; i < 50; i++) expect(newPairCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it("are shown as XXXX-XXXX and read back however they are typed", () => {
    expect(showCode("K7QM4XRA")).toBe("K7QM-4XRA");
    expect(readPairCode("K7QM-4XRA")).toBe("K7QM4XRA");
    expect(readPairCode(" k7qm 4xra ")).toBe("K7QM4XRA");
    // Crockford reading: O is zero, I and L are one.
    expect(readPairCode("OIL0-0000")).toBe("01100000");
    for (const bad of ["K7QM4XR", "K7QM4XRAA", "K7QM-4XRU", "", "K7QM_4XRA", 12345678, null]) {
      expect(readPairCode(bad)).toBeNull();
    }
  });

  it("hash under a label of their own", () => {
    expect(codeHash("K7QM4XRA")).toBe(sha256Hex("pair:K7QM4XRA"));
    expect(codeHash("K7QM4XRA")).not.toBe(sha256Hex("K7QM4XRA"));
  });
});

describe("labels and nonces", () => {
  it("keep a label printable and at most 64 characters, else Chrome", () => {
    expect(cleanLabel("Chrome on Windows")).toBe("Chrome on Windows");
    expect(cleanLabel("  a\u202Eb\n c ")).toBe("ab c");
    expect(cleanLabel("x".repeat(80))).toBe("x".repeat(64));
    for (const bad of ["", "   ", "\u0000", 7, null]) expect(cleanLabel(bad)).toBe("Chrome");
  });

  it("drop a surrogate that is not part of a pair, which the database cannot store, and keep a pair", () => {
    expect(cleanLabel("Chrome\uD800")).toBe("Chrome");
    expect(cleanLabel("\uDC00Chrome on\uDBFF Windows")).toBe("Chrome on Windows");
    expect(cleanLabel("\uD800")).toBe("Chrome");
    expect(cleanLabel("Chrome \u{1F310}")).toBe("Chrome \u{1F310}");
    expect(cleanLabel(`${"x".repeat(63)}\u{1F310}`)).toBe(`${"x".repeat(63)}\u{1F310}`);
  });

  it("read a nonce of 22 to 64 URL-safe characters", () => {
    expect(readNonce("a".repeat(22))).toBe("a".repeat(22));
    expect(readNonce("A-_9".repeat(16))).toBe("A-_9".repeat(16));
    for (const bad of [
      "a".repeat(21),
      "a".repeat(65),
      "a b".repeat(10),
      ["a".repeat(22)],
      undefined,
    ]) {
      expect(readNonce(bad)).toBeNull();
    }
  });
});
