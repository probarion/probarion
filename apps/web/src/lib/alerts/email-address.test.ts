import { describe, expect, it } from "vitest";
import { normalizeEmail } from "./email-address";

describe("normalizeEmail", () => {
  it("takes one address, trims it and lower-cases it", () => {
    expect(normalizeEmail("  Finance@Example.COM ")).toBe("finance@example.com");
    expect(normalizeEmail("a.b+tag@mail.example.co.uk")).toBe("a.b+tag@mail.example.co.uk");
    expect(normalizeEmail("first_last-1@x-y.example.com")).toBe("first_last-1@x-y.example.com");
    expect(normalizeEmail("a!b#c@example.io")).toBe("a!b#c@example.io");
    expect(normalizeEmail(`${"a".repeat(64)}@example.com`)).toBe(`${"a".repeat(64)}@example.com`);
  });

  it("refuses a list, a display name, a comment, a quote, a backslash or a control character in the local part", () => {
    const bad = [
      "a@b.co,victim@x.co",
      "a@b.co;victim@x.co",
      "a@b.co victim@x.co",
      "a@b.co\nvictim@x.co",
      "<a@b.co>",
      "Name <a@b.co>",
      '"a"@b.co',
      "o'brien@b.co",
      "a(c)@b.co",
      "a\\b@c.co",
      "a\u0000@b.co",
      "a\u0007@b.co",
      "a\u007f@b.co",
      "a​@b.co",
      "é@example.com",
      "a b@example.com",
    ];
    for (const address of bad) expect(normalizeEmail(address), JSON.stringify(address)).toBeNull();
  });

  it("refuses more or less than one @, an empty part, and a local part over 64 characters", () => {
    for (const address of [
      "a@b@c.co",
      "@b.co",
      "a@",
      "a",
      "",
      " ",
      `${"a".repeat(65)}@example.com`,
    ]) {
      expect(normalizeEmail(address), JSON.stringify(address)).toBeNull();
    }
  });

  it("wants a domain of dot-separated labels, with a dot, of letters, digits and inner hyphens", () => {
    for (const address of [
      "a@b",
      "a@b.",
      "a@.co",
      "a@b..co",
      "a@-b.co",
      "a@b-.co",
      "a@b_c.co",
      "a@b.c o",
      "a@b.co.",
      "a@[127.0.0.1]",
      "a@é.co",
      "a@b.co/x",
      "a@b.co:25",
    ]) {
      expect(normalizeEmail(address), JSON.stringify(address)).toBeNull();
    }
    expect(normalizeEmail("a@127.0.0.1")).toBe("a@127.0.0.1"); // digits and dots are a domain to this rule
  });

  it("refuses an address over 254 characters, and anything that is not text", () => {
    const long = `a@${["b", "c", "d", "e", "f"].map((c) => c.repeat(60)).join(".")}.co`;
    expect(long.length).toBeGreaterThan(254);
    expect(normalizeEmail(long)).toBeNull();
    for (const v of [null, undefined, 5, {}, ["a@b.co"]]) {
      expect(normalizeEmail(v as never)).toBeNull();
    }
  });
});
