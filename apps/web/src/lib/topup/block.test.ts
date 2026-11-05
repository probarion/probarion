import { describe, expect, it } from "vitest";
import { BLOCK_TEXT, MIN_LEFT_MS, NO_DEPOSIT_YET, quoteBlock } from "./block";

const now = Date.parse("2026-11-08T10:00:00Z");
const base = {
  deadline: "2026-11-08T10:30:00.000Z",
  asked: "20",
  amount: "20",
  now,
  used: false,
  depositStatus: null as string | null,
};
const block = (o: Partial<typeof base> = {}) => quoteBlock({ ...base, ...o });
const at = (left: number) => new Date(now + left).toISOString();

describe("when a quote is not offered for signing", () => {
  it("offers a fresh quote for the amount that was asked for", () => {
    expect(block()).toBeNull();
    expect(block({ amount: " 20 " })).toBeNull();
  });

  it("stops offering it when under a minute is left, to the millisecond", () => {
    expect(MIN_LEFT_MS).toBe(60_000);
    expect(block({ deadline: at(MIN_LEFT_MS) })).toBeNull();
    expect(block({ deadline: at(MIN_LEFT_MS - 1) })).toBe("expired");
    expect(block({ deadline: at(-1) })).toBe("expired");
  });

  it("treats a deadline that is not a date as expired", () => {
    expect(block({ deadline: "" })).toBe("expired");
    expect(block({ deadline: "soon" })).toBe("expired");
  });

  it("stops offering it when the amount no longer matches the quote", () => {
    expect(block({ amount: "21" })).toBe("changed");
    expect(block({ amount: "" })).toBe("changed");
    expect(block({ amount: "20.0" })).toBe("changed");
  });

  it("never offers a quote again once a deposit for it was sent, or may have been", () => {
    expect(block({ used: true })).toBe("sent");
    expect(block({ used: true, deadline: at(-1), amount: "99" })).toBe("sent");
  });

  it("stops offering it once 1Click no longer reports its address as waiting for a deposit", () => {
    expect(NO_DEPOSIT_YET).toBe("PENDING_DEPOSIT");
    expect(block({ depositStatus: "PENDING_DEPOSIT" })).toBeNull();
    for (const depositStatus of [
      "KNOWN_DEPOSIT_TX",
      "INCOMPLETE_DEPOSIT",
      "PROCESSING",
      "SUCCESS",
      "REFUNDED",
      "FAILED",
      "SOMETHING_NEW",
    ]) {
      expect(block({ depositStatus }), depositStatus).toBe("processing");
    }
  });

  // The defect this replaces: a wallet result of any kind used to switch these guards off for good.
  it("keeps expiry and a changed amount in force after a failed or unconfirmed attempt, which sets nothing here", () => {
    // A failed result leaves `used` false and no status: only the guards decide.
    expect(block({ deadline: at(-60 * 60_000) })).toBe("expired");
    expect(block({ amount: "99" })).toBe("changed");
    expect(block({ deadline: at(-60 * 60_000), amount: "99" })).toBe("expired");
    // The same quote, still fresh and unchanged, can be signed again after a failure.
    expect(block()).toBeNull();
  });

  it("names the most useful reason first: sent, then processing, then expired, then changed", () => {
    expect(block({ used: true, depositStatus: "PROCESSING", deadline: at(-1), amount: "1" })).toBe(
      "sent",
    );
    expect(block({ depositStatus: "PROCESSING", deadline: at(-1), amount: "1" })).toBe(
      "processing",
    );
    expect(block({ deadline: at(-1), amount: "1" })).toBe("expired");
  });

  it("has a sentence for each reason", () => {
    expect(BLOCK_TEXT).toEqual({
      sent: "A deposit for this quote was sent, or may have been. To top up again, get a new quote.",
      processing:
        "1Click no longer reports this deposit address as waiting for a deposit, so the quote is not offered for signing again.",
      expired:
        "This quote has expired or is about to, so it is not offered for signing. Get a new quote.",
      changed: "The amount changed after this quote. Get a new quote for the new amount.",
    });
  });
});
