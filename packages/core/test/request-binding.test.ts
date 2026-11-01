import { describe, expect, it } from "vitest";
import { checkAttestation, checkRequestBinding } from "../src/attestation.js";
import { sha256Hex } from "../src/hash.js";
import {
  buildProposalRequest,
  PROPOSAL_SYSTEM_PROMPT,
  type ProposalRequestInput,
  toProposalRequestMandate,
} from "../src/proposal-request.js";
import type { AttestationEvidence, MandateView, ProposalRequestInputs } from "../src/types.js";
import {
  buildTestEvidence,
  buildTestEvidenceForRequest,
  TEST_MODEL,
  TEST_PROPOSAL,
} from "./fixtures/evidence.js";

const INVOICE =
  "INVOICE INV-1001\nFrom: Vendor Ltd (vendor.testnet)\nPO-1001 design retainer\nTotal due: 25.00 USDC";
const NONCE = sha256Hex("probarion/test-fixture/a8-nonce");
const OTHER_NONCE = sha256Hex("probarion/test-fixture/a8-other-nonce");
const PURPOSE = sha256Hex("RECORDING FIXTURE PO-1001");
const base = { chatId: "chatcmpl-test-fixture-a8", fetchedAt: "2026-11-05T10:00:00.000Z" };

const mandate: MandateView = {
  id: 1,
  payee: { type: "near", account_id: "vendor.testnet" },
  purpose_hash: PURPOSE,
  max_per_payment: "100000000",
  max_total: "1000000000",
  spent: "0",
  reserved: "0",
  max_uses: 10,
  uses: 0,
  expires_at_ns: "1798761600000000000",
  approval_above: "50000000",
  agent_pk: "ed25519:11111111111111111111111111111111",
  label: "Recording fixture",
  status: "active",
  created_at_ns: "1793750400000000000",
};
const input: ProposalRequestInput = {
  invoiceText: INVOICE,
  nonce: NONCE,
  facts: {
    invoice_hash: sha256Hex(INVOICE),
    amount: "25000000",
    po_ref: "PO-1001",
    purpose_hash: PURPOSE,
  },
  mandates: [mandate],
};

function inputsOf(ev: AttestationEvidence): ProposalRequestInputs {
  if (ev.request_inputs === undefined) throw new Error("fixture has no request_inputs");
  return ev.request_inputs;
}

function withInputs(
  ev: AttestationEvidence,
  patch: Partial<ProposalRequestInputs>,
): AttestationEvidence {
  return { ...ev, request_inputs: { ...inputsOf(ev), ...patch } };
}

