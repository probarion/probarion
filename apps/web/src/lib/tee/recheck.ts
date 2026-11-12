// The live TEE check on /proof (GET /api/tee/check): the answer's shape, and the two binding checks that both the server
// and the visitor's browser run on it. No React and no server code here, and no import of @probarion/core, so the
// panel's client bundle stays small. The browser re-checks the bindings with the nonce it drew itself, so it does not
// have to take the server's word for them. It takes report_data as the server read it from the TDX quote; O1, on the
// server, is what verifies that quote.

/** pass and fail are verdicts. unavailable: the check could not run (NEAR AI, Intel or NVIDIA did not answer in time,
 * or the verifier could not be loaded), which is never a pass and never a fail. */
export type TeeStatus = "pass" | "fail" | "unavailable";

export type TeeCheckId = "nonce" | "signer" | "o1" | "o2";

export interface TeeCheckRow {
  id: TeeCheckId;
  status: TeeStatus;
  detail: string;
}

/** What the browser needs from one model attestation to re-check the bindings, and the verdicts for it. */
export interface TeeAttestationValues {
  signing_address: string;
  request_nonce: string;
  /** 128 hex: the report data inside the TDX quote, as the server read it; "" when the quote holds none. */
  report_data: string;
  /** The quote's TCB status as Intel DCAP verified it (O1), or null when O1 did not verify it. */
  tcb_status: string | null;
  /** NVIDIA NRAS's verdict on this attestation's GPU evidence (O2); "none" when the report carries none. */
  gpu: TeeStatus | "none";
}

/** The answer of GET /api/tee/check: nothing else of NEAR AI's report (about 290 KB) is passed on. */
export interface TeeCheckResult {
  nonce: string;
  /** The model whose TEE was asked, or null when no model answered with an attestation. */
  model: string | null;
  checked_at: string;
  elapsed_ms: number;
  checks: TeeCheckRow[];
  attestations: TeeAttestationValues[];
}

/** 32 bytes as 64 lowercase hex: the only nonce the route takes. */
export const TEE_NONCE_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const REPORT_DATA_RE = /^[0-9a-f]{128}$/;

export function isTeeNonce(value: unknown): value is string {
  return typeof value === "string" && TEE_NONCE_RE.test(value);
}

