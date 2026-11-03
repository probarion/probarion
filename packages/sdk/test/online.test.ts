import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { extractReportDataFromQuote, runChecks, type Snapshot } from "@probarion/core";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_TCB_STATUSES,
  applyOnlineChecks,
  loadDefaultOnlineVerifier,
  nvidiaPayloadNonce,
  O1_MEASUREMENT_PINNED,
  type OnlineAttestationVerifier,
  type VerifiedTdxQuote,
} from "../src/online.js";

const NOW = new Date("2026-11-05T12:30:00.000Z");

async function fixture(): Promise<Snapshot> {
  return JSON.parse(
    await readFile(
      new URL("../../core/test/fixtures/valid-snapshot.json", import.meta.url),
      "utf8",
    ),
  ) as Snapshot;
}

/** A DCAP result as an honest TD gives it: the quote's own report data, debug off, an up-to-date TCB. */
const genuine = (quote: string): VerifiedTdxQuote => ({
  reportDataHex: extractReportDataFromQuote(quote) ?? "",
  tcbStatus: "UpToDate",
  debugEnabled: false,
});

const honest: OnlineAttestationVerifier = {
  verifyQuote: async (quote) => genuine(quote),
  verifyGpu: async () => {},
};

const checkE = (report: Awaited<ReturnType<typeof runChecks>>) =>
  report.checks.find((c) => c.id === "e");

async function online(verifier: OnlineAttestationVerifier | null, s?: Snapshot) {
  const snapshot = s ?? (await fixture());
  return applyOnlineChecks(await runChecks(snapshot, { now: NOW }), snapshot, verifier);
}

/** The fixture with a GPU payload on the attested decision at seq 2, whose nonce is `nonce` (default its own). */
async function withGpuPayload(nonce?: string): Promise<Snapshot> {
  const s = await fixture();
  const evidence = s.ledger[2]?.body.evidence;
  if (evidence === null || evidence === undefined || evidence.report === null) {
    throw new Error("fixture report missing");
  }
  evidence.report.nvidia_payload = JSON.stringify({
    nonce: nonce ?? evidence.nonce,
    evidence_list: [],
    arch: "HOPPER",
  });
  return s;
}

