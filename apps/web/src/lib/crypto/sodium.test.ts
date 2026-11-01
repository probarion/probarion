import { describe, expect, it, vi } from "vitest";
import {
  DecryptError,
  deriveSubkey,
  getSodium,
  keyedHashHex,
  macToken,
  open,
  parseMasterKey,
  readMacToken,
  type Sealed,
  type SubkeyPurpose,
  seal,
  sha256Hex,
  tenantInvoiceKey,
} from "./sodium";

const MASTER = parseMasterKey(Buffer.alloc(32, 1).toString("base64"));
const OTHER = parseMasterKey(Buffer.alloc(32, 2).toString("base64"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Swaps the last data character for its sibling that differs only in the lowest bit. When the encoded
 * length leaves unused trailing bits, the sibling decodes (leniently) to the very same bytes, so it is
 * the exact malleability a non-canonical decoder would accept.
 */
function lowBitSibling(encoded: string, alphabet: string): string {
  const end = encoded.replace(/=+$/, "").length - 1;
  const sibling = alphabet[alphabet.indexOf(encoded.charAt(end)) ^ 1];
  return encoded.slice(0, end) + sibling + encoded.slice(end + 1);
}

/** Replaces the character at `i` with a different one from the same alphabet. */
function tamperAt(encoded: string, i: number, alphabet: string): string {
  const next = encoded.charAt(i) === alphabet.charAt(0) ? alphabet.charAt(1) : alphabet.charAt(0);
  return encoded.slice(0, i) + next + encoded.slice(i + 1);
}

describe("parseMasterKey", () => {
  const good = Buffer.alloc(32, 9).toString("base64");

  it("rejects a master key that is not 32 bytes", () => {
    expect(() => parseMasterKey(Buffer.alloc(31).toString("base64"))).toThrow(/32 bytes/);
  });

  it.each([0, 16, 31, 33, 64])("rejects %i bytes", (n) => {
    expect(() => parseMasterKey(Buffer.alloc(n, 5).toString("base64"))).toThrow(/32 bytes/);
  });

  it("returns exactly the 32 decoded bytes", () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 1));
    const key = parseMasterKey(bytes.toString("base64"));
    expect(key).toBeInstanceOf(Uint8Array);
    expect(hex(key)).toBe(bytes.toString("hex"));
  });

  it("accepts a key that is one repeated byte (env.ts is the one that refuses those)", () => {
    expect(parseMasterKey(Buffer.alloc(32, 0).toString("base64"))).toHaveLength(32);
  });

  it("is strict about the encoding: only canonical padded standard base64 passes", () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => 0xfb - i)); // yields "+" and "/"
    const std = bytes.toString("base64");
    expect(std).toMatch(/[+/]/);
    expect(parseMasterKey(std)).toHaveLength(32);
    const bad = [
      std.replace(/=+$/, ""), // unpadded
      std.replaceAll("+", "-").replaceAll("/", "_"), // url-safe alphabet
      `${std}\n`, // trailing newline from a shell
      ` ${std}`, // leading space
      `${std.slice(0, 10)}\n${std.slice(10)}`, // embedded line break
      `${std.slice(0, 10)}!${std.slice(10)}`, // stray character the lenient decoder skips
      lowBitSibling(std, B64), // non-canonical trailing bits
      `${std}${std}`, // two keys glued together
    ];
    for (const value of bad) {
      expect(() => parseMasterKey(value), JSON.stringify(value)).toThrow(/32 bytes/);
    }
  });

  it("the sibling case decodes to the same bytes under a lenient decoder (the test is not vacuous)", () => {
    const sibling = lowBitSibling(good, B64);
    expect(sibling).not.toBe(good);
    expect(Buffer.from(sibling, "base64").equals(Buffer.from(good, "base64"))).toBe(true);
    expect(() => parseMasterKey(sibling)).toThrow(/32 bytes/);
  });

  it("rejects a non-string", () => {
    for (const value of [undefined, null, 42, new Uint8Array(32)]) {
      expect(() => parseMasterKey(value as unknown as string)).toThrow(/32 bytes/);
    }
  });

  it("never puts the value it was given in the error", () => {
    const wrong = Buffer.from("distinctive-material-31-bytes-xx")
      .subarray(0, 31)
      .toString("base64");
    let message = "";
    try {
      parseMasterKey(wrong);
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/32 bytes/);
    expect(message).not.toContain(wrong);
    expect(message).not.toContain("distinctive");
  });
});

