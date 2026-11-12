import "server-only";
import { extractReportDataFromQuote, NEARAI_BASE_URL } from "@probarion/core";
import {
  loadDefaultOnlineVerifier,
  nvidiaPayloadNonce,
  type OnlineAttestationVerifier,
  o1PolicyProblem,
  PREFERRED_PRIVATE_MODELS,
  parseModelReports,
  type RawModelReport,
} from "@probarion/sdk";
import { within } from "@/lib/within";
import {
  MAX_ATTESTATIONS,
  MAX_REPORT_BYTES,
  REPORT_TIMEOUT_MS,
  TEE_CHECK_BUDGET_MS,
} from "./limits";
import {
  bindingRow,
  nonceProblem,
  signerProblem,
  type TeeAttestationValues,
  type TeeCheckResult,
  type TeeCheckRow,
  type TeeStatus,
} from "./recheck";

// The live TEE check behind /proof's "Check the TEE now" (GET /api/tee/check). With the visitor's fresh nonce it asks
// NEAR AI Cloud for the attestation report of the model Payables uses (the public report endpoint: no API key is sent),
// then checks the model attestations in it:
//
// - nonce: report_data[32..64] and request_nonce are the visitor's nonce (core's A5, on a nonce nobody chose before);
// - signer: report_data[0..32] is the zero-padded signing address (core's A4);
// - O1: Intel DCAP verifies the TDX quote, held to the SDK's policy (o1PolicyProblem: debug off, an accepted TCB status,
//   the verified report data equal to the quote's);
// - O2: each GPU payload carries the nonce, and NVIDIA NRAS verifies it.
//
// It checks the TEE that serves the model now. It does not re-check a past decision: the per-decision checks A1 to A7
// on /proof read the ledger and nothing here. The gateway's own attestation in the same report is not checked, and the
// TEE measurement is not pinned (docs/measurement-pin-2026-11.md). A check that cannot run (NEAR AI, Intel or NVIDIA
// does not answer in time, or the verifier does not load) is "unavailable", never a pass or a fail.

const MAX_DETAIL = 240;
const NOT_LOADED =
  "the verifier (@nearai/inference-sdk) could not be loaded here: run probarion verify --online";

/** Verifier errors that are a verdict on the evidence; any other error means the check could not run. */
const O1_VERDICTS: readonly string[] = [
  "quote.verification_failed",
  "quote.unsupported_report_type",
];
const O2_VERDICTS: readonly string[] = ["gpu.attestation_rejected", "gpu.payload_invalid"];

/**
 * The models to ask, in order: NEARAI_MODEL when it is set (the model Payables uses), else the SDK's preferred private
 * models. The first that answers with a model attestation is checked.
 */
export function teeCheckModels(configured: string | null | undefined): readonly string[] {
  const model = configured?.trim();
  return model ? [model] : PREFERRED_PRIVATE_MODELS;
}

let verifier: Promise<OnlineAttestationVerifier | null> | null = null;

/**
 * O1 and O2's verifier from @nearai/inference-sdk, loaded once per server instance; null when it cannot be loaded. The
 * specifier is written out, so Next's file tracing ships the package (and @phala/dcap-qvl) with the route: the SDK's own
 * default loader imports a variable name, which tracing cannot follow.
 */
export function loadTeeVerifier(): Promise<OnlineAttestationVerifier | null> {
  verifier ??= loadDefaultOnlineVerifier(() => import("@nearai/inference-sdk"));
  return verifier;
}

export interface TeeCheckDeps {
  fetch?: typeof fetch;
  loadVerifier?: () => Promise<OnlineAttestationVerifier | null>;
  /** Milliseconds since the epoch. */
  now?: () => number;
  budgetMs?: number;
  reportTimeoutMs?: number;
  baseUrl?: string;
}

/** Text from an error or a remote answer, on one line and short. */
function short(text: string): string {
  const line = text.replace(/\p{Cc}+/gu, " ").trim();
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 3)}...` : line;
}

const messageOf = (error: unknown) => short(error instanceof Error ? error.message : String(error));

/** The `failure.code` of an @nearai/inference-sdk VerificationError, or null. */
function failureCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const failure = (error as { failure?: unknown }).failure;
  if (typeof failure !== "object" || failure === null) return null;
  const code = (failure as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Reads at most `limit` bytes of a body, else throws. */
async function readCapped(res: Response, limit: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`the report is larger than ${limit} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

