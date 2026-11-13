import { readFileSync } from "node:fs";
import {
  type AttestationEvidence,
  checkAttestation,
  checkRequestBinding,
  computeBodyHash,
  computeNonce,
  type LedgerEntry,
  type NonceContext,
  parseModelProposal,
  sha256Hex,
} from "@probarion/core";
import { describe, expect, it } from "vitest";

// A real attested decision, in the shape scripts/record-nearai.ts writes: entry 4 of the mainnet ledger of
// v0.probarion.near (S2, 2026-11-13) and its invoice INV-M003, both committed under docs/evidence. INV-M003 is
// a labeled test paid to the owner's own Base address. Offline: no network is used here.
const recorded = new URL("./fixtures/nearai-recorded/decision.json", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);
const rec = JSON.parse(readFileSync(recorded, "utf8")) as {
  source: { ledger: string; seq: number; body_hash: string; invoice: string };
  context: NonceContext;
  invoice_text: string;
  evidence: AttestationEvidence;
  proposal: unknown;
};

describe("recorded NEAR AI Cloud decision (real attestation: mainnet ledger entry 4 of v0.probarion.near)", () => {
  it("has the context, proposal, evidence and invoice of entry 4 of the committed mainnet ledger", () => {
    // scripts/record-nearai.ts writes to this same path, with no source block.
    expect(
      rec.source,
      "decision.json has no source block: record:nearai may have overwritten it; restore it with git",
    ).toBeDefined();
    const lines = readFileSync(new URL(rec.source.ledger, repoRoot), "utf8").split("\n");
    const entry = JSON.parse(lines[rec.source.seq] ?? "null") as LedgerEntry;
    const body = entry.body;
    expect(body).toMatchObject({
      seq: 4,
      kind: "decision",
      verdict: "allow",
      decided_by: "model+rules",
    });
    // The body hash is spend 3's decision_hash on chain (docs/evidence/mainnet-v0/s2-2026-11-13/README.md).
    expect(rec.source.body_hash).toBe(
      "d3807956b1e0a0481656862a50a2147d2b0a1f04834a30829529311c9cec32aa",
    );
    expect(computeBodyHash(body)).toBe(rec.source.body_hash);
    expect(entry.body_hash).toBe(rec.source.body_hash);
    expect(rec.context).toEqual({
      vault: body.vault,
      prev_link: body.prev_link,
      invoice_hash: body.invoice_hash,
      mandate_id: body.mandate_id,
      seq: body.seq,
    });
    expect(rec.evidence).toEqual(body.evidence);
    expect(rec.proposal).toEqual(body.proposal);
    expect(readFileSync(new URL(rec.source.invoice, repoRoot), "utf8")).toBe(rec.invoice_text);
  });

  it("passes A1-A7 offline against the recomputed ledger nonce", async () => {
    const nonce = computeNonce(rec.context);
    expect(rec.evidence.nonce).toBe(nonce);
    const proposal = parseModelProposal(rec.proposal);
    const result = await checkAttestation(rec.evidence, nonce, proposal);
    expect(result.checks.filter((c) => !c.pass)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("passes the request binding A8 with the committed invoice text", () => {
    expect(sha256Hex(rec.invoice_text)).toBe(rec.evidence.request_inputs?.invoice_text_sha256);
    expect(sha256Hex(rec.invoice_text)).toBe(rec.context.invoice_hash);
    const a8 = checkRequestBinding(rec.evidence, rec.invoice_text, rec.context);
    expect(a8).toMatchObject({ id: "A8", pass: true });
  });
});
