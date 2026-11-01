// TEST FIXTURE attestation builder. The "quote" is a labeled byte string, not a TDX quote, and the
// signer is a local secp256k1 key. Never present this evidence as a real NEAR AI Cloud attestation.
import { privateKeyToAccount } from "viem/accounts";
import {
  TDX_QUOTE_V4_BODY_OFFSET,
  TDX_QUOTE_V5_BODY_OFFSET,
  TDX_REPORT_DATA_BODY_OFFSET,
} from "../../src/attestation.js";
import { sha256Hex } from "../../src/hash.js";
import { bytesToHex, hexToBytes, utf8 } from "../../src/hex.js";
import type { AttestationEvidence, Hex32, ModelProposal } from "../../src/types.js";
import { TEST_TEE_PRIVATE_KEY } from "./keys.js";

export const FIXTURE_LABEL = "TEST FIXTURE: not a real NEAR AI Cloud attestation";
export const TEST_MODEL = "test-fixture/not-a-real-model";
const QUOTE_MARKER = "PROBARION TEST FIXTURE - NOT A TDX QUOTE"; // 40 bytes, written at header bytes 8..48
const TD_REPORT_BODY_LENGTH = 584;

/**
 * Bytes shaped like a TDX quote only where the parser looks: the version (u16 LE at bytes 0–1), the v5 body
 * descriptor, and report_data at body offset 520. Everything else is zero or the marker. Not a real quote.
 */
export function fixtureQuoteHex(reportDataHex: string, version: 4 | 5 = 4): string {
  const bodyOffset = version === 4 ? TDX_QUOTE_V4_BODY_OFFSET : TDX_QUOTE_V5_BODY_OFFSET;
  const bytes = new Uint8Array(bodyOffset + TD_REPORT_BODY_LENGTH);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, version, true);
  bytes.set(utf8(QUOTE_MARKER), 8);
  if (version === 5) {
    view.setUint16(48, 2, true); // body type 2: TD report 1.0
    view.setUint32(50, TD_REPORT_BODY_LENGTH, true);
  }
  bytes.set(hexToBytes(reportDataHex), bodyOffset + TDX_REPORT_DATA_BODY_OFFSET);
  return bytesToHex(bytes);
}

/** The proposal every fixture response carries unless a test passes another one. */
export const TEST_PROPOSAL: ModelProposal = {
  action: "pay",
  mandate_id: 1,
  amount: "25000000",
  payee_hint: { near_account: "vendor.fixture.testnet", name: "Fixture Vendor" },
  reasoning: `${FIXTURE_LABEL}. Matches PO-1001.`,
  confidence: 0.92,
};

/**
 * A chat-completion response body shaped like the OpenAI-compatible one NEAR AI Cloud returns: `id`, `model`
 * and `choices[0].message.content` holding the proposal JSON. `content` replaces the proposal text.
 */
export function fixtureChatCompletion(o: {
  chatId: string;
  model?: string;
  proposal?: ModelProposal;
  content?: string;
}): string {
  return JSON.stringify({
    id: o.chatId,
    object: "chat.completion",
    model: o.model ?? TEST_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: o.content ?? JSON.stringify(o.proposal ?? TEST_PROPOSAL),
        },
        finish_reason: "stop",
      },
    ],
    fixture: FIXTURE_LABEL,
  });
}

/** report_data = 20-byte signer, zero-padded to 32 bytes, then the 32-byte nonce. */
export function reportDataFor(address: string, nonce: Hex32): string {
  return `${address.toLowerCase().slice(2)}${"0".repeat(24)}${nonce}`;
}

export interface TestEvidenceOptions {
  nonce: Hex32;
  requestBody: string;
  chatId: string;
  /** The proposal the fixture model answers with; default TEST_PROPOSAL. */
  proposal?: ModelProposal;
  /** The exact response body, replacing the generated chat completion (tampering and malformed-response tests). */
  responseBody?: string;
  fetchedAt: string;
  teePrivateKey?: `0x${string}`;
  model?: string;
  reportNonce?: Hex32;
  requestNonceOverride?: Hex32;
  reportSigner?: string;
  reportDataOverride?: string;
  quoteVersion?: 4 | 5;
  withReport?: boolean;
}

export async function buildTestEvidence(o: TestEvidenceOptions): Promise<AttestationEvidence> {
  const account = privateKeyToAccount(o.teePrivateKey ?? TEST_TEE_PRIVATE_KEY);
  const model = o.model ?? TEST_MODEL;
  const requestSha = sha256Hex(o.requestBody);
  const responseBody =
    o.responseBody ?? fixtureChatCompletion({ chatId: o.chatId, model, proposal: o.proposal });
  const responseSha = sha256Hex(responseBody);
  const text = `${model}:${requestSha}:${responseSha}`;
  const signature = await account.signMessage({ message: text });
  const reportSigner = o.reportSigner ?? account.address;
  const reportNonce = o.reportNonce ?? o.nonce;
  const reportData = o.reportDataOverride ?? reportDataFor(reportSigner, reportNonce);
  return {
    provider: "near-ai-cloud",
    model,
    chat_id: o.chatId,
    nonce: o.nonce,
    request_sha256: requestSha,
    response_sha256: responseSha,
    response_body: responseBody,
    signature: { text, signature, signing_address: account.address, signing_algo: "ecdsa" },
    report:
      o.withReport === false
        ? null
        : {
            signing_address: reportSigner,
            signing_algo: "ecdsa",
            request_nonce: o.requestNonceOverride ?? reportNonce,
            report_data: reportData,
            intel_quote: fixtureQuoteHex(reportData, o.quoteVersion ?? 4),
            nvidia_payload: null,
            event_log: null,
          },
    fetched_at: o.fetchedAt,
  };
}
