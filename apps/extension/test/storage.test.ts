import { describe, expect, it } from "vitest";
import {
  addNonce,
  type Connection,
  clearPending,
  dropConnection,
  getPending,
  loadLocal,
  markExpired,
  migrate,
  NONCE_TTL_MS,
  putConnection,
  selectOrigin,
  setPending,
  takeNonce,
} from "../src/storage";
import { fakeChrome } from "./fake-chrome";
import { NOW, ORIGIN, OTHER_ORIGIN, TOKEN, TOKEN_B } from "./helpers";

const conn = (over: Partial<Connection> = {}): Connection => ({
  network: "testnet",
  account: "owner.testnet",
  token: TOKEN,
  expires_at: "2026-12-10T00:00:00.000Z",
  connected_at: "2026-11-10T00:00:00.000Z",
  expired: false,
  ...over,
});
const NONCE = "n".repeat(22);

describe("the connections", () => {
  it("are read back as written, the last one chosen", async () => {
    const c = fakeChrome();
    await putConnection(c, ORIGIN, conn());
    await putConnection(c, OTHER_ORIGIN, conn({ network: "mainnet", account: "owner.near" }));
    const s = await loadLocal(c);
    expect(s.connections[ORIGIN]).toEqual(conn());
    expect(s.selectedOrigin).toBe(OTHER_ORIGIN);
    expect(c.data.local.get("schema")).toBe(1);
    await selectOrigin(c, ORIGIN);
    expect((await loadLocal(c)).selectedOrigin).toBe(ORIGIN);
  });

  it("reads a connection stored without `expired` as not expired", () => {
    const { expired: _, ...old } = conn();
    expect(migrate({ connections: { [ORIGIN]: old }, selectedOrigin: ORIGIN })).toEqual({
      connections: { [ORIGIN]: conn() },
      selectedOrigin: ORIGIN,
    });
  });

  it("drop a connection they can't read, or one for an origin this build doesn't trust", () => {
    const s = migrate({
      schema: 1,
      connections: {
        [ORIGIN]: conn({ token: "pbx_short" }),
        [OTHER_ORIGIN]: { ...conn(), network: "betanet" },
        "https://evil.example": conn(),
        "https://testnet.probarion.xyz": conn(),
      },
      selectedOrigin: ORIGIN,
    });
    expect(Object.keys(s.connections)).toEqual(["https://testnet.probarion.xyz"]);
    expect(s.selectedOrigin).toBe("https://testnet.probarion.xyz");
  });

  it("read a newer version's layout as empty rather than guess at it", () => {
    expect(
      migrate({ schema: 2, connections: { [ORIGIN]: conn() }, selectedOrigin: ORIGIN }),
    ).toEqual({
      connections: {},
      selectedOrigin: null,
    });
    expect(migrate({})).toEqual({ connections: {}, selectedOrigin: null });
  });

  it("choose another connection when the chosen one goes", async () => {
    const c = fakeChrome();
    await putConnection(c, OTHER_ORIGIN, conn());
    await putConnection(c, ORIGIN, conn());
    await dropConnection(c, ORIGIN);
    expect(await loadLocal(c)).toEqual({
      connections: { [OTHER_ORIGIN]: conn() },
      selectedOrigin: OTHER_ORIGIN,
    });
    await dropConnection(c, OTHER_ORIGIN);
    expect(await loadLocal(c)).toEqual({ connections: {}, selectedOrigin: null });
  });

  it("are marked expired in place", async () => {
    const c = fakeChrome();
    await putConnection(c, ORIGIN, conn());
    expect(await markExpired(c, ORIGIN, TOKEN)).toBe(true);
    expect((await loadLocal(c)).connections[ORIGIN]).toEqual(conn({ expired: true }));
  });

  it("are marked expired only while they hold the token that got the 401", async () => {
    const c = fakeChrome();
    await putConnection(c, ORIGIN, conn());
    // A reconnect stored a new token for this address while the old token's request was out.
    await putConnection(c, ORIGIN, conn({ token: TOKEN_B }));
    expect(await markExpired(c, ORIGIN, TOKEN)).toBe(false);
    expect((await loadLocal(c)).connections[ORIGIN]).toEqual(conn({ token: TOKEN_B }));
    expect(await markExpired(c, OTHER_ORIGIN, TOKEN)).toBe(false);
    expect(await markExpired(c, ORIGIN, TOKEN_B)).toBe(true);
    expect((await loadLocal(c)).connections[ORIGIN]?.expired).toBe(true);
  });

  it("hand back the connection a new one for the same address replaces", async () => {
    const c = fakeChrome();
    expect(await putConnection(c, ORIGIN, conn())).toBeUndefined();
    expect(await putConnection(c, OTHER_ORIGIN, conn())).toBeUndefined();
    expect(await putConnection(c, ORIGIN, conn({ token: TOKEN_B }))).toEqual(conn());
  });

  it("loses no write when two connections expire at once", async () => {
    const c = fakeChrome();
    await putConnection(c, ORIGIN, conn());
    await putConnection(c, OTHER_ORIGIN, conn());
    await Promise.all([markExpired(c, ORIGIN, TOKEN), markExpired(c, OTHER_ORIGIN, TOKEN)]);
    const s = await loadLocal(c);
    expect([s.connections[ORIGIN]?.expired, s.connections[OTHER_ORIGIN]?.expired]).toEqual([
      true,
      true,
    ]);
  });
});

