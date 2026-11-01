import { describe, expect, it } from "vitest";

describe("test network guard (R20)", () => {
  it("rejects fetch to a non-loopback host before any socket opens", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow(/network access is disabled/);
    await expect(fetch(new URL("https://rpc.testnet.fastnear.com"))).rejects.toThrow(
      /network access is disabled/,
    );
    await expect(fetch(new Request("https://example.com/x"))).rejects.toThrow(
      /network access is disabled/,
    );
  });

  it("rejects an unparseable url instead of letting it through", async () => {
    await expect(fetch("not a url")).rejects.toThrow(/network access is disabled/);
  });

  it("does not block loopback: the call reaches the network stack and fails there, not in the guard", async () => {
    const error = await fetch("http://127.0.0.1:1/").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/network access is disabled/);
  });
});
