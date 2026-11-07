import { describe, expect, it } from "vitest";
import type { LedgerRow } from "@/lib/ledger/store";
import type { AccessKeyState } from "@/lib/near/reader";
import { ALLOWANCE_LOW_ALERT_YOCTO, NEAR_LOW_ALERT_YOCTO } from "@/lib/near/runway";
import { anchor, HELD_UNTIL_NS, mandateView, spend } from "../../../test/fixtures/spends";
import {
  allowanceEvent,
  anchorEvents,
  mandateEvents,
  nearLowEvent,
  refusalEvents,
  spendEvents,
  watchHealthy,
  watchStarved,
} from "./watch";

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-11T10:00:00Z");

describe("spendEvents", () => {
  it("makes one event per spend, keyed by id and status, of the kind spend_<status>", () => {
    const r = spendEvents(T, [spend(4, "held"), spend(5, "paid", { amount: "7" })], 3, NOW);
    expect(r.events.map((e) => [e.event_key, e.kind, e.spend_id])).toEqual([
      ["spend:4:held", "spend_held", 4],
      ["spend:5:paid", "spend_paid", 5],
    ]);
    expect(r.events[1]).toMatchObject({ tenant_id: T, mandate_id: 1, amount: "7" });
  });

  it("keeps ids and cursors apart: the event key has the id, the cursor a position", () => {
    // ids start at 1 and positions at 0: the first spend (id 1) sits at position 0.
    expect(spendEvents(T, [spend(1, "paid")], 0, NOW).next).toBe(1);
    expect(spendEvents(T, [spend(41, "paid"), spend(42, "paid")], 40, NOW).next).toBe(42);
  });

  it("moves the cursor to the first spend that is not final, or past them all", () => {
    const final = ["paid", "burned", "failed", "rejected", "expired"] as const;
    const open = ["held", "pending"] as const;
    for (const s of final) expect(spendEvents(T, [spend(1, s)], 0, NOW).next, s).toBe(1);
    for (const s of open) expect(spendEvents(T, [spend(1, s)], 0, NOW).next, s).toBe(0);
    expect(
      spendEvents(T, [spend(1, "paid"), spend(2, "pending"), spend(3, "paid")], 10, NOW).next,
    ).toBe(11);
    expect(spendEvents(T, [], 7, NOW)).toEqual({ events: [], next: 7 });
  });

  describe("a hold whose window has passed", () => {
    // approve fails with HoldExpired once the block time is past held_until_ns, so no payment can follow such a hold:
    // after a margin for clock skew and an approve in flight, the cursor passes it.
    const NOW_NS = BigInt(NOW.getTime()) * 1_000_000n;
    const MARGIN_NS = 600_000_000_000n; // 10 minutes
    /** A held spend whose window ended `agoNs` before NOW (negative: it ends that long after). */
    const held = (agoNs: bigint, id = 1) =>
      spend(id, "held", { held_until_ns: (NOW_NS - agoNs).toString() });
    const next = (spends: ReturnType<typeof spend>[]) => spendEvents(T, spends, 0, NOW).next;

    it("pins the cursor inside its window and inside the 10-minute margin, up to the margin itself", () => {
      expect(next([held(-3_600_000_000_000n)])).toBe(0); // an hour left
      expect(next([held(-1n)])).toBe(0); // one nanosecond left
      expect(next([held(0n)])).toBe(0); // ends right now
      expect(next([held(MARGIN_NS - 1n)])).toBe(0); // ended just under 10 minutes ago
      expect(next([held(MARGIN_NS)])).toBe(0); // exactly 10 minutes: not more than 10
    });

    it("lets the cursor pass once the window ended more than 10 minutes ago", () => {
      expect(next([held(MARGIN_NS + 1n)])).toBe(1);
      expect(next([held(3n * 86_400_000_000_000n)])).toBe(1); // three days ago
      // ...and stops at the first spend that is still open after it.
      expect(next([held(MARGIN_NS + 1n, 1), spend(2, "paid"), held(0n, 3), spend(4, "paid")])).toBe(
        2,
      );
    });

    it("emits no event for a state the chain has not reached: the spends read are the events", () => {
      const r = spendEvents(T, [held(MARGIN_NS + 1n)], 0, NOW);
      expect(r.events.map((e) => e.event_key)).toEqual(["spend:1:held"]);
    });

    it("treats a hold with no end, or one that is not a number, as inside its window", () => {
      expect(next([spend(1, "held", { held_until_ns: null })])).toBe(0);
      expect(next([spend(1, "held", { held_until_ns: "soon" })])).toBe(0);
      expect(next([spend(1, "held", { held_until_ns: "" })])).toBe(0);
      expect(next([spend(1, "held", { held_until_ns: "-5" })])).toBe(0);
    });

    it("never lets a pending spend pass, however old its hold was", () => {
      expect(next([spend(1, "pending", { held_until_ns: "1" })])).toBe(0);
    });
  });

  it("carries what an alert needs, and nothing it can leave out", () => {
    const [e] = spendEvents(T, [spend(1, "held", { memo: "m", ref: "r" })], 0, NOW).events;
    expect(e?.payload).toEqual({
      destination: { type: "near", account_id: "designer.near" },
      ref: "r",
      held_until_ns: HELD_UNTIL_NS,
      memo: "m",
    });
  });
});

