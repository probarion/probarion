import type { AnchorView, MandateView, SpendView } from "@probarion/core";

/** Where a fixture hold's window ends: 2100-01-01 UTC in nanoseconds, so a held spend is inside its window in every test. */
export const HELD_UNTIL_NS = "4102444800000000000";

/** A spend as `list_spends` shows it: 5 USDC to one NEAR account, held until `HELD_UNTIL_NS` while it is held. */
export function spend(
  id: number,
  status: SpendView["status"],
  over: Partial<SpendView> = {},
): SpendView {
  return {
    id,
    mandate_id: 1,
    amount: "5000000",
    invoice_hash: "a".repeat(64),
    ref: `inv-${id}`,
    decision_hash: "d".repeat(64),
    agent_pk: "ed25519:agent",
    destination: { type: "near", account_id: "designer.near" },
    status,
    created_at_ns: "1",
    held_until_ns: status === "held" ? HELD_UNTIL_NS : null,
    memo: null,
    ...over,
  };
}

/** An anchor as `list_anchors` shows it: `seq` starts at 1. */
export function anchor(seq: number, over: Partial<AnchorView> = {}): AnchorView {
  return { seq, root: "r".repeat(64), count: 3, at_ns: "1", ledger_key: "ed25519:ledger", ...over };
}

/** A mandate as `list_mandates` shows it: ids start at 1. */
export function mandateView(id: number, over: Partial<MandateView> = {}): MandateView {
  return {
    id,
    payee: { type: "near", account_id: "designer.near" },
    purpose_hash: "p".repeat(64),
    max_per_payment: "100000000",
    max_total: "1000000000",
    spent: "0",
    reserved: "0",
    max_uses: 10,
    uses: 0,
    expires_at_ns: "1798761600000000000",
    approval_above: "50000000",
    agent_pk: "ed25519:agent",
    label: `mandate-${id}`,
    status: "active",
    created_at_ns: "1793750400000000000",
    ...over,
  };
}
