import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIDENCE_FLOOR, decide } from "../src/policy.js";
import type { DecisionInput, MandateView, ModelProposal, RuleResult } from "../src/types.js";

// A replay of the two attested proposals that code refused on NEAR mainnet on 2026-11-13: ledger entries
// seq 0 (z-ai/glm-5.3-flash) and seq 1 (Qwen/Qwen3.8-27B) of vault v0.probarion.near, mandate 2, invoice
// INV-M002. Both models proposed pay to the mandate's Base address and also put the mandate's own asset
// account in payee_hint.near_account; mandate.payee_mismatch refused both, and the payment was then
// decided rules-only (seq 2). The values below are copied from those ledger entries and from the
// mandate as the vault returned it before the run; nothing here reads a file or the network.

const VAULT = "v0.probarion.near";
const AGENT_PK = "ed25519:GADeVCXtgcxS3E5JrcVpEWTuZiNMJ4gu17iyuEgyCycd";
const BASE_USDC = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const OWNER_BASE = "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27";

const MANDATE_2: MandateView = {
  id: 2,
  payee: { type: "intents", chain: "base", address: OWNER_BASE, asset: BASE_USDC },
  purpose_hash: "359d7ee21bafe38b1d1a948bd9df884ee1bb85c75ac12ce05a8a0cdbc92b3452",
  max_per_payment: "1000000",
  max_total: "1000000",
  spent: "0",
  reserved: "0",
  max_uses: 1,
  uses: 0,
  expires_at_ns: "1795132800000000000", // 2026-11-20T00:00:00Z
  approval_above: "1000000",
  agent_pk: AGENT_PK,
  label: "s1 base payee",
  status: "active",
  created_at_ns: "1794554219210997142",
};

/** The payee hint both models returned, field for field. */
const RECORDED_HINT = {
  near_account: BASE_USDC,
  address: OWNER_BASE,
  name: "vault owner's own Base wallet",
  chain: "base",
} as const;

interface Recorded {
  seq: number;
  model: string;
  at: string;
  proposal: ModelProposal;
}

const RECORDED: Recorded[] = [
  {
    seq: 0,
    model: "z-ai/glm-5.3-flash",
    at: "2026-11-13T07:17:47.060Z",
    proposal: {
      action: "pay",
      mandate_id: 2,
      amount: "1000000",
      payee_hint: { ...RECORDED_HINT },
      reasoning:
        "Invoice total 1.00 USDC = 1000000 smallest units, within mandate 2 max_per_payment and remaining. PO-M002 matches facts.po_ref, purpose_hash matches mandate purpose_hash, mandate active and unexpired. Invoice payee explicitly claims the mandate's Base address, matching mandate payee.",
      confidence: 0.95,
    },
  },
  {
    seq: 1,
    model: "Qwen/Qwen3.8-27B",
    at: "2026-11-13T07:22:23.023Z",
    proposal: {
      action: "pay",
      mandate_id: 2,
      amount: "1000000",
      payee_hint: { ...RECORDED_HINT },
      reasoning:
        "The invoice amount matches the mandate's max_per_payment and remaining balance, the purpose_hash matches, and the claimed payee is the same Base address as the active mandate payee.",
      confidence: 0.9,
    },
  },
];

/** The rules each entry recorded, in order; only model.low_confidence's detail differs between them. */
function recordedRules(confidence: number): RuleResult[] {
  return [
    { id: "vault.frozen", outcome: "pass", detail: "vault is not frozen" },
    { id: "mandate.none", outcome: "pass", detail: "mandate 2 selected by proposal" },
    {
      id: "mandate.inactive",
      outcome: "pass",
      detail: "mandate 2 is not revoked (status active)",
    },
    { id: "mandate.expired", outcome: "pass", detail: "expires at 1795132800000000000 ns" },
    { id: "mandate.agent_mismatch", outcome: "pass", detail: "agent key matches the mandate" },
    { id: "invoice.po_mismatch", outcome: "pass", detail: "purpose matches mandate 2" },
    {
      id: "mandate.payee_mismatch",
      outcome: "refuse",
      detail: `invoice names NEAR account ${BASE_USDC}; the mandate pays base:${OWNER_BASE}`,
    },
    { id: "invoice.amount_invalid", outcome: "pass", detail: "amount 1000000" },
    {
      id: "mandate.over_per_payment",
      outcome: "pass",
      detail: "amount 1000000 vs per-payment cap 1000000",
    },
    { id: "mandate.uses_exhausted", outcome: "pass", detail: "0 of 1 uses consumed" },
    {
      id: "mandate.over_total",
      outcome: "pass",
      detail: "spent + reserved + amount = 1000000 vs total cap 1000000",
    },
    { id: "invoice.duplicate", outcome: "pass", detail: "invoice and ref are unused" },
    {
      id: "vault.daily_backstop",
      outcome: "pass",
      detail: "today 1000000 of backstop 500000000",
    },
    { id: "intents.balance_low", outcome: "pass", detail: "POA balance 1499823" },
    { id: "model.refused", outcome: "pass", detail: "model proposed pay" },
    {
      id: "model.low_confidence",
      outcome: "pass",
      detail: `confidence ${confidence} (floor 0.7)`,
    },
  ];
}

