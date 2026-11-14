import { describe, expect, it } from "vitest";
import { CANARY_VIA, parseVia, withVia } from "./via";

describe("parseVia", () => {
  it("keeps each source a link of ours may name", () => {
    for (const via of CANARY_VIA) expect(parseVia(via)).toBe(via);
  });

  it("is the closed set the site audit named, plus the /usage page's link and the team's Telegram link", () => {
    expect([...CANARY_VIA].sort()).toEqual(
      ["ext", "home", "proof", "readme", "share", "tamper", "tg", "usage", "x"].sort(),
    );
  });

  it("keeps a Telegram link's source, and only in its exact word", () => {
    expect(parseVia("tg")).toBe("tg");
    expect(withVia("/canary/rules", "tg")).toBe("/canary/rules?via=tg");
    for (const other of ["TG", "telegram", "t.me"]) expect(parseVia(other)).toBeNull();
  });

  it("is null for anything else: an unknown word, another case, blanks, a list, no value", () => {
    for (const other of [
      "X",
      " x",
      "x ",
      "twitter",
      "",
      "readme2",
      "x,readme",
      ["x"],
      ["x", "readme"],
      7,
      null,
      undefined,
      {},
    ]) {
      expect(parseVia(other), JSON.stringify(other)).toBeNull();
    }
  });

  it("only ever answers a short lowercase word, the shape the database accepts", () => {
    for (const via of CANARY_VIA) expect(via).toMatch(/^[a-z]{1,16}$/);
  });
});

describe("withVia", () => {
  it("keeps the source on a link to another Canary page, and adds nothing without one", () => {
    expect(withVia("/canary/rules", "x")).toBe("/canary/rules?via=x");
    expect(withVia("/canary", "readme")).toBe("/canary?via=readme");
    expect(withVia("/canary", null)).toBe("/canary");
  });
});
