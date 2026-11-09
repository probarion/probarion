import { describe, expect, it } from "vitest";
import {
  connectUrl,
  fromOwnPage,
  isConnectPage,
  NONCE_RE,
  newNonce,
  readConnectMessage,
} from "../src/connect";
import { NOW, ORIGIN, TOKEN } from "./helpers";

const good = {
  type: "probarion:connect",
  v: 1,
  nonce: "n".repeat(22),
  token: TOKEN,
  account: "owner.testnet",
  network: "testnet",
  expires_at: "2026-12-10T00:00:00.000Z",
};

describe("the nonce", () => {
  it("is 16 random bytes in base64url", () => {
    expect(newNonce(() => new Uint8Array(16).fill(255))).toBe(`${"_".repeat(21)}w`);
    const a = newNonce();
    expect(a).toMatch(NONCE_RE);
    expect(a).toHaveLength(22);
    expect(newNonce()).not.toBe(a);
  });

  it("goes to the connect page", () => {
    expect(connectUrl(ORIGIN, "abc_-")).toBe(`${ORIGIN}/extension?nonce=abc_-`);
  });
});

describe("the page's connect message", () => {
  it("is read when it has exactly the connect shape", () => {
    const { type: _t, v: _v, ...fields } = good;
    expect(readConnectMessage(good, NOW)).toEqual(fields);
  });

  it.each<[string, unknown]>([
    ["another type", { ...good, type: "probarion:other" }],
    ["another version", { ...good, v: 2 }],
    ["no nonce", { ...good, nonce: undefined }],
    ["a short nonce", { ...good, nonce: "short" }],
    ["a nonce with other characters", { ...good, nonce: `${"n".repeat(21)}/` }],
    ["a token of another kind", { ...good, token: `xyz_${"A".repeat(43)}` }],
    ["a short token", { ...good, token: "pbx_abc" }],
    ["an account that isn't one", { ...good, account: "Owner Name" }],
    ["another network", { ...good, network: "betanet" }],
    ["an end that isn't a time", { ...good, expires_at: "soon" }],
    ["a token that already ended", { ...good, expires_at: "2026-11-01T00:00:00.000Z" }],
    ["null", null],
    ["a string", "probarion:connect"],
    ["an array", [good]],
  ])("is ignored with %s", (_name, data) => {
    expect(readConnectMessage(data, NOW)).toBeNull();
  });
});

describe("where the message came from", () => {
  const win = { location: { origin: ORIGIN } };

  it("counts only this window, at its own Probarion address", () => {
    expect(fromOwnPage({ source: win, origin: ORIGIN }, win)).toBe(true);
    expect(fromOwnPage({ source: {}, origin: ORIGIN }, win)).toBe(false);
    expect(fromOwnPage({ source: null, origin: ORIGIN }, win)).toBe(false);
    expect(fromOwnPage({ source: win, origin: "https://evil.example" }, win)).toBe(false);
    const evil = { location: { origin: "https://evil.example" } };
    expect(fromOwnPage({ source: evil, origin: "https://evil.example" }, evil)).toBe(false);
  });

  it("is Probarion's /extension page when the worker checks the sender", () => {
    expect(isConnectPage({ origin: ORIGIN, url: `${ORIGIN}/extension?nonce=x` })).toBe(true);
    expect(isConnectPage({ origin: ORIGIN, url: `${ORIGIN}/console` })).toBe(false);
    expect(isConnectPage({ origin: ORIGIN, url: "https://probarion.xyz/extension" })).toBe(false);
    expect(
      isConnectPage({ origin: "https://evil.example", url: "https://evil.example/extension" }),
    ).toBe(false);
    expect(isConnectPage({ origin: ORIGIN })).toBe(false);
  });
});
