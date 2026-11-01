// NEAR AI Cloud adapter (plain fetch; no @nearai/inference-sdk, so it runs on any Node >= 24).
// It asks a TEE-hosted private model for one structured payment proposal and captures the evidence that
// core's checkAttestation (A1-A7) and checkRequestBinding (A8) verify. The request bytes come from core's
// buildProposalRequest (ICR-3): the nonce is in the user message, and the system message is replaceable.
import { randomBytes } from "node:crypto";
import {
  type AttestationEvidence,
  buildProposalRequest,
  bytesToHex,
  concatBytes,
  extractJsonObject,
  extractReportDataFromQuote,
  type Hex32,
  type InvoiceFacts,
  isHex32,
  type MandateView,
  type ModelProposal,
  NEARAI_BASE_URL,
  normalizeEcdsaSignature,
  PROPOSAL_REQUEST_TEMPLATE,
  PROPOSAL_SYSTEM_PROMPT,
  parseModelProposal,
  proposalRequestInputs,
  sha256Hex,
  utf8,
} from "@probarion/core";
import { NearAiError } from "./errors.js";

// The request builder, the default system prompt and the template id live in core (pure, byte-deterministic,
// needed by the offline auditor check A8); the SDK re-exports them for integrators.
export { buildProposalRequest, PROPOSAL_REQUEST_TEMPLATE, PROPOSAL_SYSTEM_PROMPT };

/** Private TEE models from the catalog (research 2026-10-20), tried first when eligible. Ids drift; /v1/model/list decides. */
export const PREFERRED_PRIVATE_MODELS: readonly string[] = [
  "z-ai/glm-5.3-flash",
  "Qwen/Qwen3.8-27B",
  "Qwen/Qwen3.6-35B-A3B-FP8",
];
export const CATALOG_PAGE_SIZE = 100;
/** ICR-3: `response_body` is stored in the ledger entry, so a response above this many UTF-8 bytes is not used. */
export const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
/** How much of an error response is read for the message. */
const ERROR_BODY_PREVIEW_BYTES = 2048;
const MAX_MODEL_PROBES = 10;
const MAX_CATALOG_PAGES = 50;

/**
 * The model's answer is larger than `MAX_RESPONSE_BODY_BYTES` (ICR-3). The caller treats it like any other
 * `NearAiError`: the model is unavailable for this decision and the decision is rules-only.
 */
export class NearAiResponseTooLargeError extends NearAiError {
  override name = "NearAiResponseTooLargeError";
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(`chat completion is larger than ${limitBytes} bytes; the model answer is not used`);
    this.limitBytes = limitBytes;
  }
}

export interface CatalogModel {
  id: string;
  providerType: string | null;
  attestationSupported: boolean;
  verifiable: boolean;
  structuredOutputs: boolean;
}

export interface NearAiProposerOptions {
  apiKey: string;
  model?: string | undefined;
  baseUrl?: string;
  /** Replaces PROPOSAL_SYSTEM_PROMPT (plan 04 Canary), and only that: the nonce, the schema and the attestation path do not change. */
  systemPrompt?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  signatureRetries?: number;
  signatureRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  preferredModels?: readonly string[];
}

export interface ProposeInput {
  invoiceText: string;
  mandates: readonly MandateView[];
  nonce: Hex32;
  /** Optional: the code's extracted facts (hash, amount, PO ref, purpose), shown to the model with the text. */
  facts?: InvoiceFacts;
}

export interface ProposeResult {
  proposal: ModelProposal;
  /** Carries `request_inputs` (ICR-3), the exact `response_body` and the normalized signature. */
  evidence: AttestationEvidence;
  usage: { promptTokens: number; completionTokens: number } | null;
}

export interface RawModelReport {
  signing_address: string;
  request_nonce: Hex32;
  intel_quote: string;
  nvidia_payload: string | null;
  event_log: unknown | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One page of the public `GET /v1/model/list` catalog. */
export function parseModelCatalogPage(json: unknown): {
  models: CatalogModel[];
  total: number | null;
} {
  const rows = isRecord(json) && Array.isArray(json.models) ? json.models : [];
  const models: CatalogModel[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.modelId !== "string") continue;
    const meta: Record<string, unknown> = isRecord(row.metadata) ? row.metadata : {};
    const features = Array.isArray(meta.supportedFeatures)
      ? meta.supportedFeatures.map(String)
      : [];
    models.push({
      id: row.modelId,
      providerType: typeof meta.providerType === "string" ? meta.providerType : null,
      attestationSupported: meta.attestationSupported === true,
      verifiable: meta.verifiable === true,
      structuredOutputs: features.includes("structured_outputs"),
    });
  }
  const total = isRecord(json) && typeof json.total === "number" ? json.total : null;
  return { models, total };
}

