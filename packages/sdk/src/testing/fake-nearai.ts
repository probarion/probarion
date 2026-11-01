// TEST DOUBLE of NEAR AI Cloud (model catalog, OpenAI-compatible chat, attestation report, provider_tee signatures).
// It signs with a local secp256k1 key and returns a labeled fake quote. It is never NEAR AI Cloud.
import {
  bytesToHex,
  formatProviderTeeText,
  hexToBytes,
  sha256Hex,
  TDX_QUOTE_V4_BODY_OFFSET,
  TDX_QUOTE_V5_BODY_OFFSET,
  TDX_REPORT_DATA_BODY_OFFSET,
  utf8,
} from "@probarion/core";
import { privateKeyToAccount } from "viem/accounts";

export const FAKE_NEARAI_BASE_URL = "https://fake-nearai.test/v1";
export const FAKE_PRIVATE_MODEL = "test-double/private-tee-model";
export const FAKE_INCOGNITO_MODEL = "test-double/incognito-model";
export const FAKE_NO_JSON_MODEL = "test-double/tee-model-without-structured-outputs";
export const TEST_DOUBLE_TEE_PRIVATE_KEY: `0x${string}` = `0x${sha256Hex("probarion/test-double/tee-secp256k1-key")}`;
const LABEL = "TEST DOUBLE: not NEAR AI Cloud";
/** secp256k1 group order, used to build the high-s twin of a signature. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export interface FakeCatalogModel {
  id: string;
  providerType: string;
  attestationSupported: boolean;
  verifiable: boolean;
  features: string[];
}

/** The chat-completion request body as the fake received it (parsed). `respond` sees exactly what the SDK sent. */
export interface FakeChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  response_format?: unknown;
  temperature?: number;
  stream?: boolean;
  max_tokens?: number;
}

/**
 * How the fake's signature is encoded. `canonical` is low-s with v 27 or 28. The others are what a provider
 * might send instead and that the SDK must normalize at capture: a raw recovery id (v 0 or 1), the high-s twin
 * (`s := n - s`, v flipped), or both.
 */
export type FakeSignatureStyle =
  | "canonical"
  | "raw-recovery-id"
  | "high-s"
  | "high-s-raw-recovery-id";

export interface FakeNearAiOptions {
  respond: (request: FakeChatRequest) => string;
  teePrivateKey?: `0x${string}`;
  reportSignerPrivateKey?: `0x${string}`;
  catalog?: FakeCatalogModel[];
  catalogPageSize?: number;
  attestedModels?: string[];
  duplicateReports?: boolean;
  /**
   * The nonce the fake puts into the report (its `request_nonce` and the quote's report_data) instead of the
   * one that was asked for: a stale or replayed report. Receives the requested nonce.
   */
  reportNonce?: (requested: string) => string;
  quoteVersion?: 4 | 5;
  failChat?: number | null;
  /** The body of the `failChat` response (default `upstream error`); a test puts a leaked credential here. */
  failChatBody?: string;
  signature404s?: number;
  signatureStyle?: FakeSignatureStyle;
  /**
   * Replaces the HTTP response body that is sent (and signed): receives the default JSON text. Used for an
   * oversized body, a body that is not valid UTF-8, or an exact length.
   */
  rawResponse?: (defaultText: string) => string | Uint8Array;
}

export interface FakeNearAi {
  fetch: typeof fetch;
  /** Every request the fake received. `body` is the request body text for a POST, else null. */
  calls: {
    method: string;
    path: string;
    query: string;
    headers: Record<string, string>;
    body: string | null;
  }[];
}

