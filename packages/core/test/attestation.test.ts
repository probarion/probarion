import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { checkAttestation, extractReportDataFromQuote, parseTdxQuote } from "../src/attestation.js";
import { sha256Hex } from "../src/hash.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";
import { computeNonce } from "../src/ledger.js";
import type { AttestationEvidence, AttestationResult } from "../src/types.js";
import { buildTestEvidence, fixtureQuoteHex, reportDataFor } from "./fixtures/evidence.js";
import { TEST_OTHER_TEE_PRIVATE_KEY, TEST_TEE_ADDRESS } from "./fixtures/keys.js";

const NONCE = sha256Hex("probarion/test-fixture/nonce");
const OTHER_ADDRESS = privateKeyToAccount(TEST_OTHER_TEE_PRIVATE_KEY).address;
const VAULT = "acme.vaults.probarion.testnet";
const base = {
  nonce: NONCE,
  requestBody: '{"fixture":"request"}',
  responseBody: '{"fixture":"response"}',
  chatId: "chatcmpl-test-fixture-1",
  fetchedAt: "2026-11-05T10:00:00.000Z",
};

function verdicts(r: AttestationResult): Record<string, boolean> {
  return Object.fromEntries(r.checks.map((c) => [c.id, c.pass]));
}

function details(r: AttestationResult): string {
  return r.checks.map((c) => c.detail).join(" | ");
}

function withReport(
  ev: AttestationEvidence,
  patch: Partial<NonNullable<AttestationEvidence["report"]>>,
): AttestationEvidence {
  if (ev.report === null) throw new Error("fixture has no report");
  return { ...ev, report: { ...ev.report, ...patch } };
}