describe("deriveSubkey", () => {
  it("derives deterministic, distinct subkeys per purpose", async () => {
    const a1 = await deriveSubkey(MASTER, "agent_keys");
    const a2 = await deriveSubkey(MASTER, "agent_keys");
    const s = await deriveSubkey(MASTER, "session");
    expect(hex(a1)).toBe(hex(a2));
    expect(hex(a1)).not.toBe(hex(s));
    expect(hex(a1)).not.toBe(hex(MASTER));
  });

  const PURPOSES: SubkeyPurpose[] = ["agent_keys", "invoices", "session", "telegram", "visitor"];

  it("gives every purpose its own 32-byte subkey, different under another master", async () => {
    const mine = await Promise.all(PURPOSES.map((p) => deriveSubkey(MASTER, p)));
    const theirs = await Promise.all(PURPOSES.map((p) => deriveSubkey(OTHER, p)));
    for (const k of [...mine, ...theirs]) expect(k).toHaveLength(32);
    expect(new Set([...mine, ...theirs].map(hex)).size).toBe(PURPOSES.length * 2);
  });

  // Known answers: the first 8 bytes of each subkey of MASTER. Decision D4 says changing a subkey id (or
  // the KDF context) invalidates everything already stored, so a drift here must fail loudly. These were
  // recomputed with an independent BLAKE2b (key = master, salt = LE64(id), personal = context); they guard against change.
  const PINNED = [
    "527d472b8ecbba16",
    "6f5deb86c276d274",
    "5d4b80a0fbf58536",
    "000270cb289cbde9",
    "e8fd2ee27b21c2e8",
  ];

  it("keeps the subkey ids and KDF context stable (D4)", async () => {
    const got = await Promise.all(
      PURPOSES.map(async (p) => hex((await deriveSubkey(MASTER, p)).subarray(0, 8))),
    );
    expect(got).toEqual(PINNED);
  });

  it("rejects a master that is not 32 bytes", async () => {
    for (const n of [0, 16, 31, 33]) {
      await expect(deriveSubkey(new Uint8Array(n), "session")).rejects.toThrow(/32/);
    }
  });

  it("rejects a purpose it does not know, including inherited property names", async () => {
    for (const p of ["admin", "", "__proto__", "constructor", "toString"]) {
      await expect(deriveSubkey(MASTER, p as SubkeyPurpose)).rejects.toThrow(/purpose/);
    }
  });
});