type ReportRead = { ok: true; reports: RawModelReport[] } | { ok: false; reason: string };

/** One report for `model` and `nonce`, its model attestations parsed by the SDK. No API key is sent. */
async function readReport(
  doFetch: typeof fetch,
  base: string,
  model: string,
  nonce: string,
  timeoutMs: number,
): Promise<ReportRead> {
  const url = new URL(`${base}/attestation/report`);
  url.searchParams.set("model", model);
  url.searchParams.set("signing_algo", "ecdsa");
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("provider", "near");
  url.searchParams.set("include_tls_fingerprint", "false");
  try {
    const res = await doFetch(url, {
      headers: { accept: "application/json", "x-no-aliasing": "true" },
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      cache: "no-store",
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `NEAR AI answered HTTP ${res.status} for ${model}` };
    }
    const json: unknown = JSON.parse(await readCapped(res, MAX_REPORT_BYTES));
    return { ok: true, reports: parseModelReports(json) };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      reason: timedOut
        ? `NEAR AI did not answer within ${Math.round(timeoutMs / 1000)} s for ${model}`
        : `NEAR AI's report for ${model} could not be read (${messageOf(error)})`,
    };
  }
}

interface One {
  status: TeeStatus;
  detail: string;
}

/** O1 for one attestation: the DCAP-verified quote, held to o1PolicyProblem. */
async function runO1(
  v: OnlineAttestationVerifier,
  r: RawModelReport,
  reportData: string,
  ms: number,
): Promise<One & { tcb: string | null }> {
  try {
    const quote = await within(() => v.verifyQuote(r.intel_quote), ms);
    const problem = o1PolicyProblem(quote, reportData);
    if (problem !== null) return { status: "fail", detail: short(problem), tcb: quote.tcbStatus };
    return {
      status: "pass",
      detail: `Intel DCAP verified the TDX quote: debug off, TCB status ${quote.tcbStatus}, report data matches`,
      tcb: quote.tcbStatus,
    };
  } catch (error) {
    const code = failureCode(error);
    const status = code !== null && O1_VERDICTS.includes(code) ? "fail" : "unavailable";
    return { status, detail: messageOf(error), tcb: null };
  }
}

/** O2 for one attestation: the GPU payload carries the nonce, and NVIDIA NRAS verifies it. */
async function runO2(
  v: OnlineAttestationVerifier | null,
  r: RawModelReport,
  nonce: string,
  ms: number,
): Promise<One & { gpu: TeeAttestationValues["gpu"] }> {
  if (r.nvidia_payload === null) {
    return { status: "unavailable", detail: "the report carries no GPU evidence", gpu: "none" };
  }
  const payloadNonce = nvidiaPayloadNonce(r.nvidia_payload);
  if (payloadNonce === null) {
    return { status: "fail", detail: "the GPU payload carries no 32-byte nonce", gpu: "fail" };
  }
  if (payloadNonce !== nonce) {
    return { status: "fail", detail: "the GPU payload's nonce is not this nonce", gpu: "fail" };
  }
  if (v === null) return { status: "unavailable", detail: NOT_LOADED, gpu: "unavailable" };
  try {
    await within(() => v.verifyGpu(r.nvidia_payload ?? ""), ms);
    return {
      status: "pass",
      detail: "the GPU payload carries this nonce, and NVIDIA NRAS verified it",
      gpu: "pass",
    };
  } catch (error) {
    const code = failureCode(error);
    const status = code !== null && O2_VERDICTS.includes(code) ? "fail" : "unavailable";
    return { status, detail: messageOf(error), gpu: status };
  }
}

