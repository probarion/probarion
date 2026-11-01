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
import type { AttestationEvidence, Hex32 } from "../../src/types.js";
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

/** report_data = 20-byte signer, zero-padded to 32 bytes, then the 32-byte nonce. */
export function reportDataFor(address: string, nonce: Hex32): string {
  return `${address.toLowerCase().slice(2)}${"0".repeat(24)}${nonce}`;
}

export interface TestEvidenceOptions {
  nonce: Hex32;
  requestBody: string;
  responseBody: string;
  chatId: string;
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
  const responseSha = sha256Hex(o.responseBody);
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
