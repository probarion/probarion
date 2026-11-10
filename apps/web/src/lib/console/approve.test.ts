import type { MandateView, SpendView } from "@probarion/core";
import { describe, expect, it } from "vitest";
import type { InvoiceRow } from "@/lib/payables/store";
import { vaultConfig } from "../../../test/fixtures/reader";
import {
  type ApproveState,
  approvePath,
  approveState,
  matchInvoice,
  parseSpendId,
} from "./approve";

// The approval page (roadmap G2): what it offers is decided from the chain's answers alone, and it offers approve only
// for a spend the chain reads as held, to an account the chain lists as one of the vault's approvers.

const NOW = Date.UTC(2026, 10, 10, 12, 0);
const inAnHour = String(BigInt(NOW + 3_600_000) * 1_000_000n);
const anHourAgo = String(BigInt(NOW - 3_600_000) * 1_000_000n);
const AGENT = `ed25519:${"3".repeat(44)}`;

const spend = (over: Partial<SpendView> = {}): SpendView => ({
  id: 7,
  mandate_id: 2,
  amount: "4000000",
  invoice_hash: "f".repeat(64),
  ref: "inv-7",
  decision_hash: "d".repeat(64),
  agent_pk: AGENT,
  destination: { type: "near", account_id: "payee.near" },
  status: "held",
  created_at_ns: "1",
  held_until_ns: inAnHour,
  memo: null,
  ...over,
});
const mandate = (over: Partial<MandateView> = {}): MandateView => ({
  id: 2,
  payee: { type: "near", account_id: "payee.near" },
  purpose_hash: "a".repeat(64),
  max_per_payment: "5000000",
  max_total: "20000000",
  spent: "0",
  reserved: "4000000",
  max_uses: 5,
  uses: 1,
  expires_at_ns: inAnHour,
  approval_above: "3000000",
  agent_pk: AGENT,
  label: "Sample PO-1001",
  status: "active",
  created_at_ns: "1",
  ...over,
});
const ok = <T>(value: T) => ({ ok: true as const, value });
const down = { ok: false as const, kind: "transport" as const };

function state(
  over: Partial<{
    account: string;
    config: unknown;
    spend: unknown;
    mandate: unknown;
    configRead: boolean;
    spendRead: boolean;
    mandateRead: boolean;
    nowMs: number;
  }> = {},
): ApproveState {
  return approveState({
    account: over.account ?? "cfo.near",
    spendId: 7,
    config: over.configRead === false ? down : ok("config" in over ? over.config : vaultConfig()),
    spend: over.spendRead === false ? down : ok("spend" in over ? over.spend : spend()),
    mandate: over.mandateRead === false ? down : ok("mandate" in over ? over.mandate : mandate()),
    nowMs: over.nowMs ?? NOW,
  });
}

describe("parseSpendId", () => {
  it("reads a spend id: a whole number from 1, as the contract numbers spends", () => {
    expect(parseSpendId("1")).toBe(1);
    expect(parseSpendId("7")).toBe(7);
    expect(parseSpendId("9007199254740991")).toBe(9007199254740991);
  });

  it("refuses anything else, so it never reaches a chain read or a transaction", () => {
    for (const bad of [
      "0",
      "07",
      "-1",
      "1.5",
      "1e3",
      " 7",
      "7 ",
      "0x7",
      "",
      "9007199254740992",
      "99999999999999999999",
      "７",
      7,
      null,
      undefined,
      ["7"],
    ]) {
      expect(parseSpendId(bad), String(bad)).toBeNull();
    }
  });
});

describe("approvePath", () => {
  it("is the spend's page under its vault in the console", () => {
    expect(approvePath("acme.vaults.probarion.near", 7)).toBe(
      "/console/acme.vaults.probarion.near/approve/7",
    );
  });
});