/** 32 random bytes as 64 lowercase hex. `random` fills the array (the browser's crypto.getRandomValues). */
export function drawNonce(random: (bytes: Uint8Array) => Uint8Array): string {
  const bytes = random(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Why report_data[32..64] or request_nonce is not `nonce`, or null when both are (core's A5, on a fresh nonce). */
export function nonceProblem(a: TeeAttestationValues, nonce: string): string | null {
  const reportData = String(a.report_data).toLowerCase();
  if (!REPORT_DATA_RE.test(reportData)) return "the TDX quote holds no 64-byte report data";
  if (reportData.slice(64) !== nonce) return "report_data[32..64] is not this nonce";
  if (String(a.request_nonce).toLowerCase() !== nonce) return "request_nonce is not this nonce";
  return null;
}

/** Why report_data[0..32] is not the zero-padded signing address, or null when it is (core's A4). */
export function signerProblem(a: TeeAttestationValues): string | null {
  const reportData = String(a.report_data).toLowerCase();
  if (!REPORT_DATA_RE.test(reportData)) return "the TDX quote holds no 64-byte report data";
  const address = String(a.signing_address);
  if (!ADDRESS_RE.test(address)) return "the signing address is not a 20-byte EVM address";
  if (reportData.slice(0, 64) !== `${address.slice(2).toLowerCase()}${"0".repeat(24)}`) {
    return "report_data[0..32] is not the zero-padded signing address";
  }
  return null;
}

/** One check over every attestation: pass when each passes, else the first problem, named by its signer when several. */
export function bindingRow(
  id: "nonce" | "signer",
  attestations: readonly TeeAttestationValues[],
  why: (a: TeeAttestationValues) => string | null,
): TeeCheckRow {
  if (attestations.length === 0) {
    return { id, status: "unavailable", detail: "no model attestation to check" };
  }
  for (const a of attestations) {
    const p = why(a);
    if (p !== null) {
      const who = attestations.length > 1 ? `${a.signing_address}: ` : "";
      return { id, status: "fail", detail: `${who}${p}` };
    }
  }
  const pass =
    id === "nonce"
      ? "report_data[32..64] and request_nonce equal this nonce"
      : "report_data[0..32] is the zero-padded signing address";
  const n = attestations.length;
  return { id, status: "pass", detail: n === 1 ? pass : `${pass}, for all ${n} attestations` };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const STATUSES: readonly string[] = ["pass", "fail", "unavailable"];

function attestationOf(v: unknown): TeeAttestationValues | null {
  if (!isRecord(v)) return null;
  const { signing_address, request_nonce, report_data, tcb_status, gpu } = v;
  if (typeof signing_address !== "string" || typeof request_nonce !== "string") return null;
  if (typeof report_data !== "string") return null;
  return {
    signing_address,
    request_nonce,
    report_data,
    tcb_status: typeof tcb_status === "string" ? tcb_status : null,
    gpu:
      typeof gpu === "string" && [...STATUSES, "none"].includes(gpu) ? (gpu as TeeStatus) : "none",
  };
}

/** The route's answer read as untrusted JSON, or null when it is not one. */
export function readTeeAnswer(json: unknown): TeeCheckResult | null {
  if (!isRecord(json) || !Array.isArray(json.checks) || !Array.isArray(json.attestations)) {
    return null;
  }
  const checks: TeeCheckRow[] = [];
  for (const c of json.checks) {
    if (!isRecord(c) || typeof c.detail !== "string" || !STATUSES.includes(String(c.status))) {
      return null;
    }
    if (!["nonce", "signer", "o1", "o2"].includes(String(c.id))) return null;
    checks.push({ id: c.id as TeeCheckId, status: c.status as TeeStatus, detail: c.detail });
  }
  const attestations = json.attestations.map(attestationOf);
  if (attestations.some((a) => a === null)) return null;
  return {
    nonce: typeof json.nonce === "string" ? json.nonce : "",
    model: typeof json.model === "string" ? json.model : null,
    checked_at: typeof json.checked_at === "string" ? json.checked_at : "",
    elapsed_ms: typeof json.elapsed_ms === "number" ? json.elapsed_ms : 0,
    checks,
    attestations: attestations as TeeAttestationValues[],
  };
}

/**
 * The checks as the panel shows them: the two bindings as this browser re-checked them with its own `nonce` (whatever
 * the server said about them), then O1 and O2 as the server ran them. An answer for another nonce fails both bindings.
 */
export function recheckInBrowser(answer: TeeCheckResult, nonce: string): TeeCheckRow[] {
  const server = (id: "o1" | "o2"): TeeCheckRow =>
    answer.checks.find((c) => c.id === id) ?? {
      id,
      status: "unavailable",
      detail: "the server sent no result for this check",
    };
  if (answer.nonce !== nonce) {
    const detail = "the answer is for another nonce than the one this browser drew";
    return [
      { id: "nonce", status: "fail", detail },
      { id: "signer", status: "fail", detail },
      server("o1"),
      server("o2"),
    ];
  }
  return [
    bindingRow("nonce", answer.attestations, (a) => nonceProblem(a, nonce)),
    bindingRow("signer", answer.attestations, signerProblem),
    server("o1"),
    server("o2"),
  ];
}

/** Every check passed: the panel's one-line verdict. */
export function allPass(rows: readonly TeeCheckRow[]): boolean {
  return rows.length > 0 && rows.every((r) => r.status === "pass");
}

export type BrowserCheck =
  | { ok: true; nonce: string; answer: TeeCheckResult; rows: TeeCheckRow[]; tookMs: number }
  | { ok: false; nonce: string; message: string };

export interface BrowserCheckDeps {
  fetch: typeof fetch;
  /** Fills the array with random bytes: crypto.getRandomValues. */
  random: (bytes: Uint8Array) => Uint8Array;
  /** Milliseconds, for the time the check took here (performance.now). */
  now: () => number;
}

/**
 * What the panel's button does: draw a nonce, ask the route, read the answer as untrusted JSON and re-check the bindings
 * with the nonce drawn here. Only the nonce is sent. Never throws.
 */
export async function checkFromBrowser(deps: BrowserCheckDeps): Promise<BrowserCheck> {
  const nonce = drawNonce(deps.random);
  const started = deps.now();
  let res: Response;
  try {
    res = await deps.fetch(`/api/tee/check?nonce=${nonce}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    return { ok: false, nonce, message: "The check could not be reached." };
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after"));
    const when = Number.isFinite(wait) && wait > 0 ? `in ${Math.ceil(wait)} s` : "in a minute";
    return {
      ok: false,
      nonce,
      message: `Too many checks from all visitors together. Try again ${when}.`,
    };
  }
  if (!res.ok) {
    return { ok: false, nonce, message: `The check did not run (HTTP ${res.status}).` };
  }
  const answer = readTeeAnswer(await res.json().catch(() => null));
  if (answer === null) return { ok: false, nonce, message: "The answer could not be read." };
  return {
    ok: true,
    nonce,
    answer,
    rows: recheckInBrowser(answer, nonce),
    tookMs: Math.max(0, deps.now() - started),
  };
}
