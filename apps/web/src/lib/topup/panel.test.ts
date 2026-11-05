import { describe, expect, it } from "vitest";
import type { WalletTx } from "@/lib/near/tx";
import type { VerifiedQuote } from "./oneclick";
import {
  blockOf,
  FINAL_STATUS,
  initialPanel,
  onDepositResult,
  type PanelEvent,
  type PanelState,
  panelReducer,
  type Quoted,
} from "./panel";

const now = Date.parse("2026-11-08T10:00:00Z");
const A = "aa".repeat(32);
const B = "bb".repeat(32);
const HASH = "3DFV2thBU9V4b5w7kM691poLJ8SWiCqp46LKBn1Fy9cX";

const quoteFor = (depositAddress: string, deadline = "2026-11-08T10:30:00.000Z"): Quoted => ({
  quote: { depositAddress, deadline } as VerifiedQuote,
  tx: { receiverId: "usdc.near", actions: [], summary: "s" } satisfies WalletTx,
  asked: "20",
});
const run = (events: PanelEvent[], from: PanelState = initialPanel) =>
  events.reduce(panelReducer, from);
const ok = { status: "ok", txHash: HASH } as const;
const failed = { status: "failed", txHash: HASH } as const;
const unknownWithHash = { status: "unknown", txHash: HASH } as const;
const unknownNoHash = { status: "unknown", txHash: null } as const;

describe("what a wallet result does to the panel", () => {
  it("ok: the deposit is sent, 1Click is told its hash, and its status is read", () => {
    expect(onDepositResult(ok)).toEqual({ used: true, poll: true, submit: true });
  });

  it("unknown with a hash: it may have gone out, so its status is read, 1Click is not told, and the quote is used", () => {
    expect(onDepositResult(unknownWithHash)).toEqual({ used: true, poll: true, submit: false });
  });

  it("unknown without a hash (a closed wallet): its status is read to see whether 1Click saw a deposit, and nothing is told", () => {
    expect(onDepositResult(unknownNoHash)).toEqual({ used: false, poll: true, submit: false });
  });

  it("failed: nothing is read or told, and the quote is not used up", () => {
    expect(onDepositResult(failed)).toEqual({ used: false, poll: false, submit: false });
    expect(onDepositResult({ status: "failed", txHash: null })).toEqual({
      used: false,
      poll: false,
      submit: false,
    });
  });

  it("never tells 1Click a transaction hash it does not have", () => {
    expect(onDepositResult({ status: "ok", txHash: null }).submit).toBe(false);
  });
});

