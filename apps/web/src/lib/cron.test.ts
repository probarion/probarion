import { describe, expect, it } from "vitest";
import { cronAuthorized } from "./cron";

const SECRET = "s".repeat(40);
const req = (h?: string) =>
  new Request("https://x/api/cron/metrics", { headers: h ? { authorization: h } : {} });

describe("cronAuthorized", () => {
  it("accepts only Bearer <CRON_SECRET>", () => {
    expect(cronAuthorized(req(`Bearer ${SECRET}`), SECRET)).toBe(true);
    expect(cronAuthorized(req(`Bearer ${SECRET}x`), SECRET)).toBe(false);
    expect(cronAuthorized(req(SECRET), SECRET)).toBe(false);
    expect(cronAuthorized(req(), SECRET)).toBe(false);
    expect(cronAuthorized(req("Bearer "), "")).toBe(false);
  });

  it("refuses a header of a different length without throwing, longer or shorter", () => {
    expect(cronAuthorized(req(`Bearer ${SECRET.slice(1)}`), SECRET)).toBe(false);
    expect(cronAuthorized(req(`Bearer ${SECRET}${SECRET}`), SECRET)).toBe(false);
    expect(cronAuthorized(req("Bearer"), SECRET)).toBe(false);
    expect(cronAuthorized(req("x"), SECRET)).toBe(false);
  });

  it("refuses a header of the right length with one wrong character", () => {
    expect(cronAuthorized(req(`Bearer ${"s".repeat(39)}t`), SECRET)).toBe(false);
    expect(cronAuthorized(req(`bearer ${SECRET}`), SECRET)).toBe(false);
  });

  it("refuses a secret shorter than 32 characters, even when the header matches it", () => {
    const short = "s".repeat(31);
    expect(cronAuthorized(req(`Bearer ${short}`), short)).toBe(false);
    expect(cronAuthorized(req("Bearer short"), "short")).toBe(false);
    const min = "s".repeat(32);
    expect(cronAuthorized(req(`Bearer ${min}`), min)).toBe(true);
  });
});
