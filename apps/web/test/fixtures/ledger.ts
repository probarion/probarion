import { createEd25519Signer, generateKeyPair, type LedgerEntryBody } from "@probarion/core";

export type AppendBody = Omit<LedgerEntryBody, "seq" | "prev_link">;

export function appendBody(vault: string, over: Partial<AppendBody> = {}): AppendBody {
  return {
    v: 1,
    vault,
    kind: "decision",
    at: "2026-11-08T10:00:00.000Z",
    request_id: "req-1",
    mandate_id: 1,
    invoice_hash: "a".repeat(64),
    amount: "25000000",
    proposal: null,
    evidence: null,
    rules: [{ id: "mandate.none", outcome: "pass", detail: "mandate 1 matched" }],
    verdict: "allow",
    decided_by: "rules-only",
    contract: null,
    settlement: null,
    refs: null,
    ...over,
  };
}

/** A ledger key made and used exactly as the SDK does (core's keys module). */
export function testSigner() {
  const kp = generateKeyPair();
  return { publicKey: kp.publicKey, sign: createEd25519Signer(kp.secretKey) };
}
