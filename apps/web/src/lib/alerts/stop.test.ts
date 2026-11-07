import { describe, expect, it, vi } from "vitest";
import { deriveSubkey, getSodium, parseMasterKey } from "@/lib/crypto/sodium";
import { parseStopParams, stopLinks, stopToken, verifyStopToken } from "./stop";

const SUB = "6f9619ff-8b86-4d11-b42d-00c04fc964ff";
const OTHER_SUB = "7f9619ff-8b86-4d11-b42d-00c04fc964ff";
const key = (n: number) =>
  deriveSubkey(parseMasterKey(Buffer.alloc(32, n).toString("base64")), "alerts");

describe("stop links", () => {
  it("makes a token that is a keyed hash of the subscription id: stable, 64 hex characters, one per id and key", async () => {
    const t = await stopToken(await key(1), SUB);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(await stopToken(await key(1), SUB)).toBe(t);
    expect(await stopToken(await key(1), OTHER_SUB)).not.toBe(t);
    expect(await stopToken(await key(2), SUB)).not.toBe(t);
  });

  it("accepts the token for that subscription and nothing else", async () => {
    const k = await key(1);
    const t = await stopToken(k, SUB);
    expect(await verifyStopToken(k, SUB, t)).toBe(true);
    expect(await verifyStopToken(k, OTHER_SUB, t)).toBe(false);
    expect(await verifyStopToken(await key(2), SUB, t)).toBe(false);
    const flipped = `${t.slice(0, -1)}${t.endsWith("0") ? "1" : "0"}`;
    for (const bad of [
      flipped,
      "",
      t.slice(1),
      `${t}0`,
      t.toUpperCase(),
      "g".repeat(64),
      "../".repeat(20),
    ]) {
      expect(await verifyStopToken(k, SUB, bad), bad).toBe(false);
    }
    expect(await verifyStopToken(k, "not-a-uuid", t)).toBe(false);
  });

  it("compares the token in constant time, with sodium.memcmp", async () => {
    const k = await key(1);
    const t = await stopToken(k, SUB);
    const s = await getSodium();
    const spy = vi.spyOn(s, "memcmp");
    await verifyStopToken(k, SUB, t);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("builds the page link and the one-click link, each with the id and the token in the query", async () => {
    const k = await key(1);
    const t = await stopToken(k, SUB);
    const links = await stopLinks("https://probarion.xyz", k, SUB);
    expect(links.page).toBe(`https://probarion.xyz/alerts/stop?s=${SUB}&t=${t}`);
    expect(links.oneClick).toBe(`https://probarion.xyz/api/alerts/stop?s=${SUB}&t=${t}`);
  });

  it("reads the id and the token from a query, and refuses a bad shape before anything else", () => {
    const t = "a".repeat(64);
    expect(parseStopParams(new URLSearchParams({ s: SUB, t }))).toEqual({ id: SUB, token: t });
    expect(parseStopParams({ s: SUB, t })).toEqual({ id: SUB, token: t });
    expect(parseStopParams({ s: [SUB, SUB], t })).toBeNull();
    expect(parseStopParams({ s: SUB })).toBeNull();
    expect(parseStopParams({ s: "x", t })).toBeNull();
    expect(parseStopParams({ s: SUB, t: "x" })).toBeNull();
    expect(parseStopParams({ s: SUB, t: "A".repeat(64) })).toBeNull();
  });
});
