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
  proposalRequestInputsProblem,
  sha256Hex,
  utf8,
} from "@probarion/core";
import { MIN_CALL_MS } from "./deadline.js";
import { NearAiError } from "./errors.js";
import { isRecord } from "./guards.js";

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

/** The four kinds of call the adapter makes, each with its own timeout. */
export type NearAiPhase = "catalog" | "report" | "chat" | "signature";

/**
 * Per-call timeouts in milliseconds (ICR-3b round). A call covers the response headers and the body, so a
 * server that stalls half-way is cut off too. The chat gets the longest: a thinking model can take a while.
 */
export const DEFAULT_NEARAI_TIMEOUTS_MS: Readonly<Record<NearAiPhase, number>> = Object.freeze({
  catalog: 10_000,
  report: 15_000,
  chat: 90_000,
  signature: 15_000,
});

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

/**
 * Removes anything that looks like a credential from text that may reach a log or a terminal: each of
 * `secrets` (the configured API key), `Bearer <token>`, values of authorization / api-key style fields and
 * `sk-...` keys. Applied to every message built from a remote response or an error.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(
      /\b(authorization|x-api-key|api[_-]?key|apikey|secret)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',;&]+/gi,
      "$1$2[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[redacted]");
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
  /** Overrides of `DEFAULT_NEARAI_TIMEOUTS_MS`, per phase; each must be a positive finite number of milliseconds. */
  timeoutMs?: Partial<Record<NearAiPhase, number>>;
  /**
   * Milliseconds the caller has left for ALL of this proposer's calls together (default: no overall limit). It is read
   * before every call and every signature back-off: a call gets the smaller of its phase timeout and what is left, a
   * call with less than `MIN_CALL_MS` (50 ms) left is not made, and a back-off that would leave less than that for the
   * try after it is not waited out. For a caller that answers inside a platform's time limit.
   */
  remainingMs?: () => number;
  /**
   * A model id the caller already resolved (it passed the catalog and the attestation probe in an earlier run): used as
   * is, with no catalog call and no probe. The attestation report for each request's nonce is still fetched.
   */
  knownModel?: string;
}

export interface ProposeInput {
  invoiceText: string;
  mandates: readonly MandateView[];
  nonce: Hex32;
  /**
   * The code's extracted facts, shown to the model with the text. Required (ICR-3b): check A8 fails an entry
   * whose `request_inputs.facts` is null. `facts.invoice_hash` must be `sha256Hex(utf8(invoiceText))`, the
   * hash of the text the model sees (for a PDF, the extracted text), so the same value is the ledger's and
   * the contract's `invoice_hash`.
   */
  facts: InvoiceFacts;
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

/** True for the `TimeoutError` that `AbortSignal.timeout` aborts with, however fetch wrapped it. */
function isTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { name?: unknown }).name === "TimeoutError") return true;
  return isTimeout((error as { cause?: unknown }).cause);
}

/** The message of an error and of its first cause, e.g. `fetch failed: connect ECONNREFUSED 10.0.0.1:443`. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return cause === "" || cause === error.message ? error.message : `${error.message}: ${cause}`;
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

/** Frees the connection of a response whose body is not read. */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // nothing to free
  }
}

export class NearAiProposer {
  private readonly opts: NearAiProposerOptions;
  private readonly timeouts: Record<NearAiPhase, number>;
  private resolved: string | null = null;
  /** The timeout each phase's last call really used (its cap, or less when the time left was shorter). */
  private readonly used: Partial<Record<NearAiPhase, number>> = {};