describe("seal and open", () => {
  it("seals with a fresh nonce and opens only with the right key", async () => {
    const k = await deriveSubkey(MASTER, "agent_keys");
    const x = await seal(k, "hello");
    const y = await seal(k, "hello");
    expect(x.nonce).not.toBe(y.nonce);
    expect(Buffer.from(await open(k, x)).toString()).toBe("hello");
    await expect(open(await deriveSubkey(OTHER, "agent_keys"), x)).rejects.toBeInstanceOf(
      DecryptError,
    );
    const tampered = {
      ...x,
      ciphertext: Buffer.from(
        Buffer.from(x.ciphertext, "base64").map((v, i) => (i === 0 ? v ^ 1 : v)),
      ).toString("base64"),
    };
    await expect(open(k, tampered)).rejects.toBeInstanceOf(DecryptError);
  });

  it("stores standard padded base64: a 24-byte nonce and plaintext + 16 bytes of ciphertext", async () => {
    const k = await deriveSubkey(MASTER, "agent_keys");
    const s = await getSodium();
    const x = await seal(k, "hello!"); // 22 bytes sealed, so the encoding carries "=="
    expect(x.nonce).toMatch(/^[A-Za-z0-9+/]{32}$/);
    expect(x.ciphertext).toMatch(/^[A-Za-z0-9+/]{30}==$/);
    expect(s.from_base64(x.nonce, s.base64_variants.ORIGINAL)).toHaveLength(24);
    expect(s.from_base64(x.ciphertext, s.base64_variants.ORIGINAL)).toHaveLength(6 + 16);
  });

  it("round-trips binary and empty plaintext", async () => {
    const k = await deriveSubkey(MASTER, "invoices");
    const bin = Uint8Array.from([0, 255, 0, 1, 2, 254, 0]);
    expect(hex(await open(k, await seal(k, bin)))).toBe(hex(bin));
    expect(await open(k, await seal(k, ""))).toHaveLength(0);
    expect(Buffer.from(await open(k, await seal(k, "tiếng Việt ✓"))).toString()).toBe(
      "tiếng Việt ✓",
    );
  });

  it("fails closed on a key that is not 32 bytes", async () => {
    const k = await deriveSubkey(MASTER, "agent_keys");
    const sealed = await seal(k, "hello");
    for (const n of [0, 16, 31, 33, 64]) {
      const wrong = new Uint8Array(n).fill(7);
      await expect(seal(wrong, "x")).rejects.toThrow(/32/);
      await expect(open(wrong, sealed)).rejects.toThrow(/32/);
    }
    await expect(seal(null as unknown as Uint8Array, "x")).rejects.toThrow(/32/);
    await expect(open("k".repeat(32) as unknown as Uint8Array, sealed)).rejects.toThrow(/32/);
  });

  describe("open refuses anything that is not exactly what seal produced", () => {
    const setup = async (text: string) => {
      const k = await deriveSubkey(MASTER, "agent_keys");
      return { k, sealed: await seal(k, text) };
    };
    const raw = (b64: string) => Buffer.from(b64, "base64");

    it("a nonce of the wrong length", async () => {
      const { k, sealed } = await setup("hello");
      for (const n of [0, 1, 23, 25, 32]) {
        const nonce = Buffer.concat([raw(sealed.nonce), Buffer.alloc(32)]).subarray(0, n);
        const bad = { ...sealed, nonce: nonce.toString("base64") };
        await expect(open(k, bad), `nonce of ${n} bytes`).rejects.toBeInstanceOf(DecryptError);
      }
    });

    it("a ciphertext shorter than the authenticator, or empty", async () => {
      const { k, sealed } = await setup("hello");
      for (const n of [0, 1, 15]) {
        const ct = raw(sealed.ciphertext).subarray(0, n).toString("base64");
        await expect(open(k, { ...sealed, ciphertext: ct }), `${n} bytes`).rejects.toBeInstanceOf(
          DecryptError,
        );
      }
    });

    it("a changed or swapped nonce, a changed first, middle or last ciphertext byte", async () => {
      const { k, sealed } = await setup("hello world, this is the plaintext");
      const flip = (b64: string, at: number) => {
        const b = Buffer.from(raw(b64));
        b[at] = (b[at] ?? 0) ^ 0x80;
        return b.toString("base64");
      };
      const n = raw(sealed.ciphertext).length;
      for (const at of [0, 15, 16, Math.floor(n / 2), n - 1]) {
        await expect(
          open(k, { ...sealed, ciphertext: flip(sealed.ciphertext, at) }),
          `ciphertext byte ${at}`,
        ).rejects.toBeInstanceOf(DecryptError);
      }
      for (const at of [0, 12, 23]) {
        await expect(
          open(k, { ...sealed, nonce: flip(sealed.nonce, at) }),
          `nonce byte ${at}`,
        ).rejects.toBeInstanceOf(DecryptError);
      }
      const other = await seal(k, "hello world, this is the plaintext");
      await expect(open(k, { ciphertext: sealed.ciphertext, nonce: other.nonce })).rejects.toThrow(
        DecryptError,
      );
    });

    it.each([
      ["two padding characters", "hello!"],
      ["one padding character", "hello!!"],
    ])("a ciphertext whose trailing bits are not canonical (%s)", async (_label, text) => {
      const { k, sealed } = await setup(text);
      const sibling = lowBitSibling(sealed.ciphertext, B64);
      expect(sibling).not.toBe(sealed.ciphertext);
      // Same bytes to a lenient decoder: without the canonical check this would open.
      expect(raw(sibling).equals(raw(sealed.ciphertext))).toBe(true);
      await expect(open(k, { ...sealed, ciphertext: sibling })).rejects.toBeInstanceOf(
        DecryptError,
      );
    });

    it("a nonce whose encoding is not canonical", async () => {
      const { k, sealed } = await setup("hello");
      // 24 bytes encode with no padding, so build the variants around the canonical text.
      const variants = [
        `${sealed.nonce}=`, // stray padding
        `${sealed.nonce}\n`, // trailing newline
        ` ${sealed.nonce}`,
        `${sealed.nonce.slice(0, 5)}!${sealed.nonce.slice(5)}`, // junk a lenient decoder skips
        sealed.nonce.replaceAll("+", "-").replaceAll("/", "_"), // url-safe alphabet
      ];
      for (const nonce of variants) {
        // Only variants that a lenient decoder would still turn into the same 24 bytes are interesting.
        if (nonce === sealed.nonce) continue;
        await expect(open(k, { ...sealed, nonce }), JSON.stringify(nonce)).rejects.toBeInstanceOf(
          DecryptError,
        );
      }
    });

    it("a ciphertext in the unpadded, url-safe or whitespace-padded form", async () => {
      const k = await deriveSubkey(MASTER, "agent_keys");
      // bytes chosen so that the standard encoding contains "+" or "/" and padding
      let found: { good: Sealed; text: string } | null = null;
      for (let i = 0; i < 400 && found === null; i++) {
        const text = `plaintext-${i}!`;
        const c = await seal(k, text);
        if (/[+/]/.test(c.ciphertext) && c.ciphertext.endsWith("=")) found = { good: c, text };
      }
      expect(found).not.toBeNull();
      const { good, text } = found as { good: Sealed; text: string };
      const forms = [
        good.ciphertext.replace(/=+$/, ""),
        good.ciphertext.replaceAll("+", "-").replaceAll("/", "_"),
        `${good.ciphertext}\n`,
        `${good.ciphertext.slice(0, 8)} ${good.ciphertext.slice(8)}`,
      ];
      for (const ciphertext of forms) {
        await expect(open(k, { ...good, ciphertext }), ciphertext).rejects.toBeInstanceOf(
          DecryptError,
        );
      }
      expect(Buffer.from(await open(k, good)).toString()).toBe(text);
    });

    it("fields that are not strings (a null column, a number, undefined)", async () => {
      const { k, sealed } = await setup("hello");
      const bad = [
        { ...sealed, ciphertext: null },
        { ...sealed, nonce: null },
        { ...sealed, ciphertext: undefined },
        { ...sealed, nonce: 12345 },
        { ciphertext: sealed.ciphertext },
        {},
        null,
        undefined,
      ];
      for (const row of bad) {
        await expect(open(k, row as unknown as Sealed)).rejects.toBeInstanceOf(DecryptError);
      }
    });

    it("leaves no key material or plaintext in the error", async () => {
      const { k, sealed } = await setup("plaintext-marker-1234567890");
      const wrongKey = await deriveSubkey(OTHER, "agent_keys");
      let caught: unknown;
      try {
        await open(wrongKey, sealed);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DecryptError);
      const err = caught as DecryptError;
      const everything = `${err.message}|${err.name}|${err.stack ?? ""}|${JSON.stringify(err)}`;
      expect(err.message).toBe("decrypt_failed");
      expect(everything).not.toContain("plaintext-marker");
      for (const key of [k, wrongKey]) {
        expect(everything).not.toContain(hex(key));
        expect(everything).not.toContain(Buffer.from(key).toString("base64"));
      }
    });
  });
});