/** One row over several attestations: a fail wins, then unavailable; with one attestation, its own detail. */
function fold(id: "o1" | "o2", results: readonly (One & { signer: string })[]): TeeCheckRow {
  if (results.length === 0)
    return { id, status: "unavailable", detail: "no model attestation to check" };
  const named = (r: One & { signer: string }) =>
    results.length > 1 ? `${r.signer}: ${r.detail}` : r.detail;
  const worst =
    results.find((r) => r.status === "fail") ??
    results.find((r) => r.status === "unavailable") ??
    null;
  if (worst !== null) return { id, status: worst.status, detail: named(worst) };
  const first = results[0];
  const detail =
    results.length === 1 && first
      ? first.detail
      : `${results[0]?.detail}, for all ${results.length} attestations`;
  return { id, status: "pass", detail };
}

/**
 * The live check for `nonce` (64 lowercase hex, which the route has checked) against the first of `models` that answers
 * with a model attestation. It never throws: whatever fails upstream is an unavailable row.
 */
export async function checkTee(
  nonce: string,
  models: readonly string[],
  deps: TeeCheckDeps = {},
): Promise<TeeCheckResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = started + (deps.budgetMs ?? TEE_CHECK_BUDGET_MS);
  const left = () => deadline - now();
  const base = (deps.baseUrl ?? NEARAI_BASE_URL).replace(/\/+$/, "");
  const doFetch = deps.fetch ?? globalThis.fetch;
  const result = (
    model: string | null,
    checks: TeeCheckRow[],
    attestations: TeeAttestationValues[],
  ): TeeCheckResult => ({
    nonce,
    model,
    checked_at: new Date(now()).toISOString(),
    elapsed_ms: Math.max(0, now() - started),
    checks,
    attestations,
  });
  const allUnavailable = (detail: string): TeeCheckRow[] =>
    (["nonce", "signer", "o1", "o2"] as const).map((id) => ({ id, status: "unavailable", detail }));

  // Loaded while the report is fetched.
  const loading = (deps.loadVerifier ?? loadTeeVerifier)().catch(() => null);

  let model: string | null = null;
  let reports: RawModelReport[] = [];
  let reason = "no model to ask";
  for (const m of models) {
    if (left() < 1000) {
      reason = `the time for the check ran out before NEAR AI answered for ${m}`;
      break;
    }
    const read = await readReport(
      doFetch,
      base,
      m,
      nonce,
      Math.min(deps.reportTimeoutMs ?? REPORT_TIMEOUT_MS, left()),
    );
    if (!read.ok) {
      reason = read.reason;
      // A model that is not configured may just not be served: the next one is asked.
      continue;
    }
    if (read.reports.length > 0) {
      model = m;
      reports = read.reports.slice(0, MAX_ATTESTATIONS);
      break;
    }
    reason = `NEAR AI's report for ${m} holds no model attestation`;
  }
  if (model === null) return result(null, allUnavailable(short(reason)), []);

  const values: TeeAttestationValues[] = reports.map((r) => ({
    signing_address: r.signing_address,
    request_nonce: r.request_nonce,
    report_data: extractReportDataFromQuote(r.intel_quote) ?? "",
    tcb_status: null,
    gpu: r.nvidia_payload === null ? "none" : "unavailable",
  }));
  const checks: TeeCheckRow[] = [
    bindingRow("nonce", values, (a) => nonceProblem(a, nonce)),
    bindingRow("signer", values, signerProblem),
  ];

  const v = await within(() => loading, Math.max(1, left())).catch(() => null);
  const ms = Math.max(1, left());
  const [o1, o2] = await Promise.all([
    Promise.all(
      reports.map(async (r, i) => {
        const reportData = values[i]?.report_data ?? "";
        if (v === null) return { status: "unavailable" as const, detail: NOT_LOADED, tcb: null };
        if (reportData === "") {
          return { status: "fail" as const, detail: "the quote is not a TDX quote", tcb: null };
        }
        return runO1(v, r, reportData, ms);
      }),
    ),
    Promise.all(reports.map((r) => runO2(v, r, nonce, ms))),
  ]);
  values.forEach((a, i) => {
    a.tcb_status = o1[i]?.tcb ?? null;
    a.gpu = o2[i]?.gpu ?? a.gpu;
  });
  const signed = <T extends One>(list: readonly T[]) =>
    list.map((r, i) => ({ ...r, signer: values[i]?.signing_address ?? "" }));
  checks.push(fold("o1", signed(o1)), fold("o2", signed(o2)));
  return result(model, checks, values);
}