  constructor(opts: NearAiProposerOptions) {
    if (!opts.apiKey) throw new NearAiError("NEARAI_API_KEY is required for the model step");
    if (opts.systemPrompt !== undefined && opts.systemPrompt.trim() === "") {
      throw new NearAiError("systemPrompt must not be empty; omit it to use the default prompt");
    }
    const timeouts = { ...DEFAULT_NEARAI_TIMEOUTS_MS, ...opts.timeoutMs };
    for (const [phase, ms] of Object.entries(timeouts)) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
        throw new NearAiError(`timeoutMs.${phase} must be a positive number of milliseconds`);
      }
    }
    if (
      opts.knownModel !== undefined &&
      (typeof opts.knownModel !== "string" || opts.knownModel.trim() === "")
    ) {
      throw new NearAiError("knownModel must be a non-empty model id");
    }
    this.timeouts = timeouts;
    this.opts = opts;
    this.resolved = opts.knownModel ?? null;
  }

  /** The resolved model id (after the first resolveModel/propose), else the configured one, else "". */
  get model(): string {
    return this.resolved ?? this.opts.model ?? "";
  }

  /** The model this proposer resolved (or was given as `knownModel`), or null before it has one. A caller may keep it. */
  get resolvedModel(): string | null {
    return this.resolved;
  }

  private get base(): string {
    return (this.opts.baseUrl ?? NEARAI_BASE_URL).replace(/\/+$/, "");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.opts.apiKey}`, accept: "application/json", ...extra };
  }

  private sleep(ms: number): Promise<void> {
    if (this.opts.sleep !== undefined) return this.opts.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Text that came from a remote response or an error, with credentials removed. */
  private redact(text: string): string {
    return redactSecrets(text, [this.opts.apiKey]);
  }

  /**
   * The error to keep as a `cause`: the original when it holds no credential, else a copy (same name, no
   * stack) whose message, and the messages of its causes, are redacted. A logger that prints causes must
   * not print the key. A JSON `SyntaxError` quotes the start of the body, which a server may have echoed.
   */
  private safeCause(error: unknown): unknown {
    if (typeof error === "string") return this.redact(error);
    if (!(error instanceof Error)) return error;
    const message = this.redact(error.message);
    const inner = error.cause === undefined ? undefined : this.safeCause(error.cause);
    if (message === error.message && inner === error.cause) return error;
    const copy =
      error instanceof SyntaxError
        ? new SyntaxError(message, inner === undefined ? undefined : { cause: inner })
        : new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = error.name;
    return copy;
  }

  /**
   * One call with its phase timeout. The signal stays armed while the body is read, so every failure of the
   * call, whether the connection, a stall in the headers or in the body, is a `NearAiError` with the cause.
   */
  private async call(
    phase: NearAiPhase,
    label: string,
    input: string | URL,
    init: RequestInit,
  ): Promise<Response> {
    const cap = this.timeouts[phase];
    const left = this.opts.remainingMs?.();
    // Below the floor a call could only time out (a timer can fire a little before the deadline): it is not sent.
    if (left !== undefined && !(left >= MIN_CALL_MS)) {
      throw new NearAiError(`${label}: the time left for the model step ran out (not sent)`);
    }
    const ms = left === undefined ? cap : Math.max(1, Math.min(cap, Math.ceil(left)));
    this.used[phase] = ms;
    const doFetch = this.opts.fetch ?? globalThis.fetch;
    try {
      return await doFetch(input, { ...init, signal: AbortSignal.timeout(ms) });
    } catch (error) {
      throw this.failure(phase, label, error, "request");
    }
  }

  /** The `NearAiError` for a transport failure or a failed body read: a timeout says so, anything else is redacted. */
  private failure(phase: NearAiPhase, label: string, error: unknown, stage: string): NearAiError {
    if (isTimeout(error)) {
      return new NearAiError(
        `${label}: timed out after ${this.used[phase] ?? this.timeouts[phase]} ms (${stage})`,
        {
          cause: this.safeCause(error),
        },
      );
    }
    return new NearAiError(`${label}: ${stage} failed (${this.redact(describe(error))})`, {
      cause: this.safeCause(error),
    });
  }

  private async readJson(phase: NearAiPhase, label: string, res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new NearAiError(`${label}: response is not JSON`, { cause: this.safeCause(error) });
      }
      throw this.failure(phase, label, error, "reading the response");
    }
  }

  /** The public, paginated catalog. The API key is not sent. */
  async listModelCatalog(): Promise<CatalogModel[]> {
    const all: CatalogModel[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
      const url = new URL(`${this.base}/model/list`);
      url.searchParams.set("limit", String(CATALOG_PAGE_SIZE));
      url.searchParams.set("offset", String(offset));
      const label = "GET /model/list";
      const res = await this.call("catalog", label, url, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        await discard(res);
        throw new NearAiError(`${label}: HTTP ${res.status}`);
      }
      const { models, total } = parseModelCatalogPage(await this.readJson("catalog", label, res));
      all.push(...models);
      offset += models.length;
      if (models.length === 0 || (total !== null && offset >= total)) return all;
    }
    return all;
  }

  /**
   * The attestation candidates for `nonce`. A candidate whose `request_nonce` is not the nonce that was asked
   * for (a stale or replayed report) is dropped at capture, so it can never be selected into the evidence.
   */
  async fetchModelReports(model: string, nonce: Hex32): Promise<RawModelReport[]> {
    const url = new URL(`${this.base}/attestation/report`);
    url.searchParams.set("model", model);
    url.searchParams.set("signing_algo", "ecdsa");
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("provider", "near");
    url.searchParams.set("include_tls_fingerprint", "false");
    const label = "GET /attestation/report";
    const res = await this.call("report", label, url, {
      headers: this.headers({ "x-no-aliasing": "true" }),
    });
    if (!res.ok) {
      await discard(res);
      throw new NearAiError(`${label}: HTTP ${res.status}`);
    }
    const wanted = nonce.toLowerCase();
    return parseModelReports(await this.readJson("report", label, res)).filter(
      (r) => r.request_nonce === wanted,
    );
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
   * The request carries `model` (`/v1/signature/{chat_id}?model=<id>&signing_algo=ecdsa`), which the service
   * may use to find the chat and which is harmless if it ignores it. A short 404 window after the chat is
   * normal, so it is retried with a bounded back-off.
   */
  async fetchSignature(chatId: string, model?: string): Promise<AttestationEvidence["signature"]> {
    const retries = this.opts.signatureRetries ?? 5;
    const delay = this.opts.signatureRetryDelayMs ?? 400;
    const label = "GET /signature";
    let last = "no attempt";
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const left = this.opts.remainingMs?.();
        // The back-off is waited out only if what it leaves can still start the try after it.
        if (left !== undefined && !(left >= delay * attempt + MIN_CALL_MS)) {
          throw new NearAiError(`${label}: no time left for another try (last: ${last})`);
        }
        await this.sleep(delay * attempt);
      }
      const url = new URL(`${this.base}/signature/${encodeURIComponent(chatId)}`);
      if (model !== undefined) url.searchParams.set("model", model);
      url.searchParams.set("signing_algo", "ecdsa");
      const res = await this.call("signature", label, url, { headers: this.headers() });
      if (res.status === 404) {
        await discard(res);
        last = "HTTP 404";
        continue;
      }
      if (!res.ok) {
        await discard(res);
        throw new NearAiError(`${label}: HTTP ${res.status}`);
      }
      const body = await this.readJson("signature", label, res);
      if (isRecord(body) && body.error_code !== undefined) {
        last = `unavailable: ${this.redact(String(body.message ?? body.error_code))}`;
        continue;
      }
      if (
        isRecord(body) &&
        body.signature_kind !== undefined &&
        body.signature_kind !== "provider_tee"
      ) {
        throw new NearAiError(
          `signature kind ${this.redact(String(body.signature_kind))} is not provider_tee`,
        );
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
            `${label}: ${error instanceof Error ? error.message : "malformed signature"}`,
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
      throw new NearAiError(`${label}: malformed response`);
    }
    throw new NearAiError(
      `provider_tee signature for ${this.redact(chatId)} unavailable after ${retries + 1} attempts (${last})`,
    );
  }

  /**
   * One attested proposal. Order (report §8 (iii), interfaces §7): the attestation report for the ledger nonce,
   * then the chat, then the signature. The request is built once by core's `buildProposalRequest`; these exact
   * bytes are sent and hashed, and `evidence.request_inputs` records what they were built from (not the
   * invoice text) so an auditor holding the invoice can run A8. Before anything is sent the inputs are held
   * to the shape that A8 requires (`proposalRequestInputsProblem`), so the adapter never produces evidence
   * that A8 would refuse for its shape. Any failure throws a `NearAiError` (a transport error, a timeout, a
   * non-JSON answer, a response above `MAX_RESPONSE_BODY_BYTES`, an invalid proposal); the caller then
   * decides rules-only.
   */
  async propose(input: ProposeInput): Promise<ProposeResult> {
    if (!isHex32(input.nonce)) {
      throw new NearAiError("nonce must be 64 lowercase hex characters (the ledger nonce)");
    }
    if (typeof input.invoiceText !== "string") {
      throw new NearAiError("invoiceText must be the text the model is asked about");
    }
    if (typeof input.facts !== "object" || input.facts === null) {
      throw new NearAiError("facts are required: the model is shown the invoice facts (ICR-3b)");
    }
    const invoiceHash = sha256Hex(utf8(input.invoiceText));
    if (input.facts.invoice_hash !== invoiceHash) {
      throw new NearAiError(
        "facts.invoice_hash must be sha256Hex(utf8(invoiceText)), the hash of the text the model sees (ICR-3b)",
      );
    }
    // ICR-3c: A8 accepts a po_ref only if it occurs verbatim in the invoice text. The adapter copies nothing
    // itself (the caller's extractor owns po_ref); it refuses facts that A8 would reject.
    if (input.facts.po_ref !== null && !input.invoiceText.includes(input.facts.po_ref)) {
      throw new NearAiError(
        "facts.po_ref must be null or copied verbatim from invoiceText: it is not a substring of the text (ICR-3c)",
      );
    }
    const systemPrompt = this.opts.systemPrompt ?? PROPOSAL_SYSTEM_PROMPT;
    // Held to A8's shape before any request, with a placeholder model id (the shape check does not depend on it).
    this.checkShape("unresolved", input, systemPrompt);

    const model = await this.resolveModel();
    const { body, requestInputs } = this.buildRequest(model, input, systemPrompt);

    const reports = await this.fetchModelReports(model, input.nonce);
    if (reports.length === 0) {
      throw new NearAiError(`model ${model} returned no attestation for this nonce`);
    }

    const label = "POST /chat/completions";
    const res = await this.call("chat", label, `${this.base}/chat/completions`, {
      method: "POST",
      headers: this.headers({
        "content-type": "application/json",
        "accept-encoding": "identity",
        "x-no-aliasing": "true",
      }),
      body,
    });
    if (!res.ok) {
      let preview = "";
      try {
        preview = new TextDecoder().decode(await readBody(res, ERROR_BODY_PREVIEW_BYTES, true));
      } catch {
        // the status is the useful part
      }
      throw new NearAiError(`${label}: HTTP ${res.status}: ${this.redact(preview).slice(0, 200)}`);
    }
    let responseBytes: Uint8Array;
    try {
      responseBytes = await readBody(res, MAX_RESPONSE_BODY_BYTES, false);
    } catch (error) {
      if (error instanceof NearAiResponseTooLargeError) throw error;
      throw this.failure("chat", label, error, "reading the response");
    }
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
    } catch (error) {
      throw new NearAiError("chat completion is not JSON", { cause: this.safeCause(error) });
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
        `invalid model proposal: ${this.redact(error instanceof Error ? error.message : String(error))}`,
        { cause: this.safeCause(error) },
      );
    }

    const usageRaw = isRecord(completion) && isRecord(completion.usage) ? completion.usage : null;
    const usage =
      usageRaw !== null &&
      typeof usageRaw.prompt_tokens === "number" &&
      typeof usageRaw.completion_tokens === "number"
        ? { promptTokens: usageRaw.prompt_tokens, completionTokens: usageRaw.completion_tokens }
        : null;
    const signature = await this.fetchSignature(chatId, model);
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

  /** Builds the request bytes and the `request_inputs` record for them, or throws a `NearAiError`. */
  private buildRequest(
    model: string,
    input: ProposeInput,
    systemPrompt: string,
  ): { body: Uint8Array; requestInputs: NonNullable<AttestationEvidence["request_inputs"]> } {
    try {
      return {
        body: utf8(buildProposalRequest(model, input, systemPrompt)),
        requestInputs: proposalRequestInputs(model, input, systemPrompt),
      };
    } catch (error) {
      throw new NearAiError(
        `cannot build the proposal request: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /** Holds the inputs to the strict shape A8 requires; nothing is sent for inputs that A8 would refuse. */
  private checkShape(model: string, input: ProposeInput, systemPrompt: string): void {
    const { requestInputs } = this.buildRequest(model, input, systemPrompt);
    const problem = proposalRequestInputsProblem(requestInputs);
    if (problem !== null) {
      throw new NearAiError(
        `the request would not have the shape that check A8 requires: ${problem}`,
      );
    }
  }
}