describe("tenantInvoiceKey", () => {
  it("derives a different invoice key per tenant", async () => {
    const a = await tenantInvoiceKey(MASTER, "tenant-a");
    const b = await tenantInvoiceKey(MASTER, "tenant-b");
    expect(hex(a)).not.toBe(hex(b));
    const sealed = await seal(a, "invoice body");
    await expect(open(b, sealed)).rejects.toBeInstanceOf(DecryptError);
  });

  it("is deterministic, 32 bytes, bound to the master and not the plain invoices subkey", async () => {
    const a1 = await tenantInvoiceKey(MASTER, "tenant-a");
    const a2 = await tenantInvoiceKey(MASTER, "tenant-a");
    expect(a1).toHaveLength(32);
    expect(hex(a1)).toBe(hex(a2));
    expect(hex(await tenantInvoiceKey(OTHER, "tenant-a"))).not.toBe(hex(a1));
    expect(hex(await deriveSubkey(MASTER, "invoices"))).not.toBe(hex(a1));
  });

  it("refuses an empty tenant id (that would be one key for everybody) and a bad master", async () => {
    await expect(tenantInvoiceKey(MASTER, "")).rejects.toThrow(/tenant/);
    await expect(tenantInvoiceKey(MASTER, undefined as unknown as string)).rejects.toThrow(
      /tenant/,
    );
    await expect(tenantInvoiceKey(new Uint8Array(31), "t")).rejects.toThrow(/32/);
  });
});

