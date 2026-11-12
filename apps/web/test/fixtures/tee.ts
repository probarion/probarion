// TEST DOUBLE of NEAR AI Cloud's attestation report endpoint and of the O1/O2 verifier, for the live TEE check
// (lib/tee/check.ts). Like the SDK's fake NEAR AI (packages/sdk/src/testing/fake-nearai.ts) it returns a labeled fake
// TDX quote that holds the report data, and a GPU payload that carries a nonce. It is never NEAR AI Cloud, Intel or
// NVIDIA, and it answers the report without an API key, as the public endpoint does.
import {
  bytesToHex,
  hexToBytes,
  TDX_QUOTE_V4_BODY_OFFSET,
  TDX_REPORT_DATA_BODY_OFFSET,
  utf8,
} from "@probarion/core";
import type { OnlineAttestationVerifier, VerifiedTdxQuote } from "@probarion/sdk";

export const FAKE_NEARAI = "https://fake-nearai.test/v1";
export const TEE_MODEL = "test-double/private-tee-model";
export const SIGNER = "0x835ab53d20294ef795906dff21ae4c045336aa26";
export const NONCE = "b6712cebbcf58a6ef1598f2a725b27ba8977e4368bdfba84b0c35b68fe392570";
export const OTHER_NONCE = `${"0".repeat(63)}1`;
const LABEL = "TEST DOUBLE: not NEAR AI Cloud";

/** A v4 quote that holds `reportData` (128 hex) where a TDX quote does, and nothing real. */
export function fakeQuoteHex(reportData: string): string {
  const bytes = new Uint8Array(TDX_QUOTE_V4_BODY_OFFSET + 584);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 4, true);
  view.setUint32(4, 0x81, true); // tee_type: TDX
  bytes.set(utf8("PROBARION TEST DOUBLE - NOT A TDX QUOTE"), 8);
  bytes.set(hexToBytes(reportData), TDX_QUOTE_V4_BODY_OFFSET + TDX_REPORT_DATA_BODY_OFFSET);
  return bytesToHex(bytes);
}

export interface FakeAttestation {
  signer?: string;
  /** The nonce in report_data[32..64] (default: the one asked for). */
  reportNonce?: string;
  /** The report's request_nonce (default: the one asked for). */
  requestNonce?: string;
  /** report_data[0..32] (64 hex; default: the zero-padded signer). */
  reportSigner?: string;
  /** The GPU payload's nonce (default: the one asked for); null: no GPU payload. */
  gpuNonce?: string | null;
}

/** One model attestation, in the shape of the live report (2026-11-12), for the nonce that was asked for. */
export function fakeAttestation(asked: string, a: FakeAttestation = {}): Record<string, unknown> {
  const signer = (a.signer ?? SIGNER).toLowerCase();
  const head = a.reportSigner ?? `${signer.slice(2)}${"0".repeat(24)}`;
  const gpuNonce = a.gpuNonce === undefined ? asked : a.gpuNonce;
  return {
    model_name: TEE_MODEL,
    signing_address: signer,
    signing_algo: "ecdsa",
    signing_public_key: "00".repeat(64),
    request_nonce: a.requestNonce ?? asked,
    intel_quote: fakeQuoteHex(`${head}${a.reportNonce ?? asked}`),
    nvidia_payload:
      gpuNonce === null
        ? null
        : JSON.stringify({ nonce: gpuNonce, evidence_list: [{ note: LABEL }], arch: "HOPPER" }),
    event_log: [{ event: LABEL }],
    info: { note: LABEL, compose_hash: "11".repeat(32) },
  };
}

export interface FakeReportServer {
  fetch: typeof fetch;
  calls: { url: URL; headers: Record<string, string> }[];
  /** Per request: the model attestations to answer with, an HTTP status, raw text, or "hang" (until aborted). */
  reply: (url: URL) => Record<string, unknown>[] | number | { raw: string } | "hang";
}

export function fakeReportServer(): FakeReportServer {
  const server: FakeReportServer = {
    calls: [],
    reply: (url) => [fakeAttestation(url.searchParams.get("nonce") ?? "")],
    fetch: async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      server.calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      const r = server.reply(url);
      if (r === "hang") {
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (typeof r === "number") return new Response("upstream error", { status: r });
      if (!Array.isArray(r)) return new Response(r.raw, { status: 200 });
      return new Response(
        JSON.stringify({
          gateway_attestation: { note: LABEL, signing_address: "0x".padEnd(42, "b") },
          model_attestations: r,
          ohttp_key_config: LABEL,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
  return server;
}

/** An @nearai/inference-sdk VerificationError as the verifier throws it: a message and `failure.code`. */
export function verificationError(code: string): Error {
  return Object.assign(new Error(`[${code}] test double`), {
    name: "VerificationError",
    failure: { code },
  });
}

/** What DCAP would say of a fake quote: its report data, UpToDate, debug off; `over` changes a field. */
export function dcapResult(hex: string, over: Partial<VerifiedTdxQuote> = {}): VerifiedTdxQuote {
  const bytes = hexToBytes(hex);
  const start = TDX_QUOTE_V4_BODY_OFFSET + TDX_REPORT_DATA_BODY_OFFSET;
  return {
    reportDataHex: bytesToHex(bytes.slice(start, start + 64)),
    tcbStatus: "UpToDate",
    debugEnabled: false,
    advisoryIds: [],
    ...over,
  };
}

export interface FakeVerifier extends OnlineAttestationVerifier {
  quotes: string[];
  gpus: string[];
}

/**
 * A verifier that reads the quote's report data back as DCAP would and accepts it, unless `quote` or `gpu` replace an
 * answer (a different TCB status, debug on, a throw, or a promise that never settles).
 */
export function fakeVerifier(
  o: {
    quote?: (hex: string) => Promise<VerifiedTdxQuote>;
    gpu?: (payload: string) => Promise<void>;
  } = {},
): FakeVerifier {
  const v: FakeVerifier = {
    quotes: [],
    gpus: [],
    async verifyQuote(hex) {
      v.quotes.push(hex);
      return o.quote ? o.quote(hex) : dcapResult(hex);
    },
    async verifyGpu(payload) {
      v.gpus.push(payload);
      if (o.gpu) return o.gpu(payload);
    },
  };
  return v;
}