describe("anchorEvents and mandateEvents", () => {
  it("key an anchor by its seq and a mandate by its id, and move by what they read", () => {
    const a = anchorEvents(T, [anchor(1), anchor(2)], 0);
    expect(a.events.map((e) => [e.event_key, e.kind, e.anchor_seq])).toEqual([
      ["anchor:1", "anchor", 1],
      ["anchor:2", "anchor", 2],
    ]);
    expect(a.next).toBe(2);
    expect(anchorEvents(T, [], 9)).toEqual({ events: [], next: 9 });

    const m = mandateEvents(T, [mandateView(1), mandateView(2)], 5);
    expect(m.events.map((e) => [e.event_key, e.kind, e.mandate_id])).toEqual([
      ["mandate:1", "mandate_created", 1],
      ["mandate:2", "mandate_created", 2],
    ]);
    expect(m.next).toBe(7);
  });
});

describe("refusalEvents", () => {
  const row = (seq: number, over: Record<string, unknown> = {}, kind = "payment"): LedgerRow =>
    ({
      seq,
      kind,
      body: {
        kind,
        request_id: `req-${seq}`,
        mandate_id: 1,
        amount: "9",
        contract: { code: "NoMandate", tx_hash: "TX", spend_id: null, status: "refused", ...over },
      },
    }) as unknown as LedgerRow;

  it("takes a payment entry that the contract refused and that has a transaction, and nothing else", () => {
    const rows = [
      row(0),
      row(1, { status: "failed" }),
      row(2, { status: "unknown" }),
      row(3, { tx_hash: null }),
      row(4, { tx_hash: "" }),
      row(5, {}, "decision"),
      row(6, { status: null }),
      row(7, { code: null }), // refused, with a transaction, and no code: still a refusal
    ];
    const r = refusalEvents(T, rows, 0);
    expect(r.events.map((e) => e.event_key)).toEqual(["refused:0", "refused:7"]);
    expect(r.events[0]).toMatchObject({
      kind: "refused_by_contract",
      code: "NoMandate",
      tx_hash: "TX",
      mandate_id: 1,
      amount: "9",
      payload: { request_id: "req-0" },
    });
    expect(r.next).toBe(8);
  });

  it("copes with an entry that has no contract part", () => {
    const bare = {
      seq: 3,
      kind: "payment",
      body: { kind: "payment", contract: null },
    } as LedgerRow;
    expect(refusalEvents(T, [bare], 3)).toEqual({ events: [], next: 4 });
    expect(refusalEvents(T, [], 3)).toEqual({ events: [], next: 3 });
  });
});

