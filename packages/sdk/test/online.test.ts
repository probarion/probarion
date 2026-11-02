import { readFile } from "node:fs/promises";
import { extractReportDataFromQuote, runChecks, type Snapshot } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { applyOnlineChecks, loadDefaultOnlineVerifier } from "../src/online.js";

const NOW = new Date("2026-11-05T12:30:00.000Z");

async function fixture(): Promise<Snapshot> {
  return JSON.parse(
    await readFile(
      new URL("../../core/test/fixtures/valid-snapshot.json", import.meta.url),
      "utf8",
    ),
  ) as Snapshot;
}

const honest = {
  verifyQuote: async (quote: string) => ({
    reportDataHex: extractReportDataFromQuote(quote) ?? "",
  }),
  verifyGpu: async () => {},
};

const checkE = (report: Awaited<ReturnType<typeof runChecks>>) =>
  report.checks.find((c) => c.id === "e");

describe("applyOnlineChecks", () => {
  it("adds O1/O2 results to check e when every quote verifies", async () => {
    const snapshot = await fixture();
    const report = await applyOnlineChecks(
      await runChecks(snapshot, { now: NOW }),
      snapshot,
      honest,
    );
    expect(report.ok).toBe(true);
    expect(checkE(report)?.detail).toContain("online: 2 TDX quotes (O1)");
  });

  it("fails e at the first entry whose quote does not verify, and says so first", async () => {
    const snapshot = await fixture();
    const failing = {
      ...honest,
      verifyQuote: async () => Promise.reject(new Error("quote.verification_failed")),
    };
    const report = await applyOnlineChecks(
      await runChecks(snapshot, { now: NOW }),
      snapshot,
      failing,
    );
    expect(report.ok).toBe(false);
    expect(checkE(report)).toMatchObject({ status: "fail", firstBrokenSeq: 0 });
    expect(checkE(report)?.detail).toMatch(
      /^online: O1\/O2 failed at entry 0: quote.verification_failed; offline: /,
    );
  });

  it("fails e when the verified report data differs from the evidence", async () => {
    const snapshot = await fixture();
    const lying = { ...honest, verifyQuote: async () => ({ reportDataHex: "00".repeat(64) }) };
    const report = await applyOnlineChecks(
      await runChecks(snapshot, { now: NOW }),
      snapshot,
      lying,
    );
    expect(checkE(report)).toMatchObject({ status: "fail", firstBrokenSeq: 0 });
    expect(checkE(report)?.detail).toContain("O1");
  });

  it("verifies a GPU payload when there is one, and fails e when O2 refuses it", async () => {
    const snapshot = await fixture();
    const att = snapshot.ledger[2]?.body.evidence?.report;
    if (att === null || att === undefined) throw new Error("fixture report missing");
    att.nvidia_payload = "TEST GPU payload";
    const seen: string[] = [];
    const counting = {
      ...honest,
      verifyGpu: async (p: string) => {
        seen.push(p);
      },
    };
    const ok = await applyOnlineChecks(await runChecks(snapshot, { now: NOW }), snapshot, counting);
    expect(checkE(ok)?.detail).toContain("and 1 GPU payloads (O2) verified");
    expect(seen).toEqual(["TEST GPU payload"]);
    const refusing = {
      ...honest,
      verifyGpu: async () => Promise.reject(new Error("gpu.nras_request_failed")),
    };
    const bad = await applyOnlineChecks(
      await runChecks(snapshot, { now: NOW }),
      snapshot,
      refusing,
    );
    expect(checkE(bad)).toMatchObject({ status: "fail", firstBrokenSeq: 2 });
  });

  it("reports unavailability without changing the offline result", async () => {
    const snapshot = await fixture();
    const offline = await runChecks(snapshot, { now: NOW });
    const report = await applyOnlineChecks(offline, snapshot, null);
    expect(report.ok).toBe(offline.ok);
    expect(checkE(report)?.status).toBe(checkE(offline)?.status);
    expect(checkE(report)?.detail).toContain("online: unavailable");
  });

  it("loads the default verifier from @nearai/inference-sdk without touching the network, or gives null", async () => {
    const verifier = await loadDefaultOnlineVerifier();
    if (verifier !== null) {
      expect(typeof verifier.verifyQuote).toBe("function");
      expect(typeof verifier.verifyGpu).toBe("function");
    }
    // The package is large: its first import can take tens of seconds on a loaded machine.
  }, 120_000);
});
