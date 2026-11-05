import { describe, expect, it } from "vitest";
import { BLOCK_TEXT, MIN_LEFT_MS, quoteBlock } from "./block";

const now = Date.parse("2026-11-08T10:00:00Z");
const base = {
  deadline: "2026-11-08T10:30:00.000Z",
  asked: "20",
  amount: "20",
  now,
  attempted: false,
  sent: false,
};
const block = (o: Partial<typeof base> = {}) => quoteBlock({ ...base, ...o });

describe("when a quote is not offered for signing", () => {
  it("offers a fresh quote for the amount that was asked for", () => {
    expect(block()).toBeNull();
    expect(block({ amount: " 20 " })).toBeNull();
  });

  it("stops offering it when under a minute is left, to the millisecond", () => {
    const at = (left: number) => new Date(now + left).toISOString();
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

  it("never switches the button off under a signature that was started, unless the deposit is done", () => {
    expect(block({ attempted: true, deadline: "2026-11-08T09:00:00Z", amount: "99" })).toBeNull();
    expect(block({ attempted: true, sent: true })).toBe("sent");
  });

  it("does not offer a deposit that went through to be signed a second time", () => {
    expect(block({ sent: true })).toBe("sent");
    expect(block({ sent: true, attempted: false })).toBe("sent");
  });

  it("has a sentence for each reason", () => {
    expect(BLOCK_TEXT).toEqual({
      sent: "This deposit was sent. To top up again, get a new quote.",
      expired:
        "This quote has expired or is about to, so it is not offered for signing. Get a new quote.",
      changed: "The amount changed after this quote. Get a new quote for the new amount.",
    });
  });
});
