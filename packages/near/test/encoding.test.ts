import { describe, expect, it } from "vitest";
import {
  BorshWriter,
  bytesEqual,
  bytesToHex,
  concatBytes,
  decodeBase58Hash,
  decodeBase64,
  encodeBase58,
  encodeBase64,
  hexToBytes,
  isAccountId,
  isBase58Hash,
  isRecord,
  parseSafeCount,
  parseU64,
  parseU128,
  sha256,
  U64_MAX,
  U128_MAX,
  utf8,
} from "../src/encoding.js";
import { mulberry32 } from "./helpers/prng.js";

/** A mainnet payout transaction of v0.probarion.near (docs/mainnet-proof.json). */
const TX_HASH = "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9";

function randomBytes(next: () => number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(next() * 256);
  return out;
}

describe("bytes and hashing", () => {
  it("hashes the concatenation of its parts with sha256 (FIPS 180-2 vectors)", () => {
    expect(bytesToHex(sha256(utf8("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(bytesToHex(sha256())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256(utf8("a"), utf8(""), utf8("bc"))).toEqual(sha256(utf8("abc")));
  });

  it("concatenates and compares bytes", () => {
    const joined = concatBytes(Uint8Array.of(1, 2), new Uint8Array(0), Uint8Array.of(3));
    expect(joined).toEqual(Uint8Array.of(1, 2, 3));
    expect(concatBytes()).toEqual(new Uint8Array(0));
    expect(bytesEqual(joined, Uint8Array.of(1, 2, 3))).toBe(true);
    expect(bytesEqual(joined, Uint8Array.of(1, 2, 4))).toBe(false);
    expect(bytesEqual(joined, Uint8Array.of(1, 2))).toBe(false);
  });

  it("encodes UTF-8", () => {
    expect(utf8("hé")).toEqual(Uint8Array.of(0x68, 0xc3, 0xa9));
  });

  it("tells a plain object from an array, null and other values", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const value of [[], null, undefined, "x", 1, true]) expect(isRecord(value)).toBe(false);
  });
});

describe("hex", () => {
  it("writes lowercase hex and reads either case with an optional 0x", () => {
    const bytes = Uint8Array.of(0, 1, 15, 16, 255);
    expect(bytesToHex(bytes)).toBe("00010f10ff");
    expect(hexToBytes("00010f10ff")).toEqual(bytes);
    expect(hexToBytes("0x00010F10FF")).toEqual(bytes);
    expect(hexToBytes("0x")).toEqual(new Uint8Array(0));
  });

  it("returns null for odd length, non-hex digits, another prefix and non-strings", () => {
    for (const text of ["abc", "zz", "0x0", "0X00", " 00", "00 ", "0x0x00"]) {
      expect(hexToBytes(text), text).toBeNull();
    }
    expect(hexToBytes(12)).toBeNull();
  });
});

describe("base58 hashes", () => {
  it("decodes a 32-byte hash and encodes it back to the same text", () => {
    const bytes = decodeBase58Hash(TX_HASH);
    expect(bytes).not.toBeNull();
    expect(bytes?.length).toBe(32);
    expect(encodeBase58(bytes ?? new Uint8Array(0))).toBe(TX_HASH);
    expect(isBase58Hash(TX_HASH)).toBe(true);
  });

  it("reads the two ends of the range: 32 zero bytes and 32 0xff bytes", () => {
    expect(decodeBase58Hash("1".repeat(32))).toEqual(new Uint8Array(32));
    expect(decodeBase58Hash("JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG")).toEqual(
      new Uint8Array(32).fill(0xff),
    );
  });

  it("refuses another spelling: an extra leading 1 is one more zero byte (33 bytes)", () => {
    expect(decodeBase58Hash(`1${TX_HASH}`)).toBeNull();
    expect(isBase58Hash(`1${TX_HASH}`)).toBe(false);
    expect(decodeBase58Hash("1".repeat(33))).toBeNull();
  });

  it("refuses values that are not 32 bytes, characters outside the alphabet, and non-strings", () => {
    const cases = [
      encodeBase58(new Uint8Array(31).fill(7)), // 31 bytes
      encodeBase58(new Uint8Array(33).fill(7)), // 33 bytes
      "z".repeat(44), // past 2^256: 33 bytes
      "1".repeat(31), // 31 zero bytes
      `${TX_HASH.slice(0, -1)}0`,
      `${TX_HASH.slice(0, -1)}O`,
      `${TX_HASH.slice(0, -1)}I`,
      `${TX_HASH.slice(0, -1)}l`,
      ` ${TX_HASH}`,
      `${TX_HASH}\n`,
      "",
      "z".repeat(45),
    ];
    for (const text of cases) expect(decodeBase58Hash(text), JSON.stringify(text)).toBeNull();
    for (const value of [null, 32, new Uint8Array(32), [TX_HASH]]) {
      expect(decodeBase58Hash(value)).toBeNull();
    }
  });

  it("round-trips 500 random 32-byte values, leading zero bytes included (seed 20261114)", () => {
    const next = mulberry32(20261114);
    for (let run = 0; run < 500; run++) {
      const bytes = randomBytes(next, 32);
      // Every fifth value starts with zero bytes, which base58 spells as leading 1s.
      if (run % 5 === 0) bytes.fill(0, 0, 1 + (run % 4));
      const text = encodeBase58(bytes);
      expect(decodeBase58Hash(text), `run ${run}: ${text}`).toEqual(bytes);
      expect(decodeBase58Hash(`1${text}`), `run ${run}`).toBeNull();
    }
  });
});

describe("decimal integers", () => {
  it("reads canonical u128 strings up to 2^128 - 1", () => {
    expect(parseU128("0")).toBe(0n);
    expect(parseU128("1000000")).toBe(1_000_000n);
    expect(parseU128("246219350238132600000000")).toBe(246219350238132600000000n);
    expect(parseU128(U128_MAX.toString())).toBe(U128_MAX);
    expect(U128_MAX.toString()).toBe("340282366920938463463374607431768211455");
  });

  it("refuses u128 text that is not canonical, out of range, or not a string", () => {
    const texts = [
      (U128_MAX + 1n).toString(),
      `1${"0".repeat(39)}`,
      "01",
      "00",
      "-1",
      "+1",
      "1e6",
      "1.0",
      " 1",
      "1 ",
      "",
      "0x10",
      "１", // a full-width digit
    ];
    for (const text of texts) expect(parseU128(text), JSON.stringify(text)).toBeNull();
    for (const value of [1, 0, 1n, null, undefined, ["1"]]) expect(parseU128(value)).toBeNull();
  });

  it("reads canonical u64 strings up to 2^64 - 1", () => {
    expect(parseU64("1731542400000000000")).toBe(1731542400000000000n);
    expect(parseU64(U64_MAX.toString())).toBe(U64_MAX);
    expect(U64_MAX.toString()).toBe("18446744073709551615");
    expect(parseU64((U64_MAX + 1n).toString())).toBeNull();
    expect(parseU64("01")).toBeNull();
    expect(parseU64(1_731_542_400)).toBeNull();
  });

  it("reads non-negative safe integer JSON numbers as counts", () => {
    expect(parseSafeCount(0)).toBe(0);
    expect(Object.is(parseSafeCount(-0), 0)).toBe(true);
    expect(parseSafeCount(2_428_132_513_920)).toBe(2_428_132_513_920);
    expect(parseSafeCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of [-1, 1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, "5", 5n, null]) {
      expect(parseSafeCount(value), String(value)).toBeNull();
    }
  });
});

describe("base64", () => {
  it("decodes padded standard base64, the empty string as zero bytes", () => {
    expect(decodeBase64("")).toEqual(new Uint8Array(0));
    expect(decodeBase64("QQ==")).toEqual(Uint8Array.of(0x41));
    expect(decodeBase64("QUI=")).toEqual(Uint8Array.of(0x41, 0x42));
    expect(decodeBase64("AAAA")).toEqual(new Uint8Array(3));
    expect(decodeBase64("+/8=")).toEqual(Uint8Array.of(0xfb, 0xff));
    expect(encodeBase64(Uint8Array.of(0xfb, 0xff))).toBe("+/8=");
  });

  it("refuses a spelling that encodeBase64 would not give: trailing bits, missing padding, other alphabets", () => {
    const texts = [
      "QR==",
      "QUJ=",
      "QQ",
      "QQ=",
      "Q===",
      "====",
      "-_8=",
      "Q Q==",
      "QQ==\n",
      "QQ==QQ==",
    ];
    for (const text of texts) expect(decodeBase64(text), JSON.stringify(text)).toBeNull();
    for (const value of [null, 1, new Uint8Array(1)]) expect(decodeBase64(value)).toBeNull();
  });

  it("round-trips random lengths, and inputs larger than one encoding chunk (seed 7)", () => {
    const next = mulberry32(7);
    for (let run = 0; run < 200; run++) {
      const bytes = randomBytes(next, Math.floor(next() * 70));
      expect(decodeBase64(encodeBase64(bytes)), `run ${run}`).toEqual(bytes);
    }
    const large = randomBytes(next, 0x8000 * 2 + 5);
    expect(decodeBase64(encodeBase64(large))).toEqual(large);
  });
});

describe("account ids", () => {
  it("accepts named, implicit and EVM-implicit account ids", () => {
    const ids = [
      "v0.probarion.near",
      "intents.near",
      "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      "usdc.probarion.testnet",
      "a1",
      "a".repeat(64),
      "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de",
      "0xb22eacdf11177d6d635e8956bbbbdd54b3e6eb27",
    ];
    for (const id of ids) expect(isAccountId(id), id).toBe(true);
  });

  it("refuses uppercase, separators at the ends or doubled, the wrong length, and non-strings", () => {
    const ids = [
      "A.near",
      "a",
      ".near",
      "near.",
      "a..near",
      "a-.near",
      "a_-b.near",
      "a b.near",
      "a".repeat(65),
      "",
    ];
    for (const id of ids) expect(isAccountId(id), id).toBe(false);
    expect(isAccountId(12)).toBe(false);
    expect(isAccountId(null)).toBe(false);
  });
});

describe("BorshWriter", () => {
  it("writes little-endian integers, fixed arrays, Vec<u8> and String", () => {
    const bytes = new BorshWriter()
      .u8(0xff)
      .u32(0x01020304)
      .u64(0x0102030405060708n)
      .u128((1n << 64n) + 2n)
      .fixed(Uint8Array.of(9, 9))
      .bytes(Uint8Array.of(7))
      .string("hé")
      .toBytes();
    expect(bytesToHex(bytes)).toBe(
      [
        "ff",
        "04030201",
        "0807060504030201",
        "0200000000000000" + "0100000000000000",
        "0909",
        "01000000" + "07",
        "03000000" + "68c3a9",
      ].join(""),
    );
  });

  it("writes the ends of each range", () => {
    expect(bytesToHex(new BorshWriter().u8(0).u32(0xffff_ffff).toBytes())).toBe("00ffffffff");
    expect(bytesToHex(new BorshWriter().u64(U64_MAX).toBytes())).toBe("ff".repeat(8));
    expect(bytesToHex(new BorshWriter().u128(U128_MAX).toBytes())).toBe("ff".repeat(16));
    expect(new BorshWriter().toBytes()).toEqual(new Uint8Array(0));
    expect(bytesToHex(new BorshWriter().string("").bytes(new Uint8Array(0)).toBytes())).toBe(
      "0000000000000000",
    );
  });

  it("throws RangeError instead of truncating a value that does not fit", () => {
    const w = new BorshWriter();
    expect(() => w.u8(256)).toThrow(RangeError);
    expect(() => w.u8(-1)).toThrow(RangeError);
    expect(() => w.u8(1.5)).toThrow(RangeError);
    expect(() => w.u32(2 ** 32)).toThrow(RangeError);
    expect(() => w.u32(Number.NaN)).toThrow(RangeError);
    expect(() => w.u64(-1n)).toThrow(RangeError);
    expect(() => w.u64(U64_MAX + 1n)).toThrow(RangeError);
    expect(() => w.u64(1 as unknown as bigint)).toThrow(RangeError);
    expect(() => w.u128(U128_MAX + 1n)).toThrow(RangeError);
    expect(w.toBytes()).toEqual(new Uint8Array(0));
  });

  it("copies fixed bytes, so a later change to the caller's array does not change the output", () => {
    const input = Uint8Array.of(1, 2, 3);
    const w = new BorshWriter().fixed(input);
    input[0] = 9;
    expect(w.toBytes()).toEqual(Uint8Array.of(1, 2, 3));
  });
});
