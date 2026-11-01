import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson, sha256Hex } from "../src/hash.js";

describe("sha256", () => {
  it("matches the FIPS 180-2 'abc' vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
  });
});

describe("canonicalJson (RFC 8785)", () => {
  it("sorts keys and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(canonicalJson({ z: { y: 2, x: 1 } })).toBe('{"z":{"x":1,"y":2}}');
  });

  it("is independent of key insertion order", () => {
    const one = { seq: 1, kind: "decision", rules: [{ id: "a", outcome: "pass" }] };
    const two = { rules: [{ outcome: "pass", id: "a" }], kind: "decision", seq: 1 };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  it("serialises numbers the ECMAScript way", () => {
    expect(canonicalJson([0.7, 1e21, 10, -0])).toBe("[0.7,1e+21,10,0]");
  });

  it("rejects values that JSON cannot round-trip", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: 1n })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(CanonicalJsonError);
    // biome-ignore lint/suspicious/noSparseArray: the sparse array is the input under test
    expect(() => canonicalJson([1, , 3])).toThrow(CanonicalJsonError);
  });
});
