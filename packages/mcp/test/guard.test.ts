import type { ModelProposal } from "@probarion/core";
import { describe, expect, it } from "vitest";
import {
  type AnchorLite,
  assertSingleWriter,
  LedgerForkError,
  singleWriterProblem,
  withSingleWriterGuard,
} from "../src/guard.js";
import { fakePort } from "./helpers.js";
import { LEDGER, OTHER } from "./keys-helpers.js";

const latest = (a: AnchorLite | null) => async () => a;
/** Entries with these links, signed by `signer` (by default this server's ledger key). */
const entriesOf = (links: string[], signer = LEDGER.publicKey) =>
  links.map((link) => ({ link, signer }));
const ledger = (links: string[], signer = LEDGER.publicKey) => ({
  all: async () => entriesOf(links, signer),
});

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

  it("refuses entries after the last anchor that another ledger key signed (a keys file swapped)", async () => {
    // Anchored entries 0 and 1 by the old key, and three more by it after the anchor: the keys file was swapped.
    const swapped = entriesOf(["l0", "l1", "l2", "l3", "l4"], OTHER.publicKey);
    const anchor = { seq: 1, root: "l1", count: 2 };
    const problem = singleWriterProblem(swapped, anchor, LEDGER.publicKey);
    expect(problem).toBeInstanceOf(LedgerForkError);
    expect(problem?.code).toBe("LEDGER_KEY_MISMATCH");
    expect(problem?.message).toMatch(
      /^LEDGER_KEY_MISMATCH: 3 of the 3 unanchored entries in the local ledger \(after anchor 1\) are signed by another ledger key than this server's/,
    );
    expect(problem?.message).toContain(`entry 2 by ${OTHER.publicKey}`);
    expect(problem?.message).toContain("verify check a would fail for them");
    expect(problem?.message).toContain("Nothing was sent.");
    await expect(
      assertSingleWriter({ all: async () => swapped }, latest(anchor), LEDGER.publicKey),
    ).rejects.toThrow(/LEDGER_KEY_MISMATCH/);
    // The anchored part may be another key's: only the tail after the anchor must be this server's.
    const rotated = [...entriesOf(["l0", "l1"], OTHER.publicKey), ...entriesOf(["l2"])];
    expect(singleWriterProblem(rotated, anchor, LEDGER.publicKey)).toBeNull();
    // With no anchor, every entry is the tail.
    const noAnchor = singleWriterProblem(
      entriesOf(["l0"], OTHER.publicKey),
      null,
      LEDGER.publicKey,
    );
    expect(noAnchor?.message).toContain("(the vault has no anchor yet)");
    // With no ledger key (read-only), the signers are not compared, as before.
    expect(singleWriterProblem(swapped, anchor, null)).toBeNull();
    await expect(
      assertSingleWriter({ all: async () => swapped }, latest(anchor)),
    ).resolves.toBeUndefined();
  });

  it("names a signer that is not a public key without echoing it", () => {
    const secretLike = `ed25519:${"3".repeat(87)}`;
    const problem = singleWriterProblem(
      [{ link: "l0", signer: secretLike }],
      null,
      LEDGER.publicKey,
    );
    expect(problem?.message).toContain("entry 0 by a value that is not a public key");
    expect(problem?.message).not.toContain("3333");
  });

  it("the fork check comes first: a ledger the vault did not anchor is LEDGER_FORK_RISK", () => {
    const problem = singleWriterProblem(
      entriesOf(["l0"], OTHER.publicKey),
      { seq: 1, root: "x", count: 2 },
      LEDGER.publicKey,
    );
    expect(problem?.code).toBe("LEDGER_FORK_RISK");
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

  it("the guarded port with a ledger key refuses a tail another key signed, before the real port", async () => {
    const port = fakePort();
    const guarded = withSingleWriterGuard(
      port,
      ledger(["l0", "l1"], OTHER.publicKey),
      latest(null),
      LEDGER.publicKey,
    );
    await expect(
      guarded.requestSpend({
        mandateId: 1,
        amount: "1",
        invoiceHash: "a".repeat(64),
        ref: "r",
        proposal: {
          action: "pay",
          mandate_id: 1,
          amount: "1",
          payee_hint: null,
          reasoning: "mcp: x",
          confidence: 1,
        },
      }),
    ).rejects.toThrow(/LEDGER_KEY_MISMATCH: 2 of the 2 unanchored entries/);
    expect(port.requestSpend).not.toHaveBeenCalled();
  });
});
