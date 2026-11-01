import { existsSync, readFileSync } from "node:fs";
import {
  type AttestationEvidence,
  checkAttestation,
  checkRequestBinding,
  computeNonce,
  type NonceContext,
  parseModelProposal,
  sha256Hex,
} from "@probarion/core";
import { describe, expect, it } from "vitest";

const recorded = new URL("./fixtures/nearai-recorded/decision.json", import.meta.url);

// Runs only after the OWNER has recorded one real decision (Task 11 Step 7). Offline: no network is used here.
describe.skipIf(!existsSync(recorded))(
  "recorded NEAR AI Cloud decision (real attestation, recorded by the OWNER)",
  () => {
    const rec = existsSync(recorded)
      ? (JSON.parse(readFileSync(recorded, "utf8")) as {
          context: NonceContext;
          invoice_text: string;
          evidence: AttestationEvidence;
          proposal: unknown;
        })
      : null;

    it("passes A1-A7 offline against the recomputed ledger nonce", async () => {
      if (rec === null) throw new Error("unreachable: the suite is skipped without the recording");
      const nonce = computeNonce(rec.context);
      expect(rec.evidence.nonce).toBe(nonce);
      const proposal = parseModelProposal(rec.proposal);
      const result = await checkAttestation(rec.evidence, nonce, proposal);
      expect(result.checks.filter((c) => !c.pass)).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it("passes the request binding A8 with the recorded (synthetic) invoice text", () => {
      if (rec === null) throw new Error("unreachable: the suite is skipped without the recording");
      expect(sha256Hex(rec.invoice_text)).toBe(rec.evidence.request_inputs?.invoice_text_sha256);
      const a8 = checkRequestBinding(rec.evidence, rec.invoice_text, computeNonce(rec.context));
      expect(a8).toMatchObject({ id: "A8", pass: true });
    });
  },
);