const DEFAULT_CATALOG: FakeCatalogModel[] = [
  {
    id: FAKE_INCOGNITO_MODEL,
    providerType: "external",
    attestationSupported: false,
    verifiable: false,
    features: ["tools", "structured_outputs"],
  },
  {
    id: FAKE_NO_JSON_MODEL,
    providerType: "vllm",
    attestationSupported: true,
    verifiable: true,
    features: ["tools"],
  },
  {
    id: FAKE_PRIVATE_MODEL,
    providerType: "vllm",
    attestationSupported: true,
    verifiable: true,
    features: ["structured_outputs"],
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeQuoteHex(reportDataHex: string, version: 4 | 5): string {
  const bodyOffset = version === 4 ? TDX_QUOTE_V4_BODY_OFFSET : TDX_QUOTE_V5_BODY_OFFSET;
  const bytes = new Uint8Array(bodyOffset + 584);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, version, true);
  view.setUint32(4, 0x81, true); // tee_type: TDX (core's parseTdxQuote requires it for v4)
  bytes.set(utf8("PROBARION TEST DOUBLE - NOT A TDX QUOTE"), 8);
  if (version === 5) {
    view.setUint16(48, 2, true); // body type 2: TD report 1.0
    view.setUint32(50, 584, true);
  }
  bytes.set(hexToBytes(reportDataHex), bodyOffset + TDX_REPORT_DATA_BODY_OFFSET);
  return bytesToHex(bytes);
}

/** Re-encodes a canonical 0x + r + s + v signature the way a provider might have sent it. */
function encodeSignature(canonical: string, style: FakeSignatureStyle): string {
  if (style === "canonical") return canonical;
  const r = canonical.slice(0, 66);
  let s = BigInt(`0x${canonical.slice(66, 130)}`);
  let v = Number.parseInt(canonical.slice(130, 132), 16);
  if (style === "high-s" || style === "high-s-raw-recovery-id") {
    s = SECP256K1_N - s;
    v = v === 27 ? 28 : 27;
  }
  if (style === "raw-recovery-id" || style === "high-s-raw-recovery-id") v -= 27;
  return `${r}${s.toString(16).padStart(64, "0")}${v.toString(16).padStart(2, "0")}`;
}

function bodyBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return utf8(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error("fake NEAR AI: unsupported request body type");
}

export function createFakeNearAi(opts: FakeNearAiOptions): FakeNearAi {
  const signer = privateKeyToAccount(opts.teePrivateKey ?? TEST_DOUBLE_TEE_PRIVATE_KEY);
  const reportSigner = privateKeyToAccount(
    opts.reportSignerPrivateKey ?? opts.teePrivateKey ?? TEST_DOUBLE_TEE_PRIVATE_KEY,
  );
  const catalog = opts.catalog ?? DEFAULT_CATALOG;
  const attested = opts.attestedModels ?? [FAKE_PRIVATE_MODEL, FAKE_NO_JSON_MODEL];
  const completions = new Map<string, { model: string; requestSha: string; responseSha: string }>();
  const calls: FakeNearAi["calls"] = [];
  let pending404 = opts.signature404s ?? 0;
  let counter = 0;

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const sent = init?.body === undefined || init.body === null ? null : bodyBytes(init.body);
    calls.push({
      method,
      path: url.pathname,
      query: url.search,
      headers,
      body: sent === null ? null : new TextDecoder().decode(sent),
    });
    const path = url.pathname.replace(/^\/v1/, "");

    if (method === "GET" && path === "/model/list") {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Math.min(
        Number(url.searchParams.get("limit") ?? "100"),
        opts.catalogPageSize ?? 100,
      );
      return json({
        models: catalog.slice(offset, offset + limit).map((m) => ({
          modelId: m.id,
          metadata: {
            providerType: m.providerType,
            attestationSupported: m.attestationSupported,
            verifiable: m.verifiable,
            supportedFeatures: m.features,
            modelDisplayName: LABEL,
          },
        })),
        limit,
        offset,
        total: catalog.length,
      });
    }
    if (!(headers.authorization ?? "").startsWith("Bearer ")) {
      return json({ error: "unauthorized" }, 401);
    }
    if (method === "GET" && path === "/attestation/report") {
      const model = url.searchParams.get("model") ?? "";
      const nonce = url.searchParams.get("nonce") ?? "";
      if (!attested.includes(model)) {
        return json({ gateway_attestation: { note: LABEL }, model_attestations: [] });
      }
      const reported = opts.reportNonce?.(nonce) ?? nonce;
      const reportData = `${reportSigner.address.toLowerCase().slice(2)}${"0".repeat(24)}${reported}`;
      const candidate = {
        signing_address: reportSigner.address.toLowerCase(),
        signing_algo: "ecdsa",
        intel_quote: fakeQuoteHex(reportData, opts.quoteVersion ?? 4),
        nvidia_payload: null,
        event_log: "[]",
        request_nonce: reported,
        info: { note: LABEL },
      };
      return json({
        gateway_attestation: { note: LABEL },
        model_attestations: opts.duplicateReports ? [candidate, candidate] : [candidate],
      });
    }
    if (method === "POST" && path === "/chat/completions") {
      if (opts.failChat) {
        return new Response(opts.failChatBody ?? "upstream error", { status: opts.failChat });
      }
      if (sent === null) return json({ error: "empty request body" }, 400);
      const request = JSON.parse(new TextDecoder().decode(sent)) as FakeChatRequest;
      counter += 1;
      const id = `chatcmpl-test-double-${counter}`;
      const defaultText = JSON.stringify({
        id,
        object: "chat.completion",
        created: 1_793_880_000,
        model: request.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: opts.respond(request) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
      const sentResponse = opts.rawResponse?.(defaultText) ?? defaultText;
      const responseBytes = typeof sentResponse === "string" ? utf8(sentResponse) : sentResponse;
      completions.set(id, {
        model: request.model,
        requestSha: sha256Hex(sent),
        responseSha: sha256Hex(responseBytes),
      });
      return new Response(responseBytes, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const signature = /^\/signature\/(.+)$/.exec(path);
    if (method === "GET" && signature !== null) {
      if (pending404 > 0) {
        pending404 -= 1;
        return json({ detail: "not found" }, 404);
      }
      const done = completions.get(decodeURIComponent(signature[1] ?? ""));
      if (done === undefined) return json({ detail: "not found" }, 404);
      const text = formatProviderTeeText(done.model, done.requestSha, done.responseSha);
      const canonical = await signer.signMessage({ message: text });
      return json({
        text,
        signature: encodeSignature(canonical, opts.signatureStyle ?? "canonical"),
        signing_address: signer.address,
        signing_algo: "ecdsa",
        signature_kind: "provider_tee",
      });
    }
    return json({ error: `fake NEAR AI: no route for ${method} ${url.pathname}` }, 404);
  };

  return { fetch: fakeFetch, calls };
}
