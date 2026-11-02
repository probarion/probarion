// The optional online attestation checks of verify (interfaces §7): O1 verifies each TDX quote through DCAP and
// requires its verified report data to equal the evidence's `report_data`; O2 verifies the NVIDIA GPU payload
// through NRAS. Both use the network, so they run only when asked (`verify({ online: true })`).
import { bytesToHex, type CheckResult, type Snapshot, type VerifyReport } from "@probarion/core";

/** O1: DCAP verification of the TDX quote. O2: NVIDIA NRAS verification of the GPU payload. Both use the network. */
export interface OnlineAttestationVerifier {
  verifyQuote(intelQuoteHex: string): Promise<{ reportDataHex: string }>;
  verifyGpu(nvidiaPayload: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Uses @nearai/inference-sdk (optional peer dependency, Node 24.22.1+) when it is installed; otherwise null. */
export async function loadDefaultOnlineVerifier(): Promise<OnlineAttestationVerifier | null> {
  const specifier = "@nearai/inference-sdk";
  let mod: unknown;
  try {
    mod = await import(specifier);
  } catch {
    return null;
  }
  if (!isRecord(mod)) return null;
  const createTdx = mod.createTdxQuoteVerifier;
  const createGpu = mod.createGpuEvidenceVerifier;
  if (typeof createTdx !== "function" || typeof createGpu !== "function") return null;
  const tdx = createTdx() as (
    quote: string,
  ) => Promise<{ reportData: Uint8Array }> | { reportData: Uint8Array };
  const gpu = createGpu() as (payload: string) => Promise<void> | void;
  return {
    async verifyQuote(intelQuoteHex) {
      const result = await tdx(intelQuoteHex);
      if (!isRecord(result) || !(result.reportData instanceof Uint8Array)) {
        throw new Error("the TDX quote verifier returned no report data");
      }
      return { reportDataHex: bytesToHex(result.reportData) };
    },
    async verifyGpu(nvidiaPayload) {
      await gpu(nvidiaPayload);
    },
  };
}

/**
 * Folds O1 and O2 into check e. For every attested decision (`decided_by` model+rules with an attestation
 * report), O1 must verify the quote and give back exactly the recorded `report_data`, and O2 must verify the GPU
 * payload when there is one; the first entry that fails fails e at its seq. With no verifier (the SDK is not
 * installed) e says "online: unavailable" and keeps its offline status.
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
      const entry = snapshot.ledger[i];
      const att = entry?.body?.evidence?.report;
      if (entry === undefined || entry.body.decided_by !== "model+rules" || !isRecord(att))
        continue;
      try {
        const verified = await verifier.verifyQuote(String(att.intel_quote));
        if (
          String(verified.reportDataHex).toLowerCase() !== String(att.report_data).toLowerCase()
        ) {
          failure = {
            seq: i,
            detail: `O1 failed at entry ${i}: the verified quote's report data differs from the evidence report_data`,
          };
          continue;
        }
        quotes++;
        if (att.nvidia_payload !== null && att.nvidia_payload !== undefined) {
          await verifier.verifyGpu(String(att.nvidia_payload));
          gpus++;
        }
      } catch (error) {
        failure = { seq: i, detail: `O1/O2 failed at entry ${i}: ${messageOf(error)}` };
      }
    }
    updated =
      failure === null
        ? {
            ...e,
            detail: `${e.detail}; online: ${quotes} TDX quotes (O1) and ${gpus} GPU payloads (O2) verified`,
          }
        : {
            id: "e",
            name: e.name,
            status: "fail",
            detail: `online: ${failure.detail}; offline: ${e.detail}`,
            firstBrokenSeq: failure.seq,
          };
  }
  const checks = report.checks.map((c, i) => (i === index ? updated : c));
  return { ...report, checks, ok: checks.every((c) => c.status !== "fail") };
}
