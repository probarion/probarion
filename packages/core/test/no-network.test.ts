import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

/** A loopback port that nothing listens on: bind an ephemeral port, note it, close it. */
async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no ephemeral port");
  return address.port;
}

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

  it("lets loopback through to the network stack: a closed local port fails with a connection error, not with the guard", async () => {
    const port = await closedLoopbackPort();
    for (const host of ["127.0.0.1", "localhost"]) {
      const error = await fetch(`http://${host}:${port}/`).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toMatch(/network access is disabled/);
      // undici reports a refused connection as TypeError("fetch failed") with the socket error as cause;
      // the guard throws a plain Error without one, so a cause proves the request reached the network stack.
      expect((error as Error).cause).toBeDefined();
    }
  });
});
