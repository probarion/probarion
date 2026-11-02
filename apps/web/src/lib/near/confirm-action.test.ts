import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  serviceDb: vi.fn(() => ({ db: true })),
  rateLimitOr429: vi.fn(),
  confirmTx: vi.fn(),
  currentFinalHeight: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db/clients", () => ({ serviceDb: mocks.serviceDb }));
vi.mock("@/lib/http", () => ({ rateLimitOr429: mocks.rateLimitOr429 }));
vi.mock("./confirm", () => ({
  confirmTx: mocks.confirmTx,
  currentFinalHeight: mocks.currentFinalHeight,
}));

import { confirmTxAction, sendBaselineAction } from "./confirm-action";
import type { ConfirmRequest } from "./outcome";
import { freezeTx, toPrepared } from "./tx";

const HASH = "9fV2pZ7mUq5f6p3rGq7bX1tYkqfUu1Vb3bWm2C5g7h8J";
const VAULT = "acme.vaults.probarion.near";
const OK = { status: "ok", txHash: HASH, code: null, error: null };
const request = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  hash: HASH,
  signerId: "owner.near",
  tx: toPrepared(freezeTx(VAULT)),
  baselineHeight: 100,
  ...over,
});

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.serviceDb.mockReturnValue({ db: true });
  mocks.getSession.mockResolvedValue({ accountId: "owner.near", exp: Date.now() + 1000 });
  mocks.rateLimitOr429.mockResolvedValue(null);
  mocks.confirmTx.mockResolvedValue(OK);
  mocks.currentFinalHeight.mockResolvedValue(4242);
});

describe("confirmTxAction", () => {
  it("a signed-in owner gets the chain's answer, for exactly the request that was made", async () => {
    const r = await confirmTxAction(request());
    expect(r).toEqual(OK);
    expect(mocks.confirmTx).toHaveBeenCalledWith(request());
  });

  it("applies a per-account cap (30 a minute) and a global cap on top (300 a minute)", async () => {
    await confirmTxAction(request());
    expect(mocks.rateLimitOr429.mock.calls).toEqual([
      [{ db: true }, "confirm:owner.near", [30, 60]],
      [{ db: true }, "confirm:all", [300, 60]],
    ]);
  });

  it("only the signed-in account's own transaction can be confirmed", async () => {
    const r = await confirmTxAction(request({ signerId: "someone-else.near" }));
    expect(r).toMatchObject({ status: "unknown", txHash: HASH });
    expect(r.error).toMatch(/signed in as owner\.near/);
    expect(mocks.confirmTx).not.toHaveBeenCalled();
  });

  it("no session: unknown, and the network is not asked", async () => {
    mocks.getSession.mockResolvedValue(null);
    const r = await confirmTxAction(request());
    expect(r).toMatchObject({ status: "unknown", txHash: HASH });
    expect(r.error).toMatch(/Sign in again/);
    expect(mocks.confirmTx).not.toHaveBeenCalled();
    expect(mocks.rateLimitOr429).not.toHaveBeenCalled();
  });

  it("over the per-account cap: unknown, and the network is not asked", async () => {
    mocks.rateLimitOr429.mockResolvedValueOnce(new Response(null, { status: 429 }));
    const r = await confirmTxAction(request());
    expect(r).toMatchObject({ status: "unknown", txHash: HASH });
    expect(r.error).toMatch(/Too many/);
    expect(mocks.confirmTx).not.toHaveBeenCalled();
  });

  it("over the global cap (all accounts together): unknown, and the network is not asked", async () => {
    mocks.rateLimitOr429
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Response(null, { status: 429 }));
    const r = await confirmTxAction(request());
    expect(r).toMatchObject({ status: "unknown", txHash: HASH });
    expect(r.error).toMatch(/busy/);
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
      const r = await confirmTxAction(request());
      expect(r).toMatchObject({ status: "unknown", txHash: HASH });
      expect(r.error).toMatch(/confirm on the explorer/);
    },
  );

  it("a hash that is not one is not echoed back", async () => {
    mocks.getSession.mockResolvedValue(null);
    const r = await confirmTxAction(request({ hash: "<script>" }));
    expect(r.txHash).toBeNull();
  });

  it("a request that is not an object never throws", async () => {
    for (const junk of [null, undefined, "x", 5, []]) {
      const r = await confirmTxAction(junk as unknown as ConfirmRequest);
      expect(r.status, String(junk)).toBe("unknown");
    }
  });
});

describe("sendBaselineAction", () => {
  it("returns the final block height to a signed-in account", async () => {
    expect(await sendBaselineAction()).toBe(4242);
  });

  it("shares the rate caps with the confirmation", async () => {
    await sendBaselineAction();
    expect(mocks.rateLimitOr429.mock.calls).toEqual([
      [{ db: true }, "confirm:owner.near", [30, 60]],
      [{ db: true }, "confirm:all", [300, 60]],
    ]);
  });

  it("is null without a session, over a cap, or when the network cannot say (the send then cannot end as done)", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect(await sendBaselineAction()).toBeNull();
    mocks.rateLimitOr429.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect(await sendBaselineAction()).toBeNull();
    mocks.currentFinalHeight.mockResolvedValueOnce(null);
    expect(await sendBaselineAction()).toBeNull();
    expect(mocks.currentFinalHeight).toHaveBeenCalledTimes(1);
  });

  it("never throws", async () => {
    mocks.getSession.mockRejectedValue(new Error("down"));
    expect(await sendBaselineAction()).toBeNull();
    mocks.getSession.mockResolvedValue({ accountId: "owner.near" });
    mocks.currentFinalHeight.mockRejectedValue(new Error("down"));
    expect(await sendBaselineAction()).toBeNull();
  });
});
