import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson, sha256Hex } from "../src/hash.js";
import { bytesToHex, utf8 } from "../src/hex.js";

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

// Golden vectors. The expected strings are copied from RFC 8785 or derived by hand from its rules;
// none of them is produced by the code under test.
describe("canonicalJson golden vectors (RFC 8785)", () => {
  // RFC 8785 section 3.2.2: the sample that sections 3.2.3 and 3.2.4 canonicalise.
  const RFC_SAMPLE_INPUT = String.raw`{
    "numbers": [333333333.33333329, 1E30, 4.50,
                2e-3, 0.000000000000000000000000001],
    "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
    "literals": [null, true, false]
  }`;
  // Section 3.2.3: the canonical text of that sample.
  const RFC_SAMPLE_CANONICAL = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`;
  // Section 3.2.4: the same text as UTF-8 bytes, exactly as the RFC lists them.
  const RFC_SAMPLE_BYTES = [
    "7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72",
    "75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a",
    "5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31",
    "65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37",
    "5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30",
    "30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d",
  ]
    .join(" ")
    .replaceAll(" ", "");

  it("matches the RFC 8785 section 3.2.3 and 3.2.4 example byte for byte", () => {
    const canonical = canonicalJson(JSON.parse(RFC_SAMPLE_INPUT));
    expect(canonical).toBe(RFC_SAMPLE_CANONICAL);
    expect(bytesToHex(utf8(canonical))).toBe(RFC_SAMPLE_BYTES);
  });

  it("sorts the RFC 8785 section 3.2.3 key-sorting example by UTF-16 code units", () => {
    const input = String.raw`{
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis"
    }`;
    const sortedMembers: [string, string][] = [
      ["\r", "Carriage Return"],
      ["1", "One"],
      ["\u{80}", "Control"],
      ["\u{F6}", "Latin Small Letter O With Diaeresis"],
      ["\u{20AC}", "Euro Sign"],
      ["\u{1F600}", "Emoji: Grinning Face"],
      ["\u{FB33}", "Hebrew Letter Dalet With Dagesh"],
    ];
    // Only U+0000..U+001F, the quote and the backslash are escaped; U+0080 and above stay raw.
    const expected = `{${sortedMembers
      .map(([key, value]) => `"${key === "\r" ? "\\r" : key}":"${value}"`)
      .join(",")}}`;
    expect(canonicalJson(JSON.parse(input))).toBe(expected);
    expect(canonicalJson(Object.fromEntries([...sortedMembers].reverse()))).toBe(expected);
  });

  it("orders keys by UTF-16 code unit, not by code point (emoji before U+FFFF)", () => {
    const emoji = "\u{1F600}";
    const ffff = "\u{FFFF}";
    const expected = `{"${emoji}":1,"${ffff}":2}`;
    expect(canonicalJson({ [emoji]: 1, [ffff]: 2 })).toBe(expected);
    expect(canonicalJson({ [ffff]: 2, [emoji]: 1 })).toBe(expected);
    // By code point or by UTF-8 bytes U+FFFF would sort first (U+FFFF < U+1F600); JCS must not.
    expect(ffff.codePointAt(0) ?? 0).toBeLessThan(emoji.codePointAt(0) ?? 0);
    expect(emoji.charCodeAt(0)).toBeLessThan(ffff.charCodeAt(0));
  });

  it("escapes control characters in lowercase hex and leaves '/' and non-ASCII raw", () => {
    expect(canonicalJson("\x1f")).toBe(String.raw`"\u001f"`);
    expect(canonicalJson("\x00\x01\x1e")).toBe(String.raw`"\u0000\u0001\u001e"`);
    expect(canonicalJson("\b\t\n\f\r")).toBe(String.raw`"\b\t\n\f\r"`);
    expect(canonicalJson('"\\')).toBe(String.raw`"\"\\"`);
    expect(canonicalJson("a/b//c")).toBe('"a/b//c"');
    expect(canonicalJson("\x7f\x80")).toBe('"\x7f\x80"');
    expect(canonicalJson("é€\u{1F600}\u{2028}")).toBe('"é€\u{1F600}\u{2028}"');
    // Raw means raw UTF-8 on the wire: 2 + 3 + 4 bytes plus the two quotes.
    expect(utf8(canonicalJson("é€\u{1F600}")).length).toBe(2 + 2 + 3 + 4);
  });

  it("serialises small and large exponents the ECMAScript way", () => {
    expect(canonicalJson(1e-7)).toBe("1e-7");
    expect(canonicalJson(1e-6)).toBe("0.000001");
    expect(canonicalJson(1e21)).toBe("1e+21");
    expect(canonicalJson(1e20)).toBe("100000000000000000000");
    expect(canonicalJson(123456789012345680000)).toBe("123456789012345680000");
    expect(canonicalJson(5e-324)).toBe("5e-324");
    expect(canonicalJson(Number.MAX_VALUE)).toBe("1.7976931348623157e+308");
    expect(canonicalJson(-0)).toBe("0");
  });

  it("hashes a canonical body with non-ASCII text to a fixed known answer", () => {
    const body = {
      v: 1,
      seq: 3,
      amount: "25000000",
      payee: { name: "Zürich Büro 東京 😀", note: "a/b\x1f" },
      rules: [{ outcome: "pass", id: "mandate.none", detail: "naïve – 100 €" }],
    };
    // Written by hand from the RFC 8785 rules: sorted keys, no whitespace, the control character as
    // lowercase \u001f, everything else raw.
    const canonical = String.raw`{"amount":"25000000","payee":{"name":"Zürich Büro 東京 😀","note":"a/b\u001f"},"rules":[{"detail":"naïve – 100 €","id":"mandate.none","outcome":"pass"}],"seq":3,"v":1}`;
    const KNOWN_ANSWER = "5edfffdebd2ade66395bb6e46e5fc5afb6f4d36d88a75ae09eccde1f29be06d7";
    expect(canonicalJson(body)).toBe(canonical);
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(KNOWN_ANSWER);
    expect(sha256Hex(canonicalJson(body))).toBe(KNOWN_ANSWER);
  });
});

describe("canonicalJson failure modes all raise CanonicalJsonError", () => {
  const nested = (depth: number): unknown => {
    let value: unknown = 1;
    for (let i = 0; i < depth; i++) value = [value];
    return value;
  };

  it("rejects circular objects and arrays", () => {
    const object: Record<string, unknown> = { a: 1 };
    object.self = object;
    expect(() => canonicalJson(object)).toThrow(CanonicalJsonError);

    const array: unknown[] = [1];
    array.push(array);
    expect(() => canonicalJson(array)).toThrow(CanonicalJsonError);

    const indirect: Record<string, unknown> = {};
    indirect.child = { parent: indirect };
    expect(() => canonicalJson(indirect)).toThrow(CanonicalJsonError);
  });

  it("accepts the same object referenced twice when there is no cycle", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: [shared, shared] })).toBe(
      '{"a":{"x":1},"b":[{"x":1},{"x":1}]}',
    );
  });

  it("caps nesting depth instead of overflowing the stack", () => {
    expect(() => canonicalJson(nested(256))).not.toThrow();
    expect(() => canonicalJson(nested(257))).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(nested(200_000))).toThrow(CanonicalJsonError);
    let deepObject: unknown = 1;
    for (let i = 0; i < 1000; i++) deepObject = { k: deepObject };
    expect(() => canonicalJson(deepObject)).toThrow(CanonicalJsonError);
  });

  it("rejects a lone surrogate in a value, in a key and inside nested data", () => {
    const highAlone = String.fromCharCode(0xd83d);
    const lowAlone = String.fromCharCode(0xdc00);
    expect(() => canonicalJson(highAlone)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(`x${lowAlone}y`)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: highAlone })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ [highAlone]: 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ list: [{ deep: "ok", [`bad${lowAlone}`]: true }] })).toThrow(
      CanonicalJsonError,
    );
    // The two halves in the right order are one valid character, not lone surrogates.
    expect(canonicalJson(String.fromCharCode(0xd83d, 0xde00))).toBe('"\u{1F600}"');
  });

  it("wraps whatever else the serialiser throws, such as a getter that fails", () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    expect(() => canonicalJson(hostile)).toThrow(CanonicalJsonError);
  });

  it("keeps the original error as the cause", () => {
    try {
      canonicalJson(String.fromCharCode(0xd800));
      expect.unreachable("canonicalJson must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalJsonError);
      expect((error as CanonicalJsonError).cause).toBeInstanceOf(Error);
    }
  });
});