describe("checkAttestation (A1–A6)", () => {
  // probarion-claim: V-ATTEST
  it("passes every check for a well-formed TEST FIXTURE and reports A1..A6 in order", async () => {
    const ev = await buildTestEvidence(base);
    const r = await checkAttestation(ev, NONCE);
    expect(r).toMatchObject({ ok: true, binding: "address" });
    expect(r.checks.map((c) => c.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"]);
    expect(verdicts(r)).toEqual({ A1: true, A2: true, A3: true, A4: true, A5: true, A6: true });
    expect(ev.model).toContain("test-fixture");
  });

  it("A1 fails when the text is not <model>:<request_sha256>:<response_sha256>", async () => {
    const ev = await buildTestEvidence(base);
    const r = await checkAttestation(
      { ...ev, response_sha256: sha256Hex("other response") },
      NONCE,
    );
    expect(verdicts(r)).toMatchObject({ A1: false, A2: true });
    expect(r.ok).toBe(false);
  });

  it("A2 fails when another key signed the text", async () => {
    const ev = await buildTestEvidence(base);
    const forged = await privateKeyToAccount(TEST_OTHER_TEE_PRIVATE_KEY).signMessage({
      message: ev.signature.text,
    });
    const r = await checkAttestation(
      { ...ev, signature: { ...ev.signature, signature: forged } },
      NONCE,
    );
    expect(verdicts(r)).toMatchObject({ A2: false, A3: true });
  });

  it("A2 accepts a signature without the 0x prefix", async () => {
    const ev = await buildTestEvidence(base);
    const bare = ev.signature.signature.slice(2);
    const r = await checkAttestation(
      { ...ev, signature: { ...ev.signature, signature: bare } },
      NONCE,
    );
    expect(verdicts(r).A2).toBe(true);
  });

  it("A3 fails when the report names another signer", async () => {
    const ev = await buildTestEvidence({ ...base, reportSigner: OTHER_ADDRESS });
    expect(verdicts(await checkAttestation(ev, NONCE)).A3).toBe(false);
  });

  it("A3 fails when the report's signing_algo is not ecdsa", async () => {
    const ev = await buildTestEvidence(base);
    const r = await checkAttestation(
      withReport(ev, { signing_algo: "ed25519" as unknown as "ecdsa" }),
      NONCE,
    );
    expect(verdicts(r).A3).toBe(false);
  });

  it("A4 fails and reports binding tls when bytes 0..31 are not the padded signer", async () => {
    const tlsLike = `${sha256Hex("signer||tls-fingerprint")}${NONCE}`;
    const ev = await buildTestEvidence({ ...base, reportDataOverride: tlsLike });
    const r = await checkAttestation(ev, NONCE);
    expect(r.binding).toBe("tls");
    expect(verdicts(r)).toMatchObject({ A4: false, A5: true });
  });

  it("A5 fails when the report carries another nonce", async () => {
    const ev = await buildTestEvidence({ ...base, reportNonce: sha256Hex("stale nonce") });
    expect(verdicts(await checkAttestation(ev, NONCE))).toMatchObject({ A5: false, A6: true });
  });

  it("A5 fails when only the report's request_nonce differs", async () => {
    const ev = await buildTestEvidence({
      ...base,
      requestNonceOverride: sha256Hex("other request nonce"),
    });
    const r = await checkAttestation(ev, NONCE);
    expect(verdicts(r).A5).toBe(false);
    expect(details(r)).toContain("request_nonce");
  });

  it("A6 fails when the ledger context gives another nonce", async () => {
    const ev = await buildTestEvidence(base);
    const r = await checkAttestation(ev, sha256Hex("another ledger position"));
    expect(verdicts(r)).toEqual({ A1: true, A2: true, A3: true, A4: true, A5: true, A6: false });
  });

  // ICR-1: the recomputed nonce includes the vault account id, so evidence cannot be replayed across vaults.
  it("A6 binds the vault: evidence made for one vault's ledger position fails in another vault's", async () => {
    const position = {
      prev_link: "0".repeat(64),
      invoice_hash: sha256Hex("invoice"),
      mandate_id: 1,
      seq: 0,
    };
    const nonce = computeNonce({ ...position, vault: VAULT });
    const ev = await buildTestEvidence({ ...base, nonce });
    expect((await checkAttestation(ev, computeNonce({ ...position, vault: VAULT }))).ok).toBe(true);
    const other = await checkAttestation(
      ev,
      computeNonce({ ...position, vault: "other.vaults.probarion.testnet" }),
    );
    expect(verdicts(other)).toEqual({
      A1: true,
      A2: true,
      A3: true,
      A4: true,
      A5: true,
      A6: false,
    });
  });

  it("A3–A5 fail without a report, and the entry is called unattested", async () => {
    const ev = await buildTestEvidence({ ...base, withReport: false });
    const r = await checkAttestation(ev, NONCE);
    expect(r.binding).toBe("none");
    expect(verdicts(r)).toMatchObject({ A3: false, A4: false, A5: false });
    expect(details(r)).toContain("unattested");
  });

  it("A4 and A5 fail when report_data does not match the bytes inside the quote", async () => {
    const ev = await buildTestEvidence(base);
    const elsewhere = fixtureQuoteHex(reportDataFor(TEST_TEE_ADDRESS, sha256Hex("different")));
    const r = await checkAttestation(withReport(ev, { intel_quote: elsewhere }), NONCE);
    expect(verdicts(r)).toMatchObject({ A4: false, A5: false });
    expect(details(r)).toContain("intel_quote");
  });

  it("accepts the same evidence carried in a TDX quote v5", async () => {
    const ev = await buildTestEvidence({ ...base, quoteVersion: 5 });
    expect(parseTdxQuote(ev.report?.intel_quote ?? "")?.version).toBe(5);
    expect((await checkAttestation(ev, NONCE)).ok).toBe(true);
  });

  it("fails checks instead of throwing when ledger JSON carries wrong-typed evidence fields", async () => {
    const ev = await buildTestEvidence(base);
    const mangle = (patch: Record<string, unknown>): AttestationEvidence =>
      ({ ...ev, ...patch }) as unknown as AttestationEvidence;
    const cases: AttestationEvidence[] = [
      mangle({ signature: null }),
      mangle({ signature: { ...ev.signature, signing_address: 7, text: null, signature: {} } }),
      mangle({ report: { ...ev.report, signing_address: null, report_data: 7, intel_quote: 7 } }),
      mangle({ report: { ...ev.report, intel_quote: undefined } }),
      mangle({ report: undefined }),
    ];
    for (const bad of cases) {
      const r = await checkAttestation(bad, NONCE);
      expect(r.ok).toBe(false);
      expect(r.checks.map((c) => c.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"]);
    }
  });

  it("A3 does not pass on two equal junk signers", async () => {
    const ev = await buildTestEvidence(base);
    const junk = { ...ev, signature: { ...ev.signature, signing_address: "" } };
    const r = await checkAttestation(withReport(junk, { signing_address: "" }), NONCE);
    expect(verdicts(r)).toMatchObject({ A2: false, A3: false });
  });
});

describe("parseTdxQuote (report_data = TD report body bytes [520, 584))", () => {
  const rd = reportDataFor(TEST_TEE_ADDRESS, NONCE);

  it("reads report_data at quote bytes 568..632 for a v4 quote", () => {
    const quote = fixtureQuoteHex(rd, 4);
    expect(parseTdxQuote(quote)).toEqual({ version: 4, bodyOffset: 48, reportData: rd });
    expect(bytesToHex(hexToBytes(quote).slice(568, 632))).toBe(rd);
    expect(extractReportDataFromQuote(quote)).toBe(rd);
  });

  it("reads report_data at quote bytes 574..638 for a v5 quote", () => {
    const quote = fixtureQuoteHex(rd, 5);
    expect(parseTdxQuote(quote)).toEqual({ version: 5, bodyOffset: 54, reportData: rd });
    expect(bytesToHex(hexToBytes(quote).slice(574, 638))).toBe(rd);
  });

  it("returns null for an unknown version, a short quote or non-hex input", () => {
    const v3 = hexToBytes(fixtureQuoteHex(rd, 4));
    v3[0] = 3;
    expect(parseTdxQuote(bytesToHex(v3))).toBeNull();
    expect(parseTdxQuote(fixtureQuoteHex(rd, 4).slice(0, 1200))).toBeNull();
    expect(parseTdxQuote("not hex")).toBeNull();
    expect(extractReportDataFromQuote("")).toBeNull();
  });
});