/** Interfaces §14: providerType == "vllm", attestationSupported, verifiable and structured_outputs. */
export function isAttestedStructuredModel(m: CatalogModel): boolean {
  return m.providerType === "vllm" && m.attestationSupported && m.verifiable && m.structuredOutputs;
}

/** Model attestation candidates; drops any without an ecdsa signer, a quote or a 64-hex request_nonce. */
export function parseModelReports(json: unknown): RawModelReport[] {
  let list: unknown[] = [];
  if (isRecord(json) && Array.isArray(json.model_attestations)) list = json.model_attestations;
  else if (isRecord(json) && typeof json.signing_address === "string") list = [json];
  const out: RawModelReport[] = [];
  for (const r of list) {
    if (
      !isRecord(r) ||
      typeof r.signing_address !== "string" ||
      typeof r.intel_quote !== "string" ||
      r.intel_quote === ""
    ) {
      continue;
    }
    if (r.signing_algo !== undefined && r.signing_algo !== "ecdsa") continue;
    const requestNonce = typeof r.request_nonce === "string" ? r.request_nonce.toLowerCase() : "";
    if (!isHex32(requestNonce)) continue;
    let nvidia: string | null = null;
    if (typeof r.nvidia_payload === "string") nvidia = r.nvidia_payload;
    else if (r.nvidia_payload !== null && r.nvidia_payload !== undefined) {
      nvidia = JSON.stringify(r.nvidia_payload);
    }
    out.push({
      signing_address: r.signing_address,
      request_nonce: requestNonce,
      intel_quote: r.intel_quote,
      nvidia_payload: nvidia,
      event_log: r.event_log ?? null,
    });
  }
  return out;
}

/** Interfaces §7: keep exactly one candidate whose signer signed this response; otherwise the decision is unattested. */
export function selectReport(
  reports: readonly RawModelReport[],
  signingAddress: string,
): AttestationEvidence["report"] {
  const matches = reports.filter(
    (r) => r.signing_address.toLowerCase() === signingAddress.toLowerCase(),
  );
  const match = matches.length === 1 ? matches[0] : undefined;
  if (match === undefined) return null;
  return {
    signing_address: match.signing_address,
    signing_algo: "ecdsa",
    request_nonce: match.request_nonce,
    report_data: extractReportDataFromQuote(match.intel_quote) ?? "",
    intel_quote: match.intel_quote,
    nvidia_payload: match.nvidia_payload,
    event_log: match.event_log,
  };
}

/**
 * Reads a response body without buffering more than `limit` bytes (plus the chunk that crosses it).
 * Past the limit it cancels the stream and either throws or, with `truncate`, returns what it has.
 */
async function readBody(res: Response, limit: number, truncate: boolean): Promise<Uint8Array> {
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      if (!truncate) throw new NearAiResponseTooLargeError(limit);
      return concatBytes(...chunks, value).slice(0, limit);
    }
    chunks.push(value);
  }
  return concatBytes(...chunks);
}

export class NearAiProposer {
  private readonly opts: NearAiProposerOptions;
  private resolved: string | null = null;

  constructor(opts: NearAiProposerOptions) {
    if (!opts.apiKey) throw new NearAiError("NEARAI_API_KEY is required for the model step");
    if (opts.systemPrompt !== undefined && opts.systemPrompt.trim() === "") {
      throw new NearAiError("systemPrompt must not be empty; omit it to use the default prompt");
    }
    this.opts = opts;
  }

  /** The resolved model id (after the first resolveModel/propose), else the configured one, else "". */
  get model(): string {
    return this.resolved ?? this.opts.model ?? "";
  }

  private get base(): string {
    return (this.opts.baseUrl ?? NEARAI_BASE_URL).replace(/\/+$/, "");
  }

