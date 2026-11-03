// The optional online attestation checks of verify (interfaces §7, ruling T14-R1). Both use the network, so they
// run only when asked (`verify({ online: true })`):
//
// - O1: the TDX quote is verified through Intel DCAP and held to the policy of @nearai/inference-sdk's own
//   `verifyTdxQuote`: debug mode off, a TCB status the library accepts. The verified report data must equal the
//   evidence's `report_data`, which A4/A5 tie to the signer and this request's nonce. The TD's measurements
//   (mrConfigId, rtMr3, the deployment) are NOT pinned yet (O1b, deferred): O1 shows a DCAP-genuine TDX quote
//   bound to this request, not that the TD runs NEAR AI's published image, so `quote_verified` stays false.
// - O2: the NVIDIA GPU payload's own nonce must be this request's nonce, and NVIDIA NRAS must verify it.
import {
  bytesToHex,
  type CheckResult,
  reportOk,
  type Snapshot,
  type VerifyReport,
} from "@probarion/core";
import { isRecord, messageOf } from "./guards.js";

/** What DCAP verification of a TDX quote says (@nearai/inference-sdk `TdxQuoteVerificationResult`, as hex). */
export interface VerifiedTdxQuote {
  reportDataHex: string;
  tcbStatus: string;
  debugEnabled: boolean;
  advisoryIds?: readonly string[];
  mrConfigIdHex?: string;
  rtMr3Hex?: string;
}

/** O1: DCAP verification of the TDX quote. O2: NVIDIA NRAS verification of the GPU payload. Both use the network. */
export interface OnlineAttestationVerifier {
  verifyQuote(intelQuoteHex: string): Promise<VerifiedTdxQuote>;
  verifyGpu(nvidiaPayload: string): Promise<void>;
}

/**
 * The TCB statuses O1 accepts: the default policy of @nearai/inference-sdk 0.2.1 (`DEFAULT_ACCEPTED_TCB_STATUSES`,
 * applied by its `verifyTdxQuote`, which the package does not export). Revoked, Unknown and the
 * configuration-needed statuses are refused.
 */
export const ACCEPTED_TCB_STATUSES: readonly string[] = Object.freeze([
  "UpToDate",
  "OutOfDate",
  "TDRelaunchAdvised",
]);

/**
 * O1b, measurement pinning, is deferred (ICR-11). TODO(O1b): pin NEAR AI's published TD: the quote's
 * `mrConfigId` (the app-compose hash), `rtMr3` replayed from the event log, and the deployment (image provenance).
 * Until then `quote_verified` stays false, whatever O1 says.
 */
export const O1_MEASUREMENT_PINNED = false;

/** Why a DCAP-verified quote does not pass O1's policy for this evidence, or null when it does. */
export function o1PolicyProblem(quote: VerifiedTdxQuote, reportDataHex: string): string | null {
  if (!isRecord(quote)) return "the TDX quote verifier returned nothing";
  if (quote.debugEnabled !== false) return "the TD runs with debug enabled (policy.debug_enabled)";
  if (!ACCEPTED_TCB_STATUSES.includes(String(quote.tcbStatus))) {
    return `TCB status ${String(quote.tcbStatus)} is not accepted (accepted: ${ACCEPTED_TCB_STATUSES.join(", ")})`;
  }
  if (String(quote.reportDataHex).toLowerCase() !== String(reportDataHex).toLowerCase()) {
    return "the verified quote's report data differs from the evidence report_data";
  }
  return null;
}

/**
 * The nonce inside an NVIDIA GPU payload (a JSON object with a `nonce` of 32 bytes in hex, `0x` optional, as
 * @nearai/inference-sdk's `decodeNvidiaPayloadNonce` reads it), as 64 lowercase hex; null when there is none.
 */
