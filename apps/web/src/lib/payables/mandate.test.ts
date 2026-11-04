import type { MandateView } from "@probarion/core";
import { purposeMatch } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { signingMandate, spendableNow } from "./mandate";

const NOW = new Date("2026-11-05T12:00:00Z");
const P = "a".repeat(64);
const Q = "b".repeat(64);
const KEY_A = `ed25519:${"A".repeat(44)}`;
const KEY_B = `ed25519:${"B".repeat(44)}`;

function mandate(over: Partial<MandateView> & Pick<MandateView, "id">): MandateView {
  return {
    payee: { type: "near", account_id: "vendor.near" },
    purpose_hash: P,
    max_per_payment: "100000000",
    max_total: "1000000000",
    spent: "0",
    reserved: "0",
    max_uses: 10,
    uses: 0,
    expires_at_ns: "1798761600000000000", // 2027-01-01
    approval_above: "50000000",
    agent_pk: KEY_A,
    label: "m",
    status: "active",
    created_at_ns: "1793750400000000000",
    ...over,
  };
}

describe("spendableNow", () => {
  it.each([
    ["an active mandate", {}, true],
    ["a revoked one", { status: "revoked" as const }, false],
    ["an expired one", { expires_at_ns: "1700000000000000000" }, false],
    ["one with no use left", { uses: 10 }, false],
    ["one with no room under its total", { spent: "600000000", reserved: "400000000" }, false],
    ["one with an unreadable total", { max_total: "lots" }, false],
  ])("%s -> %s", (_what, over, ok) => {
    expect(spendableNow(mandate({ id: 4, ...over }), NOW)).toBe(ok);
  });
});

describe("signingMandate", () => {
  const active = new Set([KEY_A]);

  it("is null without a purpose, or when no mandate has it", () => {
    expect(signingMandate([mandate({ id: 1 })], null, NOW, active)).toBeNull();
    expect(signingMandate([mandate({ id: 1 })], Q, NOW, active)).toBeNull();
    expect(signingMandate([], P, NOW, active)).toBeNull();
  });

  it("takes the lowest-id spendable mandate bound to an active key", () => {
    const ms = [
      mandate({ id: 3 }),
      mandate({ id: 1, agent_pk: KEY_B }), // spendable, but its key is not active here
      mandate({ id: 2, status: "revoked" }),
      mandate({ id: 5, purpose_hash: Q }),
    ];
    expect(signingMandate(ms, P, NOW, active)?.id).toBe(3);
  });

  it("picks what the SDK picks once it is given that mandate's key", () => {
    const ms = [mandate({ id: 1, agent_pk: KEY_B }), mandate({ id: 2 }), mandate({ id: 4 })];
    const chosen = signingMandate(ms, P, NOW, active);
    expect(chosen?.id).toBe(2);
    expect(purposeMatch(ms, P, NOW, chosen?.agent_pk ?? "")).toBe(chosen);
  });

  it("names a spendable mandate whose key is not active, so the cycle is skipped for that key", () => {
    const ms = [mandate({ id: 1, agent_pk: KEY_B }), mandate({ id: 2, uses: 10 })];
    expect(signingMandate(ms, P, NOW, active)?.id).toBe(1);
  });

  it("with nothing spendable, prefers a mandate bound to an active key, so the SDK refuses with the reason", () => {
    const ms = [
      mandate({ id: 1, agent_pk: KEY_B, status: "revoked" }),
      mandate({ id: 2, expires_at_ns: "1700000000000000000" }),
    ];
    expect(signingMandate(ms, P, NOW, active)?.id).toBe(2);
    expect(signingMandate(ms, P, NOW, new Set())?.id).toBe(1);
  });
});
