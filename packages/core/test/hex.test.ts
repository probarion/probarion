import { describe, expect, it } from "vitest";
import {
  bytesEqual,
  bytesToHex,
  concatBytes,
  hexToBytes,
  isHex32,
  u64be,
  utf8,
  ZERO_HEX32,
} from "../src/hex.js";

describe("hex helpers", () => {
  it("round-trips bytes and hex", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255]);
    expect(bytesToHex(bytes)).toBe("00010f10ff");
    expect(hexToBytes("00010f10ff")).toEqual(bytes);
    expect(hexToBytes("0x00010F10FF")).toEqual(bytes);
  });

  it("rejects malformed hex", () => {
    expect(() => hexToBytes("abc")).toThrow(TypeError);
    expect(() => hexToBytes("zz")).toThrow(TypeError);
  });

  it("recognises 32-byte lowercase hex only", () => {
    expect(isHex32(ZERO_HEX32)).toBe(true);
    expect(isHex32("a".repeat(64))).toBe(true);
    expect(isHex32("A".repeat(64))).toBe(false);
    expect(isHex32("a".repeat(63))).toBe(false);
    expect(isHex32(42)).toBe(false);
  });

  it("encodes u64 big-endian and rejects out-of-range values", () => {
    expect(bytesToHex(u64be(1))).toBe("0000000000000001");
    expect(bytesToHex(u64be(0x0102030405060708n))).toBe("0102030405060708");
    expect(bytesToHex(u64be((1n << 64n) - 1n))).toBe("ffffffffffffffff");
    expect(() => u64be(-1)).toThrow(RangeError);
    expect(() => u64be(1n << 64n)).toThrow(RangeError);
    expect(() => u64be(1.5)).toThrow(RangeError);
  });

  it("concatenates and compares", () => {
    const joined = concatBytes(utf8("ab"), new Uint8Array([0]), utf8("c"));
    expect(bytesToHex(joined)).toBe("61620063");
    expect(bytesEqual(joined, hexToBytes("61620063"))).toBe(true);
    expect(bytesEqual(joined, hexToBytes("61620064"))).toBe(false);
  });
});
