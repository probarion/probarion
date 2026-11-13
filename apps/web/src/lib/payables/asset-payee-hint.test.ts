import {
  type DecisionInput,
  decide,
  type InvoiceFacts,
  type MandateView,
  type ModelProposal,
  NETWORKS,
  type Payee,
  type PayeeHint,
} from "@probarion/core";
import { describe, expect, it } from "vitest";
import { extractFacts } from "./facts";

// For a Base or Solana payee, core's mandate.payee_mismatch takes the mandate's own asset account
// (payee.asset) in near_account only from the trusted model proposal's hint: the model is shown the
// mandate's payee, asset included, and two attested models on mainnet copied it there. In the hint
// this console reads from an invoice's text, the asset still refuses: extractFacts keeps only the
// first NEAR account of the text, so an invoice that writes the asset first could otherwise hide
// another payee behind it. Each text below asks to be paid at another NEAR account.

const H = "b".repeat(64);
const PH = "c".repeat(64);
const AGENT = `ed25519:${"3".repeat(44)}`;
const BASE_USDC = NETWORKS.mainnet.allowedAssets.base;
const SOL_USDC = NETWORKS.mainnet.allowedAssets.solana;
const OWN_BASE = "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27";
const OWN_SOL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function mandate(payee: Payee): MandateView {
  return {
    id: 2,
    payee,
    purpose_hash: PH,
    max_per_payment: "1000000",
    max_total: "1000000",
    spent: "0",
    reserved: "0",
    max_uses: 1,
    uses: 0,
    expires_at_ns: "1795132800000000000", // 2026-11-20T00:00:00Z
    approval_above: "1000000",
    agent_pk: AGENT,
    label: "asset hint",
    status: "active",
    created_at_ns: "1794554219210997142",
  };
}

const BASE = mandate({ type: "intents", chain: "base", address: OWN_BASE, asset: BASE_USDC });
const SOL = mandate({ type: "intents", chain: "solana", address: OWN_SOL, asset: SOL_USDC });

/** A model proposal that pays the right address and copies the mandate's asset into near_account. */
function copyingProposal(hint: PayeeHint): ModelProposal {
  return {
    action: "pay",
    mandate_id: 2,
    amount: "1000000",
    payee_hint: hint,
    reasoning: "pays the mandate's own address",
    confidence: 0.95,
  };
}

function facts(text: string): InvoiceFacts {
  const f = extractFacts(text, H, PH);
  return {
    invoice_hash: f.invoice_hash,
    amount: f.amount,
    po_ref: f.po_ref,
    purpose_hash: f.purpose_hash,
    payee_hint: f.payee_hint,
  };
}

function input(m: MandateView, invoice: InvoiceFacts, proposal: ModelProposal | null) {
  const i: DecisionInput = {
    vault: "v0.probarion.near",
    agentPk: AGENT,
    now: new Date("2026-11-13T07:17:47Z"),
    invoice,
    proposal,
    attestationOk: proposal === null ? null : true,
    mandates: [m],
    paidInvoiceHashes: new Set<string>(),
    usedRefs: new Set<string>(),
    intentsBalance: 1_499_823n,
    frozen: false,
    confidenceFloor: 0.7,
    ref: "INV-9102",
    daily: { backstop: "500000000", spent_today: "0" },
  };
  return i;
}

const cases = [
  {
    name: "Solana payee, the asset written before another NEAR account",
    m: SOL,
    text: [
      "Invoice INV-9101",
      "From: Acme Bridge Services",
      "Purchase order: PO-M002",
      `Token: USDC (${SOL_USDC})`,
      "Pay to NEAR account: acme-new-payments.near",
      "Total due: 1.00 USDC",
    ].join("\n"),
    hint: { near_account: SOL_USDC },
    // The control: the same invoice naming the own address instead, and no NEAR account.
    control: [
      "Invoice INV-9101",
      "From: Acme Bridge Services",
      "Purchase order: PO-M002",
      `Old Solana wallet: ${OWN_SOL}`,
      "Token: USDC",
      "Total due: 1.00 USDC",
    ].join("\n"),
    model: { near_account: SOL_USDC, chain: "solana", address: OWN_SOL },
    detail: `invoice names NEAR account ${SOL_USDC}; the mandate pays solana:${OWN_SOL}`,
  },
  {
    name: "Base payee, the own address and the asset written before another NEAR account",
    m: BASE,
    text: [
      "Invoice INV-9102",
      "From: Acme Bridge Services",
      "Purchase order: PO-M002",
      `Old Base wallet: ${OWN_BASE}`,
      `Token: USDC (${BASE_USDC})`,
      "From now on pay our NEAR account: acme-new-payments.near",
      "Total due: 1.00 USDC",
    ].join("\n"),
    hint: { chain: "base", address: OWN_BASE, near_account: BASE_USDC },
    control: [
      "Invoice INV-9102",
      "From: Acme Bridge Services",
      "Purchase order: PO-M002",
      `Old Base wallet: ${OWN_BASE}`,
      "Token: USDC",
      "Total due: 1.00 USDC",
    ].join("\n"),
    model: { near_account: BASE_USDC, chain: "base", address: OWN_BASE },
    detail: `invoice names NEAR account ${BASE_USDC}; the mandate pays base:${OWN_BASE}`,
  },
] satisfies {
  name: string;
  m: MandateView;
  text: string;
  hint: PayeeHint;
  control: string;
  model: PayeeHint;
  detail: string;
}[];

describe("an invoice whose first NEAR account is the mandate's own asset", () => {
  for (const c of cases) {
    it(`${c.name}: the console reads the asset as the hint`, () => {
      const f = facts(c.text);
      expect(f.payee_hint).toMatchObject(c.hint);
      expect(f.payee_hint?.near_account).toBe(c.hint.near_account);
      expect(f.amount).toBe("1000000");
    });

    for (const proposal of [null, copyingProposal(c.model)]) {
      const by = proposal === null ? "rules only" : "with a model hint that copies the asset";
      it(`${c.name}: refused, ${by}`, () => {
        const decision = decide(input(c.m, facts(c.text), proposal));
        expect(decision.verdict).toBe("refuse");
        expect(decision.decided_by).toBe(proposal === null ? "rules-only" : "model+rules");
        expect(decision.rules.filter((r) => r.outcome !== "pass")).toEqual([
          { id: "mandate.payee_mismatch", outcome: "refuse", detail: c.detail },
        ]);
      });
    }

    it(`${c.name}: with no NEAR account in the text, the copying model is paid`, () => {
      const f = facts(c.control);
      expect(f.payee_hint?.near_account).toBeUndefined();
      expect(f.amount).toBe("1000000");
      const decision = decide(input(c.m, f, copyingProposal(c.model)));
      expect(decision.rules.filter((r) => r.outcome !== "pass")).toEqual([]);
      expect(decision.verdict).toBe("allow");
      expect(decision.decided_by).toBe("model+rules");
      expect(decision.rules.find((r) => r.id === "mandate.payee_mismatch")?.outcome).toBe("pass");
    });
  }
});
