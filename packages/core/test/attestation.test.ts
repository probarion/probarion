import { secp256k1 } from "@noble/curves/secp256k1.js";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { checkAttestation, extractReportDataFromQuote, parseTdxQuote } from "../src/attestation.js";
import { sha256Hex } from "../src/hash.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";
import { computeNonce } from "../src/ledger.js";
import type { AttestationEvidence, AttestationResult, Hex32, ModelProposal } from "../src/types.js";
import {
  buildTestEvidence,
  fixtureChatCompletion,
  fixtureQuoteHex,
  reportDataFor,
  TEST_PROPOSAL,
} from "./fixtures/evidence.js";
import { TEST_OTHER_TEE_PRIVATE_KEY, TEST_TEE_ADDRESS } from "./fixtures/keys.js";

const NONCE = sha256Hex("probarion/test-fixture/nonce");
const OTHER_ADDRESS = privateKeyToAccount(TEST_OTHER_TEE_PRIVATE_KEY).address;
const VAULT = "acme.vaults.probarion.testnet";
const base = {
  nonce: NONCE,
  requestBody: '{"fixture":"request"}',
  chatId: "chatcmpl-test-fixture-1",
  fetchedAt: "2026-11-05T10:00:00.000Z",
};
const ALL_PASS = { A1: true, A2: true, A3: true, A4: true, A5: true, A6: true, A7: true };

/** checkAttestation with the nonce and the recorded proposal the base fixture was built for. */
function check(
  ev: AttestationEvidence,
  nonce: Hex32 = NONCE,
  proposal: ModelProposal | null = TEST_PROPOSAL,
): Promise<AttestationResult> {
  return checkAttestation(ev, nonce, proposal);
}

function verdicts(r: AttestationResult): Record<string, boolean> {
  return Object.fromEntries(r.checks.map((c) => [c.id, c.pass]));
}

function details(r: AttestationResult): string {
  return r.checks.map((c) => c.detail).join(" | ");
}

function detailOf(r: AttestationResult, id: string): string {
  return r.checks.find((c) => c.id === id)?.detail ?? "";
}

function withReport(
  ev: AttestationEvidence,
  patch: Partial<NonNullable<AttestationEvidence["report"]>>,
): AttestationEvidence {
  if (ev.report === null) throw new Error("fixture has no report");
  return { ...ev, report: { ...ev.report, ...patch } };
}