describe("applyOnlineChecks: O1 (DCAP plus the library's policy) and O2 (NRAS, nonce-bound)", () => {
  it("adds O1/O2 results to check e when every quote verifies, and says the measurement is not pinned", async () => {
    const report = await online(honest);
    expect(report.ok).toBe(true);
    const detail = checkE(report)?.detail ?? "";
    expect(detail).toContain("online: 2 DCAP-genuine TDX quotes bound to this request (O1");
    expect(detail).toContain("measurement not pinned, so quote_verified stays false");
    expect(O1_MEASUREMENT_PINNED).toBe(false);
  });

  it("fails O1 for a quote from a debug TD, or one the verifier does not say is non-debug", async () => {
    for (const debugEnabled of [true, undefined]) {
      const report = await online({
        ...honest,
        verifyQuote: async (q) => ({ ...genuine(q), debugEnabled }) as VerifiedTdxQuote,
      });
      expect(checkE(report)).toMatchObject({ status: "fail", firstBrokenSeq: 0 });
      expect(checkE(report)?.detail).toContain(
        "O1 failed at entry 0: the TD runs with debug enabled",
      );
    }
  });

  it("fails O1 for a TCB status the library's policy refuses (Revoked, Unknown, ConfigurationNeeded)", async () => {
    expect(ACCEPTED_TCB_STATUSES).toEqual(["UpToDate", "OutOfDate", "TDRelaunchAdvised"]);
    for (const tcbStatus of [
      "Revoked",
      "Unknown",
      "ConfigurationNeeded",
      "SWHardeningNeeded",
      "",
    ]) {
      const report = await online({
        ...honest,
        verifyQuote: async (q) => ({ ...genuine(q), tcbStatus }),
      });
      expect(checkE(report), tcbStatus).toMatchObject({ status: "fail", firstBrokenSeq: 0 });
      expect(checkE(report)?.detail).toContain(`TCB status ${tcbStatus} is not accepted`);
    }
    for (const tcbStatus of ACCEPTED_TCB_STATUSES) {
      const report = await online({
        ...honest,
        verifyQuote: async (q) => ({ ...genuine(q), tcbStatus }),
      });
      expect(report.ok, tcbStatus).toBe(true);
    }
  });

  it("fails e at the first entry whose quote does not verify, and says so first", async () => {
    const report = await online({
      ...honest,
      verifyQuote: async () => Promise.reject(new Error("quote.verification_failed")),
    });
    expect(report.ok).toBe(false);
    expect(checkE(report)).toMatchObject({ status: "fail", firstBrokenSeq: 0 });
    expect(checkE(report)?.detail).toMatch(
      /^online: O1\/O2 failed at entry 0: quote.verification_failed; offline: /,
    );
  });

  it("fails e when the verified report data differs from the evidence", async () => {
    const report = await online({
      ...honest,
      verifyQuote: async (q) => ({ ...genuine(q), reportDataHex: "00".repeat(64) }),
    });
    expect(checkE(report)).toMatchObject({ status: "fail", firstBrokenSeq: 0 });
    expect(checkE(report)?.detail).toContain(
      "O1 failed at entry 0: the verified quote's report data differs",
    );
  });

  it("binds the GPU payload to the request nonce before NRAS sees it (O2)", async () => {
    const seen: string[] = [];
    const counting: OnlineAttestationVerifier = {
      ...honest,
      verifyGpu: async (p) => {
        seen.push(p);
      },
    };
    const bound = await withGpuPayload();
    const ok = await online(counting, bound);
    // Editing the payload changes the entry body (a and b fail); e is what this test is about.
    expect(checkE(ok)?.status).toBe("pass");
    expect(checkE(ok)?.detail).toContain(
      "and 1 GPU payloads bound to the request nonce and verified by NRAS (O2)",
    );
    expect(seen).toHaveLength(1);
    // A payload replayed from another session: NRAS would accept it, the nonce does not.
    const replayed = await online(counting, await withGpuPayload("ab".repeat(32)));
    expect(checkE(replayed)).toMatchObject({ status: "fail", firstBrokenSeq: 2 });
    expect(checkE(replayed)?.detail).toContain(
      "O2 failed at entry 2: the GPU payload's nonce is not this request's nonce",
    );
    expect(seen).toHaveLength(1); // never sent to NRAS
    const noNonce = await fixture();
    const report = noNonce.ledger[2]?.body.evidence?.report;
    if (report === null || report === undefined) throw new Error("fixture");
    report.nvidia_payload = "TEST GPU payload without a nonce";
    expect(checkE(await online(counting, noNonce))?.detail).toContain(
      "the GPU payload carries no 32-byte nonce",
    );
    const refusing = {
      ...honest,
      verifyGpu: async () => Promise.reject(new Error("gpu.nras_request_failed")),
    };
    expect(checkE(await online(refusing, await withGpuPayload()))).toMatchObject({
      status: "fail",
      firstBrokenSeq: 2,
    });
  });

  it("reads the payload nonce as the library does: 32 bytes of hex, 0x optional, any case", () => {
    const n = "Cd".repeat(32);
    expect(nvidiaPayloadNonce(JSON.stringify({ nonce: n }))).toBe(n.toLowerCase());
    expect(nvidiaPayloadNonce(JSON.stringify({ nonce: `0x${n}` }))).toBe(n.toLowerCase());
    for (const bad of [
      "{}",
      "not json",
      JSON.stringify({ nonce: "ab" }),
      JSON.stringify({ nonce: 5 }),
      "[]",
    ]) {
      expect(nvidiaPayloadNonce(bad), bad).toBeNull();
    }
  });

  it("never upgrades an offline failure, and reports the lowest broken seq of the two", async () => {
    const broken = await fixture();
    const second = broken.ledger[2]?.body.evidence;
    if (second === null || second === undefined) throw new Error("fixture");
    second.chat_id = "chatcmpl-tampered"; // A7 fails offline at seq 2
    const offline = await runChecks(broken, { now: NOW });
    expect(checkE(offline)).toMatchObject({ status: "fail", firstBrokenSeq: 2 });
    const allVerified = await applyOnlineChecks(offline, broken, honest);
    expect(checkE(allVerified)).toMatchObject({ status: "fail", firstBrokenSeq: 2 });
    expect(allVerified.ok).toBe(false);
    const firstFails = await applyOnlineChecks(offline, broken, {
      ...honest,
      verifyQuote: async (q) => ({ ...genuine(q), tcbStatus: "Revoked" }),
    });
    expect(checkE(firstFails)).toMatchObject({ status: "fail", firstBrokenSeq: 0 });
    // The offline seq is the lower one: offline fails at 0, online at 2, and the report says 0.
    const early = await fixture();
    const first = early.ledger[0]?.body.evidence;
    if (first === null || first === undefined) throw new Error("fixture");
    first.chat_id = "chatcmpl-tampered";
    const earlyOffline = await runChecks(early, { now: NOW });
    expect(checkE(earlyOffline)).toMatchObject({ status: "fail", firstBrokenSeq: 0 });
    let call = 0;
    const secondRevoked = await applyOnlineChecks(earlyOffline, early, {
      ...honest,
      verifyQuote: async (q) => ({
        ...genuine(q),
        tcbStatus: call++ === 0 ? "UpToDate" : "Revoked",
      }),
    });
    expect(checkE(secondRevoked)?.detail).toContain("O1 failed at entry 2");
    expect(checkE(secondRevoked)).toMatchObject({ status: "fail", firstBrokenSeq: 0 });
  });

  it("keeps ok false for an unproven h, however well every quote verifies (T14-R2)", async () => {
    const snapshot = await fixture();
    const spend = snapshot.chain.spends[1];
    const burn = snapshot.chain.burns[0];
    if (spend === undefined || burn === undefined) throw new Error("fixture");
    spend.held_until_ns = "1793900000000000000";
    snapshot.chain.burns = [
      { ...burn, tx_hash: "", status: "missing", memo: "", intents_owner: "", amount: "" },
    ];
    const offline = await runChecks(snapshot, { now: NOW });
    expect(offline.checks.find((c) => c.id === "h")?.status).toBe("unproven");
    const report = await applyOnlineChecks(offline, snapshot, honest);
    expect(checkE(report)?.status).toBe("pass");
    expect(report.ok).toBe(false);
    expect(report.unproven).toEqual([{ check: "h", spend_id: 2, reason: "approver_tx" }]);
  });

  it("reports unavailability without changing the offline result", async () => {
    const snapshot = await fixture();
    const offline = await runChecks(snapshot, { now: NOW });
    const report = await applyOnlineChecks(offline, snapshot, null);
    expect(report.ok).toBe(offline.ok);
    expect(checkE(report)?.status).toBe(checkE(offline)?.status);
    expect(checkE(report)?.detail).toContain("online: unavailable");
  });
});