describe("allowanceEvent", () => {
  const key = { public_key: "ed25519:K", purpose: "ledger" };
  const state = (allowance: string | null, exists = true): AccessKeyState => ({
    exists,
    kind: exists ? "FunctionCall" : null,
    fullAccess: false,
    allowance,
    receiverId: exists ? "v.near" : null,
    methodNames: [],
  });

  it("is an event below 0.2 NEAR, keyed by key and UTC day, and none at or above it", () => {
    const low = allowanceEvent(T, key, state((ALLOWANCE_LOW_ALERT_YOCTO - 1n).toString()), NOW);
    expect(low).toEqual({
      tenant_id: T,
      event_key: "allowance_low:ed25519:K:2026-11-11",
      kind: "allowance_low",
      payload: {
        public_key: "ed25519:K",
        purpose: "ledger",
        allowance: (ALLOWANCE_LOW_ALERT_YOCTO - 1n).toString(),
      },
    });
    expect(allowanceEvent(T, key, state(ALLOWANCE_LOW_ALERT_YOCTO.toString()), NOW)).toBeNull();
    expect(allowanceEvent(T, key, state("0"), NOW)?.kind).toBe("allowance_low");
  });

  it("is none for an unlimited key and for a key that is not on the chain", () => {
    expect(allowanceEvent(T, key, state(null), NOW)).toBeNull();
    expect(allowanceEvent(T, key, state("1", false), NOW)).toBeNull();
  });

  it("takes the day from the UTC clock", () => {
    const late = new Date("2026-11-11T23:59:59.999Z");
    expect(allowanceEvent(T, key, state("1"), late)?.event_key).toBe(
      "allowance_low:ed25519:K:2026-11-11",
    );
    expect(allowanceEvent(T, key, state("1"), new Date("2026-11-12T00:00:00Z"))?.event_key).toBe(
      "allowance_low:ed25519:K:2026-11-12",
    );
  });
});

describe("nearLowEvent", () => {
  it("is an event once the free NEAR is below 0.05 NEAR, keyed by UTC day, with the free NEAR as payload", () => {
    // 1,000 bytes of storage hold 0.01 NEAR.
    const stake = 10n ** 22n;
    const account = (free: bigint) => ({ amount: (free + stake).toString(), storage_usage: 1000 });
    expect(nearLowEvent(T, account(NEAR_LOW_ALERT_YOCTO - 1n), NOW)).toEqual({
      tenant_id: T,
      event_key: "near_low:2026-11-11",
      kind: "near_low",
      payload: { free_yocto: (NEAR_LOW_ALERT_YOCTO - 1n).toString() },
    });
    expect(nearLowEvent(T, account(NEAR_LOW_ALERT_YOCTO), NOW)).toBeNull();
    expect(nearLowEvent(T, { amount: "1", storage_usage: 1000 }, NOW)?.payload).toEqual({
      free_yocto: "0",
    });
  });
});

describe("watchHealthy", () => {
  it("is healthy with no tenants, and while at least one tenant that was tried did not fail", () => {
    const r = (tenants: number, errors: number, skipped = 0, checkErrors = 0) => ({
      tenants,
      inserted: 0,
      errors,
      skipped,
      checkErrors,
    });
    expect(watchHealthy(r(0, 0))).toBe(true);
    expect(watchHealthy(r(3, 0))).toBe(true);
    expect(watchHealthy(r(3, 2))).toBe(true);
    expect(watchHealthy(r(3, 3))).toBe(false);
    expect(watchHealthy(r(1, 1))).toBe(false);
    // Tenants the budget left for the next run are not successes: of the one that was tried, none worked.
    expect(watchHealthy(r(3, 1, 2))).toBe(false);
    expect(watchHealthy(r(3, 1, 1))).toBe(true);
    // A run that was given no time at all tried nothing: it is not healthy either (a starved network, W-NET-R4).
    expect(watchHealthy(r(3, 0, 3))).toBe(false);
    expect(watchHealthy(r(1, 0, 1))).toBe(false);
    expect(watchHealthy(r(0, 0, 0))).toBe(true);
  });

  it("calls a run starved when it has tenants and skipped every one of them, and no other", () => {
    const r = (tenants: number, errors: number, skipped: number) => ({
      tenants,
      inserted: 0,
      errors,
      skipped,
      checkErrors: 0,
    });
    expect(watchStarved(r(4, 0, 4))).toBe(true);
    expect(watchStarved(r(1, 0, 1))).toBe(true);
    expect(watchStarved(r(0, 0, 0))).toBe(false); // no tenants: nothing was left undone
    expect(watchStarved(r(4, 0, 3))).toBe(false); // one was watched
    expect(watchStarved(r(4, 4, 0))).toBe(false); // all tried and all failed: unhealthy, but not starved
    expect(watchStarved(r(3, 0, 0))).toBe(false);
  });

  it("does not count failed checks: they are warnings, and the heartbeat is about the chain being reached", () => {
    const r = (tenants: number, errors: number, checkErrors: number) => ({
      tenants,
      inserted: 0,
      errors,
      skipped: 0,
      checkErrors,
    });
    expect(watchHealthy(r(3, 0, 9))).toBe(true);
    expect(watchHealthy(r(3, 3, 0))).toBe(false);
    expect(watchHealthy(r(3, 3, 9))).toBe(false);
  });
});