describe("the connect nonces", () => {
  it("are taken once, for their own origin", async () => {
    const c = fakeChrome();
    await addNonce(c, NONCE, ORIGIN, NOW);
    expect(await takeNonce(c, NONCE, ORIGIN, NOW + 1000)).toBe(true);
    expect(await takeNonce(c, NONCE, ORIGIN, NOW + 2000)).toBe(false);
  });

  it("takes a nonce once even when two messages race for it", async () => {
    const c = fakeChrome();
    await addNonce(c, NONCE, ORIGIN, NOW);
    expect(
      await Promise.all([takeNonce(c, NONCE, ORIGIN, NOW), takeNonce(c, NONCE, ORIGIN, NOW)]),
    ).toEqual([true, false]);
  });

  it("are used up by a try from another origin", async () => {
    const c = fakeChrome();
    await addNonce(c, NONCE, ORIGIN, NOW);
    expect(await takeNonce(c, NONCE, OTHER_ORIGIN, NOW)).toBe(false);
    expect(await takeNonce(c, NONCE, ORIGIN, NOW)).toBe(false);
  });

  it("end after 15 minutes", async () => {
    const c = fakeChrome();
    await addNonce(c, NONCE, ORIGIN, NOW);
    expect(await takeNonce(c, NONCE, ORIGIN, NOW + NONCE_TTL_MS)).toBe(false);
  });

  it("keep only the newest five", async () => {
    const c = fakeChrome();
    for (let i = 0; i < 6; i++) await addNonce(c, `${i}`.repeat(22), ORIGIN, NOW + i);
    expect(await takeNonce(c, "0".repeat(22), ORIGIN, NOW + 10)).toBe(false);
    expect(await takeNonce(c, "5".repeat(22), ORIGIN, NOW + 10)).toBe(true);
  });
});

describe("the captured invoice", () => {
  it("waits in session storage for the popup", async () => {
    const c = fakeChrome();
    expect(await getPending(c)).toBeNull();
    const item = {
      name: "a.pdf",
      type: "application/pdf" as const,
      size: 5,
      base64: "JVBERi0=",
      preview: null,
    };
    await setPending(c, { state: "ready", item, seen: false });
    expect(await getPending(c)).toEqual({ state: "ready", item, seen: false });
    expect(c.data.local.has("pending")).toBe(false);
    await clearPending(c);
    expect(await getPending(c)).toBeNull();
  });

  it("reads as nothing when it isn't what this version wrote", async () => {
    const c = fakeChrome();
    await c.storage.session.set({ pending: { state: "ready", item: { name: "x" }, seen: true } });
    expect(await getPending(c)).toBeNull();
    await c.storage.session.set({ pending: { state: "reading", started_at: "soon", seen: true } });
    expect(await getPending(c)).toBeNull();
  });
});