function replayInput(r: Recorded, proposal: ModelProposal = r.proposal): DecisionInput {
  return {
    vault: VAULT,
    agentPk: AGENT_PK,
    now: new Date(r.at),
    invoice: {
      invoice_hash: "bd45f2327fb0c2c1e960606e5c0bb91e3cfec7883f21315e94f454a83fee8357",
      amount: "1000000",
      po_ref: "PO-M002",
      purpose_hash: MANDATE_2.purpose_hash,
      // What the run's code read from the invoice: a Base payee, no address named.
      payee_hint: { chain: "base" },
    },
    proposal,
    attestationOk: true, // A1-A7 and A8 passed for both entries
    mandates: [MANDATE_2],
    paidInvoiceHashes: new Set<string>(),
    usedRefs: new Set<string>(),
    intentsBalance: 1_499_823n,
    frozen: false,
    confidenceFloor: DEFAULT_CONFIDENCE_FLOOR,
    ref: "INV-M002",
    daily: { backstop: "500000000", spent_today: "0" },
  };
}

describe("replay: the two attested mainnet proposals code refused on 2026-11-13", () => {
  for (const r of RECORDED) {
    it(`seq ${r.seq} (${r.model}): mandate.payee_mismatch now passes, every other rule as recorded`, () => {
      const decision = decide(replayInput(r));
      const recorded = recordedRules(r.proposal.confidence);
      const payee = (rules: RuleResult[]) => rules.find((x) => x.id === "mandate.payee_mismatch");
      const others = (rules: RuleResult[]) =>
        rules.filter((x) => x.id !== "mandate.payee_mismatch");

      expect(payee(recorded)?.outcome).toBe("refuse");
      expect(payee(decision.rules)).toEqual({
        id: "mandate.payee_mismatch",
        outcome: "pass",
        detail: `destination is the mandate payee base:${OWNER_BASE} (${BASE_USDC})`,
      });
      // Same rules, same order, same outcomes and details, the payee rule aside.
      expect(decision.rules.map((x) => x.id)).toEqual(recorded.map((x) => x.id));
      expect(others(decision.rules)).toEqual(others(recorded));
      expect(decision).toMatchObject({
        verdict: "allow",
        mandate_id: 2,
        amount: "1000000",
        decided_by: "model+rules",
      });
    });

    it(`seq ${r.seq} (${r.model}): another account in near_account is still refused`, () => {
      for (const near_account of [
        "probarion-duong.near",
        "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
        BASE_USDC.toUpperCase(),
        ` ${BASE_USDC}`,
      ]) {
        const changed = { ...r.proposal, payee_hint: { ...RECORDED_HINT, near_account } };
        const decision = decide(replayInput(r, changed));
        // When only spaces differ from the asset, the detail quotes the value as given.
        const given =
          near_account.trim() === BASE_USDC ? ` (given as ${JSON.stringify(near_account)})` : "";
        expect(decision.verdict, near_account).toBe("refuse");
        expect(
          decision.rules.find((x) => x.id === "mandate.payee_mismatch"),
          near_account,
        ).toEqual({
          id: "mandate.payee_mismatch",
          outcome: "refuse",
          detail: `invoice names NEAR account ${near_account.trim()}${given}; the mandate pays base:${OWNER_BASE}`,
        });
      }
    });

    it(`seq ${r.seq} (${r.model}): an invoice that names the asset account is still refused`, () => {
      // Only the model's hint may carry the asset: the run's invoice named no NEAR account.
      const i = replayInput(r);
      const decision = decide({
        ...i,
        invoice: { ...i.invoice, payee_hint: { ...RECORDED_HINT } },
      });
      expect(decision.verdict).toBe("refuse");
      expect(decision.rules.find((x) => x.id === "mandate.payee_mismatch")).toEqual(
        recordedRules(r.proposal.confidence).find((x) => x.id === "mandate.payee_mismatch"),
      );
    });
  }
});