  private request(input: string | URL, init: RequestInit): Promise<Response> {
    const doFetch = this.opts.fetch ?? globalThis.fetch;
    return doFetch(input, init);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.opts.apiKey}`, accept: "application/json", ...extra };
  }

  private sleep(ms: number): Promise<void> {
    if (this.opts.sleep !== undefined) return this.opts.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** The public, paginated catalog. The API key is not sent. */
  async listModelCatalog(): Promise<CatalogModel[]> {
    const all: CatalogModel[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
      const url = new URL(`${this.base}/model/list`);
      url.searchParams.set("limit", String(CATALOG_PAGE_SIZE));
      url.searchParams.set("offset", String(offset));
      const res = await this.request(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new NearAiError(`GET /model/list: HTTP ${res.status}`);
      const { models, total } = parseModelCatalogPage(await res.json());
      all.push(...models);
      offset += models.length;
      if (models.length === 0 || (total !== null && offset >= total)) return all;
    }
    return all;
  }

  async fetchModelReports(model: string, nonce: Hex32): Promise<RawModelReport[]> {
    const url = new URL(`${this.base}/attestation/report`);
    url.searchParams.set("model", model);
    url.searchParams.set("signing_algo", "ecdsa");
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("provider", "near");
    url.searchParams.set("include_tls_fingerprint", "false");
    const res = await this.request(url, { headers: this.headers({ "x-no-aliasing": "true" }) });
    if (!res.ok) throw new NearAiError(`GET /attestation/report: HTTP ${res.status}`);
    return parseModelReports(await res.json());
  }

  /** NEARAI_MODEL if set, else the first eligible catalog model whose attestation probe returns NEAR evidence. */
  async resolveModel(): Promise<string> {
    if (this.resolved !== null) return this.resolved;
    const catalog = await this.listModelCatalog();
    let candidates: string[];
    if (this.opts.model) {
      const listed = catalog.find((m) => m.id === this.opts.model);
      if (listed === undefined) {
        throw new NearAiError(`model ${this.opts.model} is not in /v1/model/list`);
      }
      if (!isAttestedStructuredModel(listed)) {
        throw new NearAiError(
          `model ${this.opts.model} is not a private TEE model with structured outputs (needs providerType vllm, attestationSupported, verifiable, structured_outputs)`,
        );
      }
      candidates = [this.opts.model];
    } else {
      const eligible = catalog.filter(isAttestedStructuredModel).map((m) => m.id);
      const preferred = this.opts.preferredModels ?? PREFERRED_PRIVATE_MODELS;
      candidates = [
        ...preferred.filter((m) => eligible.includes(m)),
        ...eligible.filter((m) => !preferred.includes(m)),
      ].slice(0, MAX_MODEL_PROBES);
    }
    for (const model of candidates) {
      let reports: RawModelReport[] = [];
      try {
        reports = await this.fetchModelReports(model, bytesToHex(randomBytes(32)));
      } catch {
        reports = [];
      }
      if (reports.length > 0) {
        this.resolved = model;
        return model;
      }
    }
    throw new NearAiError("no eligible private TEE model returned a NEAR model attestation");
  }

  /**
   * The provider_tee signature of a finished chat, normalized at capture (ICR-3): v is 27 or 28 and s is low.
   * A short 404 window after the chat is normal, so it is retried with a bounded back-off.
   */
  async fetchSignature(chatId: string): Promise<AttestationEvidence["signature"]> {
    const retries = this.opts.signatureRetries ?? 5;
    const delay = this.opts.signatureRetryDelayMs ?? 400;
    let last = "no attempt";
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await this.sleep(delay * attempt);
      const url = new URL(`${this.base}/signature/${encodeURIComponent(chatId)}`);
      url.searchParams.set("signing_algo", "ecdsa");
      const res = await this.request(url, { headers: this.headers() });
      if (res.status === 404) {
        last = "HTTP 404";
        continue;
      }
      if (!res.ok) throw new NearAiError(`GET /signature: HTTP ${res.status}`);
      const body: unknown = await res.json();
      if (isRecord(body) && body.error_code !== undefined) {
        last = `unavailable: ${String(body.message ?? body.error_code)}`;
        continue;
      }
      if (
        isRecord(body) &&
        body.signature_kind !== undefined &&
        body.signature_kind !== "provider_tee"
      ) {
        throw new NearAiError(`signature kind ${String(body.signature_kind)} is not provider_tee`);
      }
      if (
        isRecord(body) &&
        typeof body.text === "string" &&
        typeof body.signature === "string" &&
        typeof body.signing_address === "string"
      ) {
        let signature: string;
        try {
          signature = normalizeEcdsaSignature(body.signature);
        } catch (error) {
          throw new NearAiError(
            `GET /signature: ${error instanceof Error ? error.message : "malformed signature"}`,
            { cause: error },
          );
        }
        return {
          text: body.text,
          signature,
          signing_address: body.signing_address,
          signing_algo: "ecdsa",
        };
      }
      throw new NearAiError("GET /signature: malformed response");
    }
    throw new NearAiError(
      `provider_tee signature for ${chatId} unavailable after ${retries + 1} attempts (${last})`,
    );
  }

  /**
   * One attested proposal. Order (report §8 (iii), interfaces §7): the attestation report for the ledger nonce,
   * then the chat, then the signature. The request is built once by core's `buildProposalRequest`; these exact
   * bytes are sent and hashed, and `evidence.request_inputs` records what they were built from (not the
   * invoice text) so an auditor holding the invoice can run A8. Any failure throws a `NearAiError`; the caller
   * then decides rules-only, so a response above `MAX_RESPONSE_BODY_BYTES` (64 KiB) is a failure too.
   */
  async propose(input: ProposeInput): Promise<ProposeResult> {
    if (!isHex32(input.nonce)) {
      throw new NearAiError("nonce must be 64 lowercase hex characters (the ledger nonce)");
    }
    const model = await this.resolveModel();
    const systemPrompt = this.opts.systemPrompt ?? PROPOSAL_SYSTEM_PROMPT;
    let body: Uint8Array;
    let requestInputs: AttestationEvidence["request_inputs"];
    try {
      body = utf8(buildProposalRequest(model, input, systemPrompt));
      requestInputs = proposalRequestInputs(model, input, systemPrompt);
    } catch (error) {
      throw new NearAiError(
        `cannot build the proposal request: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const reports = await this.fetchModelReports(model, input.nonce);
    if (reports.length === 0) {
      throw new NearAiError(`model ${model} returned no attestation for this nonce`);
    }