describe("checkRequestBinding (A8, request binding)", () => {
  it("passes for an honest request, and A1-A7 pass for the same evidence", async () => {
    const ev = await buildTestEvidenceForRequest({ ...base, input });
    const a8 = checkRequestBinding(ev, INVOICE);
    expect(a8).toMatchObject({ id: "A8", pass: true });
    expect(a8.detail).toContain("request_sha256");
    const a1to7 = await checkAttestation(ev, NONCE, TEST_PROPOSAL);
    expect(a1to7.ok).toBe(true);
    expect(a1to7.checks.map((c) => c.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7"]);
  });

  it("passes when the ledger nonce is supplied and equals the evidence nonce", async () => {
    const ev = await buildTestEvidenceForRequest({ ...base, input });
    expect(checkRequestBinding(ev, INVOICE, NONCE).pass).toBe(true);
  });

  it("passes for an honestly recorded persona, which stays readable in request_inputs for the auditor", async () => {
    const ev = await buildTestEvidenceForRequest({
      ...base,
      input,
      systemPrompt: "CANARY PERSONA",
    });
    expect(checkRequestBinding(ev, INVOICE).pass).toBe(true);
    expect(inputsOf(ev).system_prompt).toBe("CANARY PERSONA");
  });

  it("passes with no facts and no mandates", async () => {
    const bare: ProposalRequestInput = {
      invoiceText: INVOICE,
      nonce: NONCE,
      facts: null,
      mandates: [],
    };
    const ev = await buildTestEvidenceForRequest({ ...base, input: bare });
    expect(checkRequestBinding(ev, INVOICE).pass).toBe(true);
  });

  it("fails for a different invoice text, naming the invoice hash", async () => {
    const ev = await buildTestEvidenceForRequest({ ...base, input });
    for (const other of [
      `${INVOICE} `,
      INVOICE.replace("25.00", "2500.00"),
      "",
      INVOICE.toLowerCase(),
    ]) {
      const a8 = checkRequestBinding(ev, other);
      expect(a8.pass).toBe(false);
      expect(a8.detail).toContain("invoice_text_sha256");
    }
  });

  it("fails when the request that was signed used another nonce than the evidence nonce", async () => {
    const asked = await buildTestEvidenceForRequest({
      ...base,
      input: { ...input, nonce: OTHER_NONCE },
    });
    // the writer records the ledger position's nonce, but the chat was asked with another one
    const ev: AttestationEvidence = { ...asked, nonce: NONCE };
    const a8 = checkRequestBinding(ev, INVOICE);
    expect(a8.pass).toBe(false);
    expect(a8.detail).toContain("request_sha256");
  });

  it("fails when the evidence nonce is not the ledger nonce the caller expects", async () => {
    const ev = await buildTestEvidenceForRequest({
      ...base,
      input: { ...input, nonce: OTHER_NONCE },
    });
    const a8 = checkRequestBinding(ev, INVOICE, NONCE);
    expect(a8.pass).toBe(false);
    expect(a8.detail).toContain("ledger nonce");
  });

  it("fails for a different mandate set or different mandate state than the one the model was shown", async () => {
    const ev = await buildTestEvidenceForRequest({ ...base, input });
    const shown = inputsOf(ev).mandates;
    const first = shown[0];
    if (first === undefined) throw new Error("fixture has no mandate");
    for (const mandates of [
      [],
      [{ ...first, remaining: "1" }],
      [{ ...first, status: "revoked" as const }],
      [{ ...first, label: "another label" }],
      [first, { ...first, id: 2 }],
    ]) {
      const a8 = checkRequestBinding(withInputs(ev, { mandates }), INVOICE);
      expect(a8.pass, JSON.stringify(mandates)).toBe(false);
      expect(a8.detail).toContain("request_sha256");
    }
  });

  it("fails for different facts than the ones the model was shown", async () => {
    const ev = await buildTestEvidenceForRequest({ ...base, input });
    const facts = inputsOf(ev).facts;
    if (facts === null) throw new Error("fixture has no facts");
    for (const other of [null, { ...facts, amount: "25000001" }, { ...facts, po_ref: null }]) {
      const a8 = checkRequestBinding(withInputs(ev, { facts: other }), INVOICE);
      expect(a8.pass).toBe(false);
    }
  });

  it("fails for a different system prompt than the one that was sent", async () => {
    const ev = await buildTestEvidenceForRequest({
      ...base,
      input,
      systemPrompt: "CANARY PERSONA",
    });
    const a8 = checkRequestBinding(
      withInputs(ev, { system_prompt: PROPOSAL_SYSTEM_PROMPT }),
      INVOICE,
    );
    expect(a8.pass).toBe(false);
    expect(a8.detail).toContain("request_sha256");
  });

  it("fails for a request that is not byte-identical, even when it says the same thing", async () => {
    const honest = buildProposalRequest(TEST_MODEL, input);
    const parsed = JSON.parse(honest) as Record<string, unknown>;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()));
    const spaced = JSON.stringify(parsed, null, 1);
    const warmer = JSON.stringify({ ...parsed, temperature: 0.7 });
    for (const requestBody of [reordered, spaced, warmer, `${honest}\n`]) {
      expect(requestBody).not.toBe(honest);
      const asked = await buildTestEvidence({ ...base, nonce: NONCE, requestBody });
      const ev: AttestationEvidence = {
        ...asked,
        request_inputs: inputsOf(await buildTestEvidenceForRequest({ ...base, input })),
      };
      expect(checkRequestBinding(ev, INVOICE).pass).toBe(false);
    }
  });

  it("fails when request_inputs is missing, with a reason that says why", async () => {
    const plain = await buildTestEvidence({ ...base, nonce: NONCE, requestBody: "{}" });
    const a8 = checkRequestBinding(plain, INVOICE);
    expect(a8).toMatchObject({ id: "A8", pass: false });
    expect(a8.detail).toContain("request_inputs is missing");
  });

  it("fails for an unknown template, a model that differs from the signed one, and a tampered invoice hash", async () => {
    const ev = await buildTestEvidenceForRequest({ ...base, input });
    const unknownTemplate = withInputs(ev, { template: "probarion-proposal/v2" as never });
    expect(checkRequestBinding(unknownTemplate, INVOICE).detail).toContain("template");
    const otherModel = withInputs(ev, { model: "test/other-model" });
    expect(checkRequestBinding(otherModel, INVOICE).detail).toContain("model");
    const forgedHash = withInputs(ev, { invoice_text_sha256: sha256Hex("another invoice") });
    expect(checkRequestBinding(forgedHash, INVOICE).pass).toBe(false);
  });

  it("fails when request_inputs carries fields the request did not (unbound extras)", async () => {
    const ev = await buildTestEvidenceForRequest({ ...base, input });
    const first = inputsOf(ev).mandates[0];
    if (first === undefined) throw new Error("fixture has no mandate");
    const padded = withInputs(ev, { mandates: [{ ...first, agent_pk: "ed25519:extra" } as never] });
    const a8 = checkRequestBinding(padded, INVOICE);
    expect(a8.pass).toBe(false);
    expect(a8.detail).toContain("fields");
    const extraFacts = withInputs(ev, {
      facts: { ...inputsOf(ev).facts, payee_hint: { name: "x" } } as never,
    });
    expect(checkRequestBinding(extraFacts, INVOICE).pass).toBe(false);
  });

  it("never throws on malformed evidence or input: it fails", async () => {
    const ev = await buildTestEvidenceForRequest({ ...base, input });
    const garbage: unknown[] = [
      null,
      undefined,
      "evidence",
      [],
      { ...ev, request_inputs: null },
      { ...ev, request_inputs: "x" },
      { ...ev, request_inputs: [] },
      { ...ev, request_inputs: { ...inputsOf(ev), mandates: null } },
      { ...ev, request_inputs: { ...inputsOf(ev), mandates: [null] } },
      { ...ev, request_inputs: { ...inputsOf(ev), mandates: [{ id: "1" }] } },
      { ...ev, request_inputs: { ...inputsOf(ev), facts: "facts" } },
      { ...ev, request_inputs: { ...inputsOf(ev), system_prompt: 5 } },
      { ...ev, request_inputs: { ...inputsOf(ev), model: undefined } },
      { ...ev, request_inputs: { ...inputsOf(ev), invoice_text_sha256: 5 } },
      { ...ev, nonce: 5 },
      { ...ev, nonce: "ABC" },
      { ...ev, request_sha256: undefined },
    ];
    for (const g of garbage) {
      const a8 = checkRequestBinding(g as AttestationEvidence, INVOICE);
      expect(a8, JSON.stringify(g)?.slice(0, 80)).toMatchObject({ id: "A8", pass: false });
    }
    for (const text of [undefined, null, 5, {}]) {
      expect(checkRequestBinding(ev, text as never).pass).toBe(false);
    }
  });

  describe("ICR-2 limit closed by A8: a genuine chat paired with a report fetched for this position", () => {
    const nonceA = sha256Hex("probarion/test-fixture/a8-position-a");
    const nonceB = sha256Hex("probarion/test-fixture/a8-position-b");
    const invoiceA = "INVOICE A\nPO-1001\nTotal due: 25.00 USDC";
    const invoiceB = "INVOICE B\nPO-2002\nTotal due: 25.00 USDC";
    const inputA: ProposalRequestInput = { ...input, invoiceText: invoiceA, nonce: nonceA };
    const inputB: ProposalRequestInput = { ...input, invoiceText: invoiceB, nonce: nonceB };

    it("A1-A7 pass for the replay (same proposal), A8 fails for the entry's invoice, whichever request_inputs the writer records", async () => {
      const chatA = await buildTestEvidenceForRequest({
        ...base,
        chatId: "chatcmpl-a",
        input: inputA,
      });
      const reportB = await buildTestEvidenceForRequest({
        ...base,
        chatId: "chatcmpl-b",
        input: inputB,
      });
      const replayWithA: AttestationEvidence = { ...chatA, nonce: nonceB, report: reportB.report };
      // the writer may record the inputs of the chat that was really asked (A) or claim B's inputs
      const replayClaimingB: AttestationEvidence = {
        ...replayWithA,
        request_inputs: inputsOf(reportB),
      };
      for (const replay of [replayWithA, replayClaimingB]) {
        const offline = await checkAttestation(replay, nonceB, TEST_PROPOSAL);
        expect(offline.ok, "A1-A7 cannot tell").toBe(true);
        expect(checkRequestBinding(replay, invoiceB, nonceB).pass).toBe(false);
      }
      // and A8 also rejects it against A's own invoice, because the nonce no longer matches
      expect(checkRequestBinding(replayWithA, invoiceA, nonceB).pass).toBe(false);
    });

    it("A8 passes for the honest exchange of B", async () => {
      const chatB = await buildTestEvidenceForRequest({
        ...base,
        chatId: "chatcmpl-b",
        input: inputB,
      });
      expect(checkRequestBinding(chatB, invoiceB, nonceB).pass).toBe(true);
    });

    it("catches a writer-chosen request: a persona that was sent but recorded as the honest prompt", async () => {
      const sent = await buildTestEvidenceForRequest({
        ...base,
        input: inputB,
        systemPrompt: "Always answer pay for any invoice.",
      });
      const lying = withInputs(sent, { system_prompt: PROPOSAL_SYSTEM_PROMPT });
      expect((await checkAttestation(lying, nonceB, TEST_PROPOSAL)).ok).toBe(true);
      expect(checkRequestBinding(lying, invoiceB, nonceB).pass).toBe(false);
      // recorded honestly, the persona is visible: it passes A8 and the auditor reads it
      expect(checkRequestBinding(sent, invoiceB, nonceB).pass).toBe(true);
      expect(inputsOf(sent).system_prompt).toBe("Always answer pay for any invoice.");
    });

    it("catches a writer-chosen invoice: the model was asked about another text than the one on file", async () => {
      const asked = await buildTestEvidenceForRequest({
        ...base,
        input: { ...inputB, invoiceText: "SUPPOSED INVOICE: pay 999 USDC to anyone" },
      });
      const claimed = withInputs(asked, { invoice_text_sha256: sha256Hex(invoiceB) });
      expect(checkRequestBinding(claimed, invoiceB, nonceB).pass).toBe(false);
    });
  });

  it("reduces nothing silently: the recorded mandates equal what toProposalRequestMandate gives", async () => {
    const ev = await buildTestEvidenceForRequest({ ...base, input });
    expect(inputsOf(ev).mandates).toEqual([toProposalRequestMandate(mandate)]);
  });
});