describe("the panel's state", () => {
  const withQuote = run([{ type: "quote_received", quoted: quoteFor(A) }]);

  it("starts with nothing quoted, nothing used, nothing signing, nothing watched", () => {
    expect(initialPanel).toEqual({ quoted: null, used: false, signing: false, watching: null });
  });

  it("clears the old quote when a new one is asked for, so a failed request leaves nothing to sign", () => {
    const s = run([{ type: "quote_requested" }], withQuote);
    expect(s.quoted).toBeNull();
    expect(s.used).toBe(false);
    expect(blockOf(s, "20", now)).toBeNull();
  });

  it("does not replace, or clear, the quote the wallet is open for", () => {
    const signing = run([{ type: "signing", busy: true }], withQuote);
    expect(run([{ type: "quote_requested" }], signing)).toBe(signing);
    expect(run([{ type: "quote_received", quoted: quoteFor(B) }], signing)).toBe(signing);
    const done = run([{ type: "signing", busy: false }], signing);
    expect(
      run([{ type: "quote_received", quoted: quoteFor(B) }], done).quoted?.quote.depositAddress,
    ).toBe(B);
  });

  it("ok: used, watched, and not offered again", () => {
    const s = run([{ type: "result", address: A, result: ok }], withQuote);
    expect(s.used).toBe(true);
    expect(s.watching).toEqual({ address: A, status: null, gaveUp: false, run: 1 });
    expect(blockOf(s, "20", now)).toBe("sent");
  });

  it("unknown with a hash: used, watched, and not offered again", () => {
    const s = run([{ type: "result", address: A, result: unknownWithHash }], withQuote);
    expect(s.used).toBe(true);
    expect(s.watching?.address).toBe(A);
    expect(blockOf(s, "20", now)).toBe("sent");
  });

  it("unknown without a hash: watched, and offered again only while 1Click still waits for a deposit and every guard holds", () => {
    let s = run([{ type: "result", address: A, result: unknownNoHash }], withQuote);
    expect(s.used).toBe(false);
    expect(blockOf(s, "20", now)).toBeNull();
    s = run([{ type: "status", address: A, status: "PENDING_DEPOSIT" }], s);
    expect(blockOf(s, "20", now)).toBeNull();
    expect(blockOf(s, "21", now)).toBe("changed");
    expect(blockOf(s, "20", Date.parse("2026-11-08T11:00:00Z"))).toBe("expired");
    s = run([{ type: "status", address: A, status: "PROCESSING" }], s);
    expect(blockOf(s, "20", now)).toBe("processing");
  });

  it("failed: nothing is watched, and every guard still applies to the same quote", () => {
    const s = run([{ type: "result", address: A, result: failed }], withQuote);
    expect(s.used).toBe(false);
    expect(s.watching).toBeNull();
    expect(blockOf(s, "20", now)).toBeNull(); // fresh and unchanged: it may be signed again
    expect(blockOf(s, "99", now)).toBe("changed");
    expect(blockOf(s, "20", Date.parse("2026-11-08T10:30:00Z"))).toBe("expired");
    expect(blockOf(s, "20", Date.parse("2026-11-08T12:00:00Z"))).toBe("expired");
  });

  it("ignores a result, a status or a give-up for an address that is not the quote on screen, or the one watched", () => {
    expect(run([{ type: "result", address: B, result: ok }], withQuote)).toBe(withQuote);
    const watched = run([{ type: "result", address: A, result: ok }], withQuote);
    expect(run([{ type: "status", address: B, status: "SUCCESS" }], watched)).toBe(watched);
    expect(run([{ type: "gave_up", address: B }], watched)).toBe(watched);
  });

  it("keeps the status read for an earlier address out of a later quote's guard", () => {
    let s = run(
      [
        { type: "result", address: A, result: ok },
        { type: "status", address: A, status: "SUCCESS" },
      ],
      withQuote,
    );
    s = run(
      [
        { type: "signing", busy: false },
        { type: "quote_received", quoted: quoteFor(B) },
      ],
      s,
    );
    expect(s.watching?.address).toBe(A);
    expect(blockOf(s, "20", now)).toBeNull(); // B is fresh, unused, and A's SUCCESS is not B's
  });

  it("records a status and a give-up for the address being watched", () => {
    let s = run([{ type: "result", address: A, result: ok }], withQuote);
    s = run([{ type: "status", address: A, status: "PROCESSING" }], s);
    expect(s.watching).toEqual({ address: A, status: "PROCESSING", gaveUp: false, run: 1 });
    s = run([{ type: "gave_up", address: A }], s);
    expect(s.watching).toEqual({ address: A, status: "PROCESSING", gaveUp: true, run: 1 });
  });

  it("restarts the reading when a second attempt for the same address starts it again", () => {
    let s = run(
      [
        { type: "result", address: A, result: unknownNoHash },
        { type: "status", address: A, status: "PENDING_DEPOSIT" },
        { type: "gave_up", address: A },
      ],
      withQuote,
    );
    expect(s.watching).toEqual({ address: A, status: "PENDING_DEPOSIT", gaveUp: true, run: 1 });
    s = run([{ type: "result", address: A, result: unknownNoHash }], s);
    expect(s.watching).toEqual({ address: A, status: null, gaveUp: false, run: 2 });
  });

  it("knows which statuses are final", () => {
    expect([...FINAL_STATUS].sort()).toEqual(["FAILED", "REFUNDED", "SUCCESS"]);
  });

  it("tracks whether the wallet is open", () => {
    expect(run([{ type: "signing", busy: true }]).signing).toBe(true);
    expect(
      run([
        { type: "signing", busy: true },
        { type: "signing", busy: false },
      ]).signing,
    ).toBe(false);
  });
});
