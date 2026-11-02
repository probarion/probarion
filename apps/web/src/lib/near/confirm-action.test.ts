import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  serviceDb: vi.fn(() => ({ db: true })),
  rateLimitOr429: vi.fn(),
  confirmTx: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db/clients", () => ({ serviceDb: mocks.serviceDb }));
vi.mock("@/lib/http", () => ({ rateLimitOr429: mocks.rateLimitOr429 }));
vi.mock("./confirm", () => ({ confirmTx: mocks.confirmTx }));

import { confirmTxAction } from "./confirm-action";

const HASH = "9fV2pZ7mUq5f6p3rGq7bX1tYkqfUu1Vb3bWm2C5g7h8J";
const OK = { status: "ok", txHash: HASH, code: null, error: null };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.serviceDb.mockReturnValue({ db: true });
  mocks.getSession.mockResolvedValue({ accountId: "owner.near", exp: Date.now() + 1000 });
  mocks.rateLimitOr429.mockResolvedValue(null);
  mocks.confirmTx.mockResolvedValue(OK);
});

describe("confirmTxAction", () => {
  it("a signed-in owner gets the chain's answer, for exactly what was asked", async () => {
    const r = await confirmTxAction(HASH, "owner.near", "freeze", "acme.vaults.probarion.near");
    expect(r).toEqual(OK);
    expect(mocks.confirmTx).toHaveBeenCalledWith(
      HASH,
      "owner.near",
      "freeze",
      "acme.vaults.probarion.near",
    );
  });

  it("rate-limits per signed-in account (30 a minute)", async () => {
    await confirmTxAction(HASH, "owner.near", "freeze", "v.near");
    expect(mocks.rateLimitOr429).toHaveBeenCalledWith({ db: true }, "confirm:owner.near", [30, 60]);
  });

  it("no session: unknown, and the network is not asked", async () => {
    mocks.getSession.mockResolvedValue(null);
    const r = await confirmTxAction(HASH, "owner.near", "freeze", "v.near");
    expect(r).toMatchObject({ status: "unknown", txHash: HASH });
    expect(r.error).toMatch(/Sign in again/);
    expect(mocks.confirmTx).not.toHaveBeenCalled();
    expect(mocks.rateLimitOr429).not.toHaveBeenCalled();
  });

  it("rate limited: unknown, and the network is not asked", async () => {
    mocks.rateLimitOr429.mockResolvedValue(new Response(null, { status: 429 }));
    const r = await confirmTxAction(HASH, "owner.near", "freeze", "v.near");
    expect(r).toMatchObject({ status: "unknown", txHash: HASH });
    expect(r.error).toMatch(/Too many/);
    expect(mocks.confirmTx).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the session lookup",
      () => mocks.getSession.mockRejectedValue(new Error("cookie store down")),
    ],
    ["the rate limiter", () => mocks.rateLimitOr429.mockRejectedValue(new Error("db down"))],
    [
      "the database client",
      () =>
        mocks.serviceDb.mockImplementation(() => {
          throw new Error("no env");
        }),
    ],
    ["the confirmation", () => mocks.confirmTx.mockRejectedValue(new Error("boom"))],
  ])(
    "%s throwing comes back as unknown, never as an exception or a success",
    async (_name, arrange) => {
      arrange();
      const r = await confirmTxAction(HASH, "owner.near", "freeze", "v.near");
      expect(r).toMatchObject({ status: "unknown", txHash: HASH });
      expect(r.error).toMatch(/confirm on the explorer/);
    },
  );

  it("a hash that is not one is not echoed back", async () => {
    mocks.getSession.mockResolvedValue(null);
    const r = await confirmTxAction("<script>", "owner.near", "freeze", "v.near");
    expect(r.txHash).toBeNull();
  });
});