export function nvidiaPayloadNonce(payload: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.nonce !== "string") return null;
  const hex = parsed.nonce.replace(/^0x/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

type ModuleLoader = (specifier: string) => Promise<unknown>;
const importModule: ModuleLoader = (specifier) => import(specifier);

const hexOf = (value: unknown): string | undefined =>
  value instanceof Uint8Array ? bytesToHex(value) : undefined;

/**
 * Uses @nearai/inference-sdk (optional peer dependency, Node 24.22.1+) when it can be loaded; otherwise null, and
 * verify says "online: unavailable". `load` replaces the dynamic import (tests).
 */
export async function loadDefaultOnlineVerifier(
  load: ModuleLoader = importModule,
): Promise<OnlineAttestationVerifier | null> {
  let mod: unknown;
  try {
    mod = await load("@nearai/inference-sdk");
  } catch {
    return null;
  }
  if (!isRecord(mod)) return null;
  const createTdx = mod.createTdxQuoteVerifier;
  const createGpu = mod.createGpuEvidenceVerifier;
  if (typeof createTdx !== "function" || typeof createGpu !== "function") return null;
  const tdx = createTdx() as (quote: string) => unknown;
  const gpu = createGpu() as (payload: string) => unknown;
  return {
    async verifyQuote(intelQuoteHex) {
      const result: unknown = await tdx(intelQuoteHex);
      if (!isRecord(result) || !(result.reportData instanceof Uint8Array)) {
        throw new Error("the TDX quote verifier returned no report data");
      }
      const mrConfigId = hexOf(result.mrConfigId);
      const rtMr3 = hexOf(result.rtMr3);
      return {
        reportDataHex: bytesToHex(result.reportData),
        tcbStatus: String(result.tcbStatus),
        // A result without the flag is read as debug: fail closed.
        debugEnabled: result.debugEnabled !== false,
        advisoryIds: Array.isArray(result.advisoryIds) ? result.advisoryIds.map(String) : [],
        ...(mrConfigId === undefined ? {} : { mrConfigIdHex: mrConfigId }),
        ...(rtMr3 === undefined ? {} : { rtMr3Hex: rtMr3 }),
      };
    },
    async verifyGpu(nvidiaPayload) {
      await gpu(nvidiaPayload);
    },
  };
}

/**
 * Folds O1 and O2 into check e (never upgrading it: an offline failure stays a failure). For every attested
 * decision (`decided_by` model+rules with an attestation report): O1 must verify the quote and pass
 * `o1PolicyProblem`; when there is a GPU payload, its nonce must be the evidence nonce and O2 must verify it. The
 * first entry that fails fails e; `firstBrokenSeq` is the lowest of the offline and the online seq. With no
 * verifier (the package is not installed) e says "online: unavailable" and keeps its offline result.
 */
export async function applyOnlineChecks(
  report: VerifyReport,
  snapshot: Snapshot,
  verifier: OnlineAttestationVerifier | null,
): Promise<VerifyReport> {
  const index = report.checks.findIndex((c) => c.id === "e");
  const e = report.checks[index];
  if (e === undefined) return report;
  let updated: CheckResult;
  if (verifier === null) {
    updated = {
      ...e,
      detail: `${e.detail}; online: unavailable (install @nearai/inference-sdk on Node 24.22.1+); O1 and O2 not run`,
    };
  } else {
    let quotes = 0;
    let gpus = 0;
    let failure: { seq: number; detail: string } | null = null;
    for (let i = 0; i < snapshot.ledger.length && failure === null; i++) {
      const body = snapshot.ledger[i]?.body;
      const evidence = body?.evidence;
      const att = evidence?.report;
      if (body === undefined || body.decided_by !== "model+rules" || !isRecord(att)) continue;
      try {
        const verified = await verifier.verifyQuote(String(att.intel_quote));
        const problem = o1PolicyProblem(verified, String(att.report_data));
        if (problem !== null) {
          failure = { seq: i, detail: `O1 failed at entry ${i}: ${problem}` };
          continue;
        }
        quotes++;
        if (att.nvidia_payload !== null && att.nvidia_payload !== undefined) {
          const payload = String(att.nvidia_payload);
          const nonce = nvidiaPayloadNonce(payload);
          if (nonce === null) {
            failure = {
              seq: i,
              detail: `O2 failed at entry ${i}: the GPU payload carries no 32-byte nonce`,
            };
            continue;
          }
          if (nonce !== String(evidence?.nonce).toLowerCase()) {
            failure = {
              seq: i,
              detail: `O2 failed at entry ${i}: the GPU payload's nonce is not this request's nonce (a payload from another session)`,
            };
            continue;
          }
          await verifier.verifyGpu(payload);
          gpus++;
        }
      } catch (error) {
        failure = { seq: i, detail: `O1/O2 failed at entry ${i}: ${messageOf(error)}` };
      }
    }
    if (failure === null) {
      updated = {
        ...e,
        detail: `${e.detail}; online: ${quotes} DCAP-genuine TDX quotes bound to this request (O1: debug off, an accepted TCB status, report_data matches; measurement not pinned, so quote_verified stays false) and ${gpus} GPU payloads bound to the request nonce and verified by NRAS (O2)`,
      };
    } else {
      const offline =
        e.status === "fail" && typeof e.firstBrokenSeq === "number" ? e.firstBrokenSeq : null;
      updated = {
        id: "e",
        name: e.name,
        status: "fail",
        detail: `online: ${failure.detail}; offline: ${e.detail}`,
        firstBrokenSeq: offline === null ? failure.seq : Math.min(offline, failure.seq),
      };
    }
  }
  const checks = report.checks.map((c, i) => (i === index ? updated : c));
  // T14-R2: a report is ok only when no check failed and none is unproven.
  return { ...report, checks, ok: reportOk(checks) };
}