describe("checkAttestation (A1–A7)", () => {
  // probarion-claim: V-ATTEST
  it("passes every check for a well-formed TEST FIXTURE and reports A1..A7 in order", async () => {
    const ev = await buildTestEvidence(base);
    const r = await check(ev);
    expect(r).toMatchObject({ ok: true, binding: "address", quote_verified: false });
    expect(r.checks.map((c) => c.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7"]);
    expect(verdicts(r)).toEqual(ALL_PASS);
    expect(ev.model).toContain("test-fixture");
  });

  it("never claims the TDX quote was verified: quote_verified is false even when every check passes", async () => {
    const r = await check(await buildTestEvidence(base));
    expect(r.ok).toBe(true);
    expect(r.quote_verified).toBe(false);
  });

  it("A1 fails when the text is not <model>:<request_sha256>:<response_sha256>", async () => {
    const ev = await buildTestEvidence(base);
    const r = await check({ ...ev, response_sha256: sha256Hex("other response") });
    expect(verdicts(r)).toMatchObject({ A1: false, A2: true });
    expect(r.ok).toBe(false);
  });

  it("A2 fails when another key signed the text", async () => {
    const ev = await buildTestEvidence(base);
    const forged = await privateKeyToAccount(TEST_OTHER_TEE_PRIVATE_KEY).signMessage({
      message: ev.signature.text,
    });
    const r = await check({ ...ev, signature: { ...ev.signature, signature: forged } });
    expect(verdicts(r)).toMatchObject({ A2: false, A3: true });
  });

  it("A2 accepts a signature without the 0x prefix", async () => {
    const ev = await buildTestEvidence(base);
    const bare = ev.signature.signature.slice(2);
    const r = await check({ ...ev, signature: { ...ev.signature, signature: bare } });
    expect(verdicts(r).A2).toBe(true);
  });

  it("A3 fails when the report names another signer", async () => {
    const ev = await buildTestEvidence({ ...base, reportSigner: OTHER_ADDRESS });
    expect(verdicts(await check(ev)).A3).toBe(false);
  });

  it("A3 fails when the report's signing_algo is not ecdsa", async () => {
    const ev = await buildTestEvidence(base);
    const r = await check(withReport(ev, { signing_algo: "ed25519" as unknown as "ecdsa" }));
    expect(verdicts(r).A3).toBe(false);
  });

  it("A4 fails and reports binding tls when bytes 0..31 are not the padded signer", async () => {
    const tlsLike = `${sha256Hex("signer||tls-fingerprint")}${NONCE}`;
    const ev = await buildTestEvidence({ ...base, reportDataOverride: tlsLike });
    const r = await check(ev);
    expect(r.binding).toBe("tls");
    expect(verdicts(r)).toMatchObject({ A4: false, A5: true });
  });

  it("A5 fails when the report carries another nonce", async () => {
    const ev = await buildTestEvidence({ ...base, reportNonce: sha256Hex("stale nonce") });
    expect(verdicts(await check(ev))).toMatchObject({ A5: false, A6: true });
  });

  it("A5 fails when only the report's request_nonce differs", async () => {
    const ev = await buildTestEvidence({
      ...base,
      requestNonceOverride: sha256Hex("other request nonce"),
    });
    const r = await check(ev);
    expect(verdicts(r).A5).toBe(false);
    expect(details(r)).toContain("request_nonce");
  });

  it("A6 fails when the ledger context gives another nonce", async () => {
    const ev = await buildTestEvidence(base);
    const r = await check(ev, sha256Hex("another ledger position"));
    expect(verdicts(r)).toEqual({ ...ALL_PASS, A6: false });
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
    expect((await check(ev, computeNonce({ ...position, vault: VAULT }))).ok).toBe(true);
    const other = await check(
      ev,
      computeNonce({ ...position, vault: "other.vaults.probarion.testnet" }),
    );
    expect(verdicts(other)).toEqual({ ...ALL_PASS, A6: false });
  });

  it("A3–A5 fail without a report, and the entry is called unattested", async () => {
    const ev = await buildTestEvidence({ ...base, withReport: false });
    const r = await check(ev);
    expect(r.binding).toBe("none");
    expect(verdicts(r)).toMatchObject({ A3: false, A4: false, A5: false });
    expect(details(r)).toContain("unattested");
  });

  it("A4 and A5 fail when report_data does not match the bytes inside the quote", async () => {
    const ev = await buildTestEvidence(base);
    const elsewhere = fixtureQuoteHex(reportDataFor(TEST_TEE_ADDRESS, sha256Hex("different")));
    const r = await check(withReport(ev, { intel_quote: elsewhere }));
    expect(verdicts(r)).toMatchObject({ A4: false, A5: false });
    expect(details(r)).toContain("intel_quote");
  });

  it("accepts the same evidence carried in a TDX quote v5", async () => {
    const ev = await buildTestEvidence({ ...base, quoteVersion: 5 });
    expect(parseTdxQuote(ev.report?.intel_quote ?? "")?.version).toBe(5);
    expect((await check(ev)).ok).toBe(true);
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
      mangle({ response_body: undefined }),
      mangle({ response_body: 7, chat_id: null }),
    ];
    for (const bad of cases) {
      const r = await check(bad);
      expect(r.ok).toBe(false);
      expect(r.checks.map((c) => c.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7"]);
    }
  });

  it("A3 does not pass on two equal junk signers", async () => {
    const ev = await buildTestEvidence(base);
    const junk = { ...ev, signature: { ...ev.signature, signing_address: "" } };
    const r = await check(withReport(junk, { signing_address: "" }));
    expect(verdicts(r)).toMatchObject({ A2: false, A3: false });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "evidence"],
    ["a number", 7],
    ["an array", []],
    ["a boolean", true],
  ])("returns all seven checks failed, and does not throw, for %s", async (_name, value) => {
    const r = await check(value as unknown as AttestationEvidence);
    expect(r).toMatchObject({ ok: false, binding: "none", quote_verified: false });
    expect(r.checks.map((c) => c.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7"]);
    expect(r.checks.every((c) => !c.pass)).toBe(true);
  });
});

describe("A2 accepts low-s signatures with v 0, 1, 27 or 28, and refuses high-s and any other v", () => {
  const N = secp256k1.Point.Fn.ORDER;
  const hex32 = (n: bigint): string => n.toString(16).padStart(64, "0");
  const hexByte = (n: number): string => n.toString(16).padStart(2, "0");
  const parts = (signature: string): { r: string; s: bigint; v: number } => ({
    r: signature.slice(2, 66),
    s: BigInt(`0x${signature.slice(66, 130)}`),
    v: Number.parseInt(signature.slice(130, 132), 16),
  });
  const withSignature = (ev: AttestationEvidence, signature: string): AttestationEvidence => ({
    ...ev,
    signature: { ...ev.signature, signature },
  });

  it("the TEST FIXTURE signature is low-s with v 27 or 28 (precondition for the variants below)", async () => {
    const ev = await buildTestEvidence(base);
    const { s, v } = parts(ev.signature.signature);
    expect(s <= N / 2n).toBe(true);
    expect([27, 28]).toContain(v);
  });

  it("accepts the 0/1 spelling of v: it is the same recovery id as 27/28", async () => {
    const ev = await buildTestEvidence(base);
    const { r, s, v } = parts(ev.signature.signature);
    const parity = `0x${r}${hex32(s)}${hexByte(v - 27)}`; // v 27 -> 00, v 28 -> 01
    expect(parity).not.toBe(ev.signature.signature);
    // the whole evidence passes with the signature spelled either way
    expect(verdicts(await check(withSignature(ev, parity)))).toEqual(ALL_PASS);
    expect(verdicts(await check(withSignature(ev, ev.signature.signature)))).toEqual(ALL_PASS);
    // the same spelling without the 0x prefix
    expect(verdicts(await check(withSignature(ev, parity.slice(2)))).A2).toBe(true);
  });

  it("the other recovery id recovers to someone else and fails, in both spellings", async () => {
    const ev = await buildTestEvidence(base);
    const { r, s, v } = parts(ev.signature.signature);
    for (const wrong of [hexByte(55 - v), hexByte(28 - v)]) {
      // 55 - 27 = 28 and 55 - 28 = 27 (the 27/28 spelling); 28 - v is the 0/1 spelling of the other id
      const result = await check(withSignature(ev, `0x${r}${hex32(s)}${wrong}`));
      expect(verdicts(result).A2).toBe(false);
    }
  });

  it("rejects the high-s twin (n - s, flipped v) although it recovers to the same signer", async () => {
    const ev = await buildTestEvidence(base);
    const { r, s, v } = parts(ev.signature.signature);
    const twin = `0x${r}${hex32(N - s)}${hexByte(v === 27 ? 28 : 27)}`;
    // the twin is a second, byte-different valid signature of the same text by the same key
    expect(twin).not.toBe(ev.signature.signature);
    expect(
      await recoverMessageAddress({
        message: ev.signature.text,
        signature: twin as `0x${string}`,
      }),
    ).toBe(ev.signature.signing_address);
    const result = await check(withSignature(ev, twin));
    expect(verdicts(result)).toEqual({ ...ALL_PASS, A2: false });
    expect(detailOf(result, "A2")).toContain("high-s");
    // the twin in the 0/1 spelling is refused too
    const twinParity = `0x${r}${hex32(N - s)}${hexByte(v === 27 ? 1 : 0)}`;
    expect(verdicts(await check(withSignature(ev, twinParity))).A2).toBe(false);
  });

  it("rejects every v other than 0, 1, 27 and 28 (2, 26, 29, 35, 255)", async () => {
    const ev = await buildTestEvidence(base);
    const { r, s } = parts(ev.signature.signature);
    for (const vByte of ["02", "1a", "1d", "23", "ff"]) {
      const result = await check(withSignature(ev, `0x${r}${hex32(s)}${vByte}`));
      expect(verdicts(result).A2).toBe(false);
    }
  });

  it("rejects s = 0 and s above n/2 whatever the spelling of v", async () => {
    const ev = await buildTestEvidence(base);
    const { r } = parts(ev.signature.signature);
    for (const s of [0n, N / 2n + 1n, N - 1n]) {
      for (const vByte of ["00", "01", "1b", "1c"]) {
        const result = await check(withSignature(ev, `0x${r}${hex32(s)}${vByte}`));
        expect(verdicts(result).A2).toBe(false);
      }
    }
  });
});

// ICR-2: A7 binds the signed response body to response_sha256, to the chat id and to the recorded proposal.
describe("A7 response binding", () => {
  const payProposal = TEST_PROPOSAL;
  const refuseProposal: ModelProposal = {
    action: "refuse",
    mandate_id: null,
    amount: null,
    payee_hint: null,
    reasoning: "TEST FIXTURE: the invoice names a payee the mandate does not pay.",
    confidence: 0.97,
  };

  it("passes when the signed response holds exactly the recorded proposal", async () => {
    const r = await check(await buildTestEvidence(base), NONCE, payProposal);
    expect(verdicts(r).A7).toBe(true);
    expect(detailOf(r, "A7")).toContain("recorded proposal");
  });

  it("fails a swapped proposal: the ledger says pay, the signed model answer was refuse", async () => {
    const ev = await buildTestEvidence({ ...base, proposal: refuseProposal });
    const r = await check(ev, NONCE, payProposal);
    expect(verdicts(r)).toEqual({ ...ALL_PASS, A7: false });
    expect(detailOf(r, "A7")).toContain("differs from the recorded proposal");
    expect(r.ok).toBe(false);
    // the honest record passes
    expect((await check(ev, NONCE, refuseProposal)).ok).toBe(true);
  });

  it("fails a tampered response_body because its hash differs from response_sha256", async () => {
    const ev = await buildTestEvidence(base);
    const tampered = { ...ev, response_body: ev.response_body.replace("Matches", "Mismatches") };
    expect(tampered.response_body).not.toBe(ev.response_body);
    const r = await check(tampered);
    expect(verdicts(r)).toEqual({ ...ALL_PASS, A7: false });
    expect(detailOf(r, "A7")).toContain("response_sha256");
  });

  it("fails when the id inside the response body is not the chat_id", async () => {
    const ev = await buildTestEvidence(base);
    const r = await check({ ...ev, chat_id: "chatcmpl-some-other-chat" });
    expect(verdicts(r)).toEqual({ ...ALL_PASS, A7: false });
    expect(detailOf(r, "A7")).toContain("chat_id");
  });

  it("fails with 'no recorded proposal to bind' when the entry has no proposal", async () => {
    const r = await check(await buildTestEvidence(base), NONCE, null);
    expect(verdicts(r)).toEqual({ ...ALL_PASS, A7: false });
    expect(detailOf(r, "A7")).toBe("no recorded proposal to bind");
  });

  it("fails when the response content holds no valid proposal", async () => {
    for (const responseBody of [
      fixtureChatCompletion({ chatId: base.chatId, content: "I cannot help with that." }),
      fixtureChatCompletion({ chatId: base.chatId, content: '{"action":"send"}' }),
      JSON.stringify({ id: base.chatId, choices: [] }),
      JSON.stringify({ id: base.chatId, choices: [{ message: { content: null } }] }),
      JSON.stringify([base.chatId]),
      "not json at all",
    ]) {
      const r = await check(await buildTestEvidence({ ...base, responseBody }));
      expect(verdicts(r)).toEqual({ ...ALL_PASS, A7: false });
    }
  });

  it("reads the proposal through extractJsonObject: prose and <think> blocks around the JSON are fine", async () => {
    const content = `<think>maybe {"action":"refuse"}</think>Here it is: ${JSON.stringify(payProposal)} done`;
    const ev = await buildTestEvidence({
      ...base,
      responseBody: fixtureChatCompletion({ chatId: base.chatId, content }),
    });
    expect(verdicts(await check(ev)).A7).toBe(true);
  });

  it("compares by canonicalJson: key order in the recorded proposal does not matter, a different value does", async () => {
    const ev = await buildTestEvidence(base);
    const reordered = Object.fromEntries(Object.entries(payProposal).reverse()) as ModelProposal;
    expect(verdicts(await check(ev, NONCE, reordered)).A7).toBe(true);
    expect(verdicts(await check(ev, NONCE, { ...payProposal, confidence: 0.93 })).A7).toBe(false);
    expect(
      verdicts(await check(ev, NONCE, { ...payProposal, extra: 1 } as unknown as ModelProposal)).A7,
    ).toBe(false);
  });

  it("an attacker who rewrites response_body and response_sha256 together is caught by A1 (the signed text names the old hash)", async () => {
    const real = await buildTestEvidence({ ...base, proposal: refuseProposal });
    const rewritten = fixtureChatCompletion({ chatId: base.chatId, proposal: payProposal });
    const forged: AttestationEvidence = {
      ...real,
      response_body: rewritten,
      response_sha256: sha256Hex(rewritten),
    };
    const r = await check(forged, NONCE, payProposal);
    expect(verdicts(r)).toMatchObject({ A1: false, A7: true });
    expect(r.ok).toBe(false);
  });

  describe("replay: a chat from one position paired with a report fetched for another", () => {
    const position = { prev_link: "0".repeat(64), mandate_id: 1, seq: 0 };
    const nonceA = computeNonce({
      ...position,
      invoice_hash: sha256Hex("invoice A"),
      vault: "a.vaults.probarion.testnet",
    });
    const nonceB = computeNonce({
      ...position,
      invoice_hash: sha256Hex("invoice B"),
      vault: "b.vaults.probarion.testnet",
    });

    it("is caught by A7 whenever the replayed response's proposal differs from the entry's recorded proposal", async () => {
      const chatA = await buildTestEvidence({
        ...base,
        nonce: nonceA,
        chatId: "chatcmpl-a",
        proposal: payProposal,
      });
      const reportB = await buildTestEvidence({
        ...base,
        nonce: nonceB,
        chatId: "chatcmpl-b",
        proposal: refuseProposal,
      });
      // chat signature and response of A, report fetched for B's nonce, evidence nonce set to B's
      const replay: AttestationEvidence = { ...chatA, nonce: nonceB, report: reportB.report };
      const r = await check(replay, nonceB, refuseProposal);
      expect(verdicts(r)).toEqual({ ...ALL_PASS, A7: false });
    });

    // Known limit of the offline checks, kept as a test so it cannot be forgotten: when both positions
    // hold the same proposal, the replayed chat looks exactly like a genuine one to A1-A7. Only the
    // auditor check A8 (request_sha256 recomputed from the invoice document, which carries the nonce in
    // its system message) can tell, and the ledger does not hold invoice text.
    it("is NOT caught offline when the proposal is identical: that case is A8's, run by an auditor", async () => {
      const chatA = await buildTestEvidence({
        ...base,
        nonce: nonceA,
        chatId: "chatcmpl-a",
        proposal: payProposal,
      });
      const reportB = await buildTestEvidence({
        ...base,
        nonce: nonceB,
        chatId: "chatcmpl-b",
        proposal: payProposal,
      });
      const replay: AttestationEvidence = { ...chatA, nonce: nonceB, report: reportB.report };
      const r = await check(replay, nonceB, payProposal);
      expect(verdicts(r)).toEqual(ALL_PASS);
      expect(r.quote_verified).toBe(false);
    });

    it.todo(
      "A8 (auditor, plan 03 Task 7/14): rebuild the chat request from the invoice document and the recorded inputs, compare its sha256 with request_sha256, and catch the identical-proposal replay",
    );
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
    expect(parseTdxQuote(7 as unknown as string)).toBeNull();
  });

  describe("TEE type", () => {
    const quoteWith = (version: 4 | 5, patch: (view: DataView) => void): string => {
      const bytes = hexToBytes(fixtureQuoteHex(rd, version));
      patch(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return bytesToHex(bytes);
    };

    it("v4 needs tee_type 0x81 (u32 little-endian at bytes 4..8)", () => {
      const quote = fixtureQuoteHex(rd, 4);
      expect(bytesToHex(hexToBytes(quote).slice(4, 8))).toBe("81000000");
      expect(parseTdxQuote(quote)?.version).toBe(4);
      for (const teeType of [0x00, 0x01, 0x80, 0x82, 0x81000000]) {
        expect(parseTdxQuote(quoteWith(4, (v) => v.setUint32(4, teeType, true)))).toBeNull();
      }
    });

    it("v5 needs body type 2 or 3 (u16 little-endian at bytes 48..50)", () => {
      for (const bodyType of [2, 3]) {
        const quote = quoteWith(5, (v) => v.setUint16(48, bodyType, true));
        expect(parseTdxQuote(quote)).toEqual({ version: 5, bodyOffset: 54, reportData: rd });
      }
      for (const bodyType of [0, 1, 4, 0x0200]) {
        expect(parseTdxQuote(quoteWith(5, (v) => v.setUint16(48, bodyType, true)))).toBeNull();
      }
    });

    it("A4 and A5 fail, citing intel_quote, when the quote is an SGX quote", async () => {
      const ev = await buildTestEvidence(base);
      const sgx = quoteWith(4, (v) => v.setUint32(4, 0, true));
      const r = await check(withReport(ev, { intel_quote: sgx }));
      expect(verdicts(r)).toMatchObject({ A4: false, A5: false });
      expect(details(r)).toContain("intel_quote");
    });
  });
});
