import { describe, expect, it } from "vitest";
import type { LedgerRow } from "@/lib/ledger/store";
import type { AccessKeyState } from "@/lib/near/reader";
import { ALLOWANCE_LOW_ALERT_YOCTO, NEAR_LOW_ALERT_YOCTO } from "@/lib/near/runway";
import { anchor, mandateView, spend } from "../../../test/fixtures/spends";
import {
  allowanceEvent,
  anchorEvents,
  mandateEvents,
  nearLowEvent,
  refusalEvents,
  spendEvents,
  watchHealthy,
} from "./watch";

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-11T10:00:00Z");

describe("spendEvents", () => {
  it("makes one event per spend, keyed by id and status, of the kind spend_<status>", () => {
    const r = spendEvents(T, [spend(4, "held"), spend(5, "paid", { amount: "7" })], 3);
    expect(r.events.map((e) => [e.event_key, e.kind, e.spend_id])).toEqual([
      ["spend:4:held", "spend_held", 4],
      ["spend:5:paid", "spend_paid", 5],
    ]);
    expect(r.events[1]).toMatchObject({ tenant_id: T, mandate_id: 1, amount: "7" });
  });

  it("keeps ids and cursors apart: the event key has the id, the cursor a position", () => {
    // ids start at 1 and positions at 0: the first spend (id 1) sits at position 0.
    expect(spendEvents(T, [spend(1, "paid")], 0).next).toBe(1);
    expect(spendEvents(T, [spend(41, "paid"), spend(42, "paid")], 40).next).toBe(42);
  });

  it("moves the cursor to the first spend that is not final, or past them all", () => {
    const final = ["paid", "burned", "failed", "rejected", "expired"] as const;
    const open = ["held", "pending"] as const;
    for (const s of final) expect(spendEvents(T, [spend(1, s)], 0).next, s).toBe(1);
    for (const s of open) expect(spendEvents(T, [spend(1, s)], 0).next, s).toBe(0);
    expect(spendEvents(T, [spend(1, "paid"), spend(2, "pending"), spend(3, "paid")], 10).next).toBe(
      11,
    );
    expect(spendEvents(T, [], 7)).toEqual({ events: [], next: 7 });
  });

  it("carries what an alert needs, and nothing it can leave out", () => {
    const [e] = spendEvents(T, [spend(1, "held", { memo: "m", ref: "r" })], 0).events;
    expect(e?.payload).toEqual({
      destination: { type: "near", account_id: "designer.near" },
      ref: "r",
      held_until_ns: "999",
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
    const r = (tenants: number, errors: number, skipped = 0) => ({
      tenants,
      inserted: 0,
      errors,
      skipped,
    });
    expect(watchHealthy(r(0, 0))).toBe(true);
    expect(watchHealthy(r(3, 0))).toBe(true);
    expect(watchHealthy(r(3, 2))).toBe(true);
    expect(watchHealthy(r(3, 3))).toBe(false);
    expect(watchHealthy(r(1, 1))).toBe(false);
    // Tenants the budget left for the next run are not successes: of the one that was tried, none worked.
    expect(watchHealthy(r(3, 1, 2))).toBe(false);
    expect(watchHealthy(r(3, 1, 1))).toBe(true);
  });
});