describe("MAC tokens", () => {
  const PAYLOAD = { a: "alice.near", e: 123 };

  it("MAC tokens round-trip and reject tampering, wrong keys and junk", async () => {
    const k = await deriveSubkey(MASTER, "session");
    const t = await macToken(k, { a: "alice.near", e: 123 });
    expect(await readMacToken(k, t)).toEqual({ a: "alice.near", e: 123 });
    const [body, tag] = t.split(".");
    const forged = `${Buffer.from(JSON.stringify({ a: "eve.near", e: 123 })).toString("base64url")}.${tag}`;
    expect(await readMacToken(k, forged)).toBeNull();
    expect(await readMacToken(await deriveSubkey(OTHER, "session"), t)).toBeNull();
    expect(await readMacToken(k, `${body}`)).toBeNull();
    expect(await readMacToken(k, "a.b.c")).toBeNull();
  });

  it("is base64url on both sides of one dot, and deterministic", async () => {
    const k = await deriveSubkey(MASTER, "session");
    const t = await macToken(k, PAYLOAD);
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(await macToken(k, PAYLOAD)).toBe(t);
    expect(await macToken(k, { ...PAYLOAD, e: 124 })).not.toBe(t);
  });

  it("R7: a tag whose last character differs only in the unused low bits is rejected", async () => {
    const k = await deriveSubkey(MASTER, "session");
    const t = await macToken(k, PAYLOAD);
    const [body, tag] = t.split(".") as [string, string];
    const sibling = lowBitSibling(tag, B64URL);
    expect(sibling).not.toBe(tag);
    // A lenient decoder maps both strings to the same 32 bytes, so only the canonical check tells them apart.
    expect(Buffer.from(sibling, "base64url").equals(Buffer.from(tag, "base64url"))).toBe(true);
    expect(await readMacToken(k, `${body}.${tag}`)).toEqual(PAYLOAD);
    expect(await readMacToken(k, `${body}.${sibling}`)).toBeNull();
  });

  it("R7: a changed middle character of the tag or of the body is rejected", async () => {
    const k = await deriveSubkey(MASTER, "session");
    const [body, tag] = (await macToken(k, PAYLOAD)).split(".") as [string, string];
    const midTag = tamperAt(tag, Math.floor(tag.length / 2), B64URL);
    const midBody = tamperAt(body, Math.floor(body.length / 2), B64URL);
    expect(midTag).not.toBe(tag);
    expect(midBody).not.toBe(body);
    expect(await readMacToken(k, `${body}.${midTag}`)).toBeNull();
    expect(await readMacToken(k, `${midBody}.${tag}`)).toBeNull();
    // and the very first and very last characters of both parts
    for (const i of [0, tag.length - 1]) {
      expect(await readMacToken(k, `${body}.${tamperAt(tag, i, B64URL)}`)).toBeNull();
    }
    for (const i of [0, body.length - 1]) {
      expect(await readMacToken(k, `${tamperAt(body, i, B64URL)}.${tag}`)).toBeNull();
    }
  });

  it("R7: a body that is signed but not in canonical base64url is rejected too", async () => {
    // Only a holder of the key could produce this tag, so this is defence in depth: authenticated
    // data is decoded canonically as well.
    const k = await deriveSubkey(MASTER, "session");
    const s = await getSodium();
    const [body] = (await macToken(k, PAYLOAD)).split(".") as [string, string];
    const sibling = lowBitSibling(body, B64URL);
    expect(Buffer.from(sibling, "base64url").equals(Buffer.from(body, "base64url"))).toBe(true);
    const tag = Buffer.from(s.crypto_auth(s.from_string(sibling), k)).toString("base64url");
    expect(await readMacToken(k, `${sibling}.${tag}`)).toBeNull();
  });

  it("rejects tag forms that are not exactly 43 canonical base64url characters", async () => {
    const k = await deriveSubkey(MASTER, "session");
    const [body, tag] = (await macToken(k, PAYLOAD)).split(".") as [string, string];
    const std = Buffer.from(tag, "base64url").toString("base64");
    const bad = [
      "",
      tag.slice(0, -1), // truncated
      `${tag}A`, // extended
      `${tag}=`, // padded
      std, // standard alphabet, padded
      `${tag.slice(0, 10)}\n${tag.slice(10)}`,
      ` ${tag}`,
      `${tag}\n`,
      `${tag.slice(0, 10)}!${tag.slice(10)}`,
      tag.toUpperCase(),
    ];
    for (const t of bad) {
      expect(await readMacToken(k, `${body}.${t}`), JSON.stringify(t)).toBeNull();
    }
  });

  it("rejects malformed tokens: missing parts, extra dots, empty parts, junk, non-strings", async () => {
    const k = await deriveSubkey(MASTER, "session");
    const t = await macToken(k, PAYLOAD);
    const [body, tag] = t.split(".") as [string, string];
    for (const bad of ["", ".", `${body}.`, `.${tag}`, `${t}.`, `${t}.${tag}`, `${body}..${tag}`]) {
      expect(await readMacToken(k, bad), JSON.stringify(bad)).toBeNull();
    }
    for (const bad of [undefined, null, 5, {}, ["a", "b"]]) {
      expect(await readMacToken(k, bad as unknown as string)).toBeNull();
    }
  });

  it("a valid MAC over a body that is not JSON (or not UTF-8) is null, not a throw", async () => {
    const k = await deriveSubkey(MASTER, "session");
    const s = await getSodium();
    const sign = (bytes: Uint8Array) => {
      const body = Buffer.from(bytes).toString("base64url");
      const tag = Buffer.from(s.crypto_auth(s.from_string(body), k)).toString("base64url");
      return `${body}.${tag}`;
    };
    expect(await readMacToken(k, sign(Buffer.from("not json")))).toBeNull();
    expect(await readMacToken(k, sign(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])))).toBeNull();
    // invalid UTF-8 inside an otherwise valid JSON string must not become U+FFFD
    const damaged = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    expect(await readMacToken(k, sign(damaged))).toBeNull();
    expect(await readMacToken(k, sign(Buffer.from("")))).toBeNull();
    expect(await readMacToken(k, sign(Buffer.from('{"ok":true}')))).toEqual({ ok: true });
  });

  it("a token for one purpose does not verify under another", async () => {
    const t = await macToken(await deriveSubkey(MASTER, "session"), PAYLOAD);
    expect(await readMacToken(await deriveSubkey(MASTER, "visitor"), t)).toBeNull();
    expect(await readMacToken(await deriveSubkey(MASTER, "telegram"), t)).toBeNull();
  });

  it("compares the received tag with sodium.memcmp, never with a short-circuiting compare", async () => {
    const k = await deriveSubkey(MASTER, "session");
    const t = await macToken(k, PAYLOAD);
    const s = await getSodium();
    const spy = vi.spyOn(s, "memcmp");
    try {
      expect(await readMacToken(k, t)).toEqual(PAYLOAD);
      expect(spy).toHaveBeenCalledTimes(1);
      const [a, b] = spy.mock.calls[0] as [Uint8Array, Uint8Array];
      expect(a).toHaveLength(32);
      expect(b).toHaveLength(32);
      expect(spy.mock.results[0]?.value).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("fails closed on a key that is not 32 bytes", async () => {
    const k = await deriveSubkey(MASTER, "session");
    const t = await macToken(k, PAYLOAD);
    for (const n of [0, 16, 31, 33, 64]) {
      const wrong = new Uint8Array(n).fill(3);
      await expect(macToken(wrong, PAYLOAD)).rejects.toThrow(/32/);
      await expect(readMacToken(wrong, t)).rejects.toThrow(/32/);
    }
    // a 31-byte prefix of the real key must not verify the token either
    await expect(readMacToken(k.subarray(0, 31), t)).rejects.toThrow(/32/);
  });
});

describe("keyedHashHex", () => {
  it("keyed hashes are stable hex and depend on the key", async () => {
    const k1 = await deriveSubkey(MASTER, "visitor");
    const k2 = await deriveSubkey(OTHER, "visitor");
    expect(await keyedHashHex(k1, "203.0.113.7")).toMatch(/^[0-9a-f]{64}$/);
    expect(await keyedHashHex(k1, "203.0.113.7")).toBe(await keyedHashHex(k1, "203.0.113.7"));
    expect(await keyedHashHex(k1, "203.0.113.7")).not.toBe(await keyedHashHex(k2, "203.0.113.7"));
  });

  it("depends on the message and fails closed on a key that is not 32 bytes", async () => {
    const k = await deriveSubkey(MASTER, "visitor");
    expect(await keyedHashHex(k, "203.0.113.7")).not.toBe(await keyedHashHex(k, "203.0.113.8"));
    for (const n of [0, 15, 16, 31, 33, 64]) {
      await expect(keyedHashHex(new Uint8Array(n).fill(1), "x")).rejects.toThrow(/32/);
    }
  });
});

describe("sha256Hex", () => {
  it("sha256Hex matches the FIPS 180-2 test vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes bytes and strings alike, and the empty input", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
