import { describe, expect, it } from "vitest";
import { ALERT_COLOR, BADGE_COLOR, badgeColor, badgeText } from "../src/badge";

describe("the badge", () => {
  it.each<[{ expired: boolean; pending: boolean; count: number }, string]>([
    [{ expired: false, pending: false, count: 0 }, ""],
    [{ expired: false, pending: false, count: 3 }, "3"],
    [{ expired: false, pending: false, count: 120 }, "99+"],
    [{ expired: false, pending: true, count: 3 }, "+"],
    [{ expired: true, pending: true, count: 3 }, "!"],
    [{ expired: false, pending: false, count: -1 }, ""],
  ])("shows %o as %j", (state, text) => {
    expect(badgeText(state)).toBe(text);
  });

  it("is red only for an ended connection", () => {
    expect(badgeColor("!")).toBe(ALERT_COLOR);
    expect(badgeColor("3")).toBe(BADGE_COLOR);
  });
});