describe("loadDefaultOnlineVerifier", () => {
  it("is null when the package cannot be loaded, or does not export the verifiers, and verify says unavailable", async () => {
    expect(
      await loadDefaultOnlineVerifier(async () => Promise.reject(new Error("Cannot find package"))),
    ).toBeNull();
    expect(await loadDefaultOnlineVerifier(async () => ({}))).toBeNull();
    expect(
      await loadDefaultOnlineVerifier(async () => ({ createTdxQuoteVerifier: () => () => {} })),
    ).toBeNull();
    expect(await loadDefaultOnlineVerifier(async () => null)).toBeNull();
    const snapshot = await fixture();
    const report = await applyOnlineChecks(await runChecks(snapshot, { now: NOW }), snapshot, null);
    expect(checkE(report)?.detail).toContain("online: unavailable (install @nearai/inference-sdk");
  });

  it("maps the library's result, reads a missing debug flag as debug, and leaves the policy to O1", async () => {
    const reportData = new Uint8Array(64).fill(7);
    const verifier = await loadDefaultOnlineVerifier(async () => ({
      createTdxQuoteVerifier: () => async () => ({
        tcbStatus: "UpToDate",
        advisoryIds: ["INTEL-SA-1"],
        debugEnabled: false,
        reportData,
        mrConfigId: new Uint8Array([1, 2]),
        rtMr3: new Uint8Array([3]),
      }),
      createGpuEvidenceVerifier: () => async () => {},
    }));
    expect(await verifier?.verifyQuote("00")).toEqual({
      reportDataHex: "07".repeat(64),
      tcbStatus: "UpToDate",
      debugEnabled: false,
      advisoryIds: ["INTEL-SA-1"],
      mrConfigIdHex: "0102",
      rtMr3Hex: "03",
    });
    const noFlag = await loadDefaultOnlineVerifier(async () => ({
      createTdxQuoteVerifier: () => async () => ({ tcbStatus: "UpToDate", reportData }),
      createGpuEvidenceVerifier: () => async () => {},
    }));
    expect((await noFlag?.verifyQuote("00"))?.debugEnabled).toBe(true);
  });

  it("loads the installed @nearai/inference-sdk without touching the network", async () => {
    let installed = true;
    try {
      createRequire(import.meta.url).resolve("@nearai/inference-sdk");
    } catch {
      installed = false;
    }
    const verifier = await loadDefaultOnlineVerifier();
    if (installed) {
      expect(verifier).not.toBeNull();
      expect(typeof verifier?.verifyQuote).toBe("function");
      expect(typeof verifier?.verifyGpu).toBe("function");
    } else {
      expect(verifier).toBeNull();
    }
    // The package is large: its first import can take tens of seconds on a loaded machine.
  }, 120_000);
});

describe("drift guard: our O1 policy copy is the installed library's own", () => {
  it("matches DEFAULT_ACCEPTED_TCB_STATUSES and the debug check in @nearai/inference-sdk's dist, at the pinned version", () => {
    let entry: string;
    try {
      entry = createRequire(import.meta.url).resolve("@nearai/inference-sdk");
    } catch {
      // Not installed: nothing to drift from (verify then reports "online: unavailable").
      return;
    }
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as {
      version: string;
    };
    expect(
      pkg.version,
      "re-check ACCEPTED_TCB_STATUSES and o1PolicyProblem against the new verifyTdxQuote policy, then update this pin",
    ).toBe("0.2.1");
    const dist = readFileSync(entry, "utf8");
    const listed = /DEFAULT_ACCEPTED_TCB_STATUSES\s*=\s*\[([^\]]*)\]/.exec(dist)?.[1];
    expect(listed, "DEFAULT_ACCEPTED_TCB_STATUSES not found in the library").toBeDefined();
    const statuses = [...(listed ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(statuses).toEqual([...ACCEPTED_TCB_STATUSES]);
    expect(dist).toMatch(
      /if \(quote\.debugEnabled\) \{\s*throw new VerificationError\(\{\s*code: "policy\.debug_enabled"/,
    );
  });
});
