import { describe, expect, it } from "vitest";

describe("no-network setup (R20)", () => {
  it("throws before opening a socket for a non-loopback host", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow(/network access is disabled/);
    await expect(fetch(new URL("https://rpc.mainnet.fastnear.com"))).rejects.toThrow(
      /network access is disabled/,
    );
  });

  it("also refuses a URL it cannot parse", async () => {
    await expect(fetch("not a url")).rejects.toThrow(/network access is disabled/);
  });
});