describe("approveState: what the page offers", () => {
  it("offers approve and reject to an approver the chain lists, for a spend the chain reads as held", () => {
    const s = state();
    expect(s.kind).toBe("held");
    if (s.kind !== "held") return;
    expect(s).toMatchObject({ approver: true, canApprove: true, canReject: true, note: null });
    expect(s.spend.id).toBe(7);
    expect(s.mandate).toEqual({ ok: true, value: mandate() });
  });

  it("names the hold's reason from the chain: the amount is above the mandate's approval threshold", () => {
    const s = state();
    expect(s.kind === "held" && s.aboveThreshold).toBe("3000000");
    // A threshold the amount does not exceed is no reason the page can name.
    const t = state({ mandate: mandate({ approval_above: "4000000" }) });
    expect(t.kind === "held" && t.aboveThreshold).toBeNull();
    const u = state({ mandateRead: false });
    expect(u.kind === "held" && u.aboveThreshold).toBeNull();
  });

  describe("refuses approve, and reject, to an account that is not one of the vault's approvers on chain", () => {
    for (const account of ["acme.near", "view.near", "stranger.near", "CFO.near", "cfo.near "]) {
      it(account, () => {
        const s = state({ account });
        expect(s.kind).toBe("held");
        if (s.kind !== "held") return;
        expect(s).toMatchObject({ approver: false, canApprove: false, canReject: false });
        expect(s.note).toContain("Only the vault's approvers can approve or reject");
        expect(s.note).toContain("cfo.near");
      });
    }

    it("the chain decides: the owner is no approver unless the chain lists it", () => {
      const listed = state({
        account: "acme.near",
        config: vaultConfig({ approvers: ["acme.near"] }),
      });
      expect(listed.kind === "held" && listed.canApprove).toBe(true);
      const removed = state({ config: vaultConfig({ approvers: ["other.near"] }) });
      expect(removed.kind === "held" && removed.approver).toBe(false);
    });
  });

  describe("refuses approve for a spend that is not held", () => {
    for (const status of ["pending", "paid", "burned", "failed", "rejected", "expired"] as const) {
      it(status, () => {
        const s = state({ spend: spend({ status, held_until_ns: null }) });
        expect(s.kind).toBe("not_held");
        expect(s).not.toHaveProperty("canApprove");
        expect(s).not.toHaveProperty("canReject");
        expect(s.kind === "not_held" && s.spend.status).toBe(status);
      });
    }
  });

  it("refuses everything for a spend id the vault has no spend for", () => {
    expect(state({ spend: null }).kind).toBe("missing");
  });

  it("offers nothing when the config or the spend cannot be read", () => {
    expect(state({ configRead: false })).toEqual({
      kind: "unreadable",
      what: "config",
      why: "NEAR could not be reached",
    });
    expect(state({ spendRead: false })).toEqual({
      kind: "unreadable",
      what: "spend",
      why: "NEAR could not be reached",
    });
  });

  it("offers nothing for an answer that is not a spend, or is another spend", () => {
    for (const bad of [
      "spend",
      [],
      { ...spend(), id: 8 },
      { ...spend(), id: "7" },
      { ...spend(), amount: "4.0" },
      { ...spend(), amount: "-4" },
      { ...spend(), status: "approved" },
      { ...spend(), destination: { type: "near" } },
      { ...spend(), destination: { type: "evm", address: "0x1" } },
      { ...spend(), held_until_ns: "soon" },
      { ...spend(), mandate_id: -2 },
      { ...spend(), ref: 7 },
      { ...spend(), invoice_hash: null },
    ]) {
      const s = state({ spend: bad });
      expect(s.kind, JSON.stringify(bad)).toBe("unreadable");
    }
  });

  it("offers nothing for a config that is not a config", () => {
    expect(state({ config: { ...vaultConfig(), approvers: "cfo.near" } }).kind).toBe("unreadable");
  });

  it("offers reject, and not approve, once the hold has run out", () => {
    const s = state({ spend: spend({ held_until_ns: anHourAgo }) });
    expect(s).toMatchObject({ kind: "held", approver: true, canApprove: false, canReject: true });
    expect(s.kind === "held" && s.note).toContain("HoldExpired");
  });

  it("offers reject, and not approve, while the vault is frozen", () => {
    const s = state({ config: vaultConfig({ frozen: true }) });
    expect(s).toMatchObject({ kind: "held", canApprove: false, canReject: true });
    expect(s.kind === "held" && s.note).toContain("frozen");
  });

  it("offers reject, and not approve, when the mandate was revoked or is gone", () => {
    for (const m of [mandate({ status: "revoked" }), null]) {
      const s = state({ mandate: m });
      expect(s, JSON.stringify(m)).toMatchObject({
        kind: "held",
        canApprove: false,
        canReject: true,
      });
      expect(s.kind === "held" && s.note).toContain("MandateInactive");
    }
  });

  it("approves under an exhausted mandate: the held spend already holds its use", () => {
    const s = state({ mandate: mandate({ status: "exhausted", uses: 5 }) });
    expect(s).toMatchObject({ kind: "held", canApprove: true });
  });

  it("does not offer approve when the mandate cannot be read, or is another mandate", () => {
    for (const over of [
      { mandateRead: false },
      { mandate: { ...mandate(), id: 3 } },
      { mandate: { ...mandate(), approval_above: "three" } },
      { mandate: "mandate" },
    ]) {
      const s = state(over);
      expect(s, JSON.stringify(over)).toMatchObject({
        kind: "held",
        canApprove: false,
        canReject: true,
      });
      expect(s.kind === "held" && s.note).toContain("approve is not offered");
      expect(s.kind === "held" && s.mandate.ok).toBe(false);
    }
  });

  it("does not offer approve for a hold whose end it cannot read", () => {
    const s = state({ spend: spend({ held_until_ns: null }) });
    expect(s).toMatchObject({ kind: "held", canApprove: false, canReject: true });
  });

  it("approves at the hold's last instant, as the contract does, and not one millisecond after", () => {
    const end = String(BigInt(NOW) * 1_000_000n);
    expect(state({ spend: spend({ held_until_ns: end }) })).toMatchObject({ canApprove: true });
    expect(state({ spend: spend({ held_until_ns: end }), nowMs: NOW + 1 })).toMatchObject({
      canApprove: false,
    });
  });
});

describe("matchInvoice", () => {
  const row = (over: Partial<InvoiceRow>): InvoiceRow =>
    ({ id: "r", invoice_hash: "f".repeat(64), ref: "inv-7", ...over }) as InvoiceRow;

  it("finds the console's invoice by the hash and the ref the chain recorded for the spend", () => {
    const rows = [
      row({ id: "a", ref: "inv-6" }),
      row({ id: "b" }),
      row({ id: "c", invoice_hash: "e".repeat(64) }),
    ];
    expect(matchInvoice(rows, spend())?.id).toBe("b");
  });

  it("finds none when only the hash or only the ref matches", () => {
    expect(
      matchInvoice([row({ ref: "inv-8" }), row({ invoice_hash: "0".repeat(64) })], spend()),
    ).toBeNull();
    expect(matchInvoice([], spend())).toBeNull();
  });
});
