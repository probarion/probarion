import type { ModelProposal } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { type AnchorLite, assertSingleWriter, withSingleWriterGuard } from "../src/guard.js";
import { fakePort } from "./helpers.js";

const latest = (a: AnchorLite | null) => async () => a;
const ledger = (links: string[]) => ({ all: async () => links.map((link) => ({ link })) });

describe("one ledger per vault", () => {
  it("allows a spend when the latest anchor matches the local ledger", async () => {
    await expect(
      assertSingleWriter(ledger(["l0", "l1", "l2"]), latest({ seq: 2, root: "l2", count: 3 })),
    ).resolves.toBeUndefined();
  });

  it("allows a spend when the local ledger is ahead of the last anchor", async () => {
    await expect(
      assertSingleWriter(ledger(["l0", "l1", "l2"]), latest({ seq: 1, root: "l0", count: 1 })),
    ).resolves.toBeUndefined();
  });

  it("allows a fresh vault with no anchors", async () => {
    await expect(assertSingleWriter(ledger([]), latest(null))).resolves.toBeUndefined();
  });

  it("refuses when the chain has anchored more entries than this machine holds", async () => {
    await expect(
      assertSingleWriter(ledger(["l0"]), latest({ seq: 1, root: "x9", count: 4 })),
    ).rejects.toThrow(/LEDGER_FORK_RISK: anchor 1 covers 4 entries but the local ledger has 1/);
  });

  it("refuses when the anchored root differs from the local entry", async () => {
    await expect(
      assertSingleWriter(ledger(["l0", "l1"]), latest({ seq: 1, root: "other", count: 2 })),
    ).rejects.toThrow(/does not match local entry 1/);
  });

  it("the guarded port refuses before the real port is called, and passes reads through", async () => {
    const port = fakePort();
    const guarded = withSingleWriterGuard(
      port,
      ledger([]),
      latest({ seq: 1, root: "x", count: 1 }),
    );
    const proposal: ModelProposal = {
      action: "pay",
      mandate_id: 1,
      amount: "1",
      payee_hint: null,
      reasoning: "mcp: x",
      confidence: 1,
    };
    await expect(
      guarded.requestSpend({
        mandateId: 1,
        amount: "1",
        invoiceHash: "a".repeat(64),
        ref: "r",
        proposal,
      }),
    ).rejects.toThrow(/LEDGER_FORK_RISK/);
    expect(port.requestSpend).not.toHaveBeenCalled();
    await guarded.listMandates();
    await guarded.checkSpend({ mandateId: 1, amount: "1", invoiceHash: "a".repeat(64), ref: "r" });
    await guarded.getSpend(7);
    await guarded.verify();
    expect(port.listMandates).toHaveBeenCalledTimes(1);
    expect(port.checkSpend).toHaveBeenCalledTimes(1);
    expect(port.getSpend).toHaveBeenCalledWith(7);
    expect(port.verify).toHaveBeenCalledTimes(1);
  });
});