    const res = await this.request(`${this.base}/chat/completions`, {
      method: "POST",
      headers: this.headers({
        "content-type": "application/json",
        "accept-encoding": "identity",
        "x-no-aliasing": "true",
      }),
      body,
    });
    if (!res.ok) {
      const preview = new TextDecoder().decode(await readBody(res, ERROR_BODY_PREVIEW_BYTES, true));
      throw new NearAiError(`POST /chat/completions: HTTP ${res.status}: ${preview.slice(0, 200)}`);
    }
    const responseBytes = await readBody(res, MAX_RESPONSE_BODY_BYTES, false);
    let responseText: string;
    try {
      // fatal + ignoreBOM: the string must re-encode to exactly the bytes that are hashed and signed.
      responseText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        responseBytes,
      );
    } catch (error) {
      throw new NearAiError("chat completion is not valid UTF-8", { cause: error });
    }

    let completion: unknown;
    try {
      completion = JSON.parse(responseText);
    } catch {
      throw new NearAiError("chat completion is not JSON");
    }
    const chatId = isRecord(completion) ? completion.id : undefined;
    const choice =
      isRecord(completion) && Array.isArray(completion.choices) ? completion.choices[0] : undefined;
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
    const content = message?.content;
    if (typeof chatId !== "string" || typeof content !== "string") {
      throw new NearAiError("chat completion has no id or content");
    }

    let proposal: ModelProposal;
    try {
      proposal = parseModelProposal(extractJsonObject(content));
    } catch (error) {
      throw new NearAiError(
        `invalid model proposal: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const usageRaw = isRecord(completion) && isRecord(completion.usage) ? completion.usage : null;
    const usage =
      usageRaw !== null &&
      typeof usageRaw.prompt_tokens === "number" &&
      typeof usageRaw.completion_tokens === "number"
        ? { promptTokens: usageRaw.prompt_tokens, completionTokens: usageRaw.completion_tokens }
        : null;
    const signature = await this.fetchSignature(chatId);
    return {
      proposal,
      usage,
      evidence: {
        provider: "near-ai-cloud",
        model,
        chat_id: chatId,
        nonce: input.nonce,
        request_sha256: sha256Hex(body),
        request_inputs: requestInputs,
        response_sha256: sha256Hex(responseBytes),
        response_body: responseText,
        signature,
        report: selectReport(reports, signature.signing_address),
        fetched_at: (this.opts.now ?? (() => new Date()))().toISOString(),
      },
    };
  }
}
