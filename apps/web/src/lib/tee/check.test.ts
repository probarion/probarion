import { loadDefaultOnlineVerifier, PREFERRED_PRIVATE_MODELS } from "@probarion/sdk";
import { describe, expect, it } from "vitest";
import {
  dcapResult,
  FAKE_NEARAI,
  fakeAttestation,
  fakeReportServer,
  fakeVerifier,
  NONCE,
  OTHER_NONCE,
  SIGNER,
  TEE_MODEL,
  verificationError,
} from "../../../test/fixtures/tee";
import { checkTee, type TeeCheckDeps, teeCheckModels } from "./check";
import { MAX_ATTESTATIONS, MAX_REPORT_BYTES } from "./limits";
import type { TeeCheckResult, TeeStatus } from "./recheck";

const statuses = (r: TeeCheckResult) =>
  Object.fromEntries(r.checks.map((c) => [c.id, c.status])) as Record<string, TeeStatus>;
const detail = (r: TeeCheckResult, id: string) => r.checks.find((c) => c.id === id)?.detail ?? "";

function setup(over: Partial<TeeCheckDeps> = {}) {
  const server = fakeReportServer();
  const verifier = fakeVerifier();
  const deps: TeeCheckDeps = {
    fetch: server.fetch,
    loadVerifier: async () => verifier,
    baseUrl: FAKE_NEARAI,
    ...over,
  };
  return { server, verifier, deps, run: (models = [TEE_MODEL]) => checkTee(NONCE, models, deps) };
}

describe("checkTee: the pass path", () => {
  it("passes all four checks for a report bound to the nonce and its signer, verified by O1 and O2", async () => {
    const { run, verifier } = setup();
    const r = await run();
    expect(statuses(r)).toEqual({ nonce: "pass", signer: "pass", o1: "pass", o2: "pass" });
    expect(r.model).toBe(TEE_MODEL);
    expect(r.nonce).toBe(NONCE);
    expect(Number.isNaN(Date.parse(r.checked_at))).toBe(false);
    expect(r.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(r.attestations).toEqual([
      {
        signing_address: SIGNER,
        request_nonce: NONCE,
        report_data: `${SIGNER.slice(2)}${"0".repeat(24)}${NONCE}`,
        tcb_status: "UpToDate",
        gpu: "pass",
      },
    ]);
    expect(detail(r, "o1")).toContain("TCB status UpToDate");
    expect(verifier.quotes).toHaveLength(1);
    expect(verifier.gpus).toHaveLength(1);
  });

  it("asks the public report endpoint for the nonce and the model, with no API key", async () => {
    const { run, server } = setup();
    await run();
    expect(server.calls).toHaveLength(1);
    const [call] = server.calls;
    expect(call?.url.origin + call?.url.pathname).toBe(`${FAKE_NEARAI}/attestation/report`);
    expect(call?.url.searchParams.get("nonce")).toBe(NONCE);
    expect(call?.url.searchParams.get("model")).toBe(TEE_MODEL);
    expect(call?.url.searchParams.get("signing_algo")).toBe("ecdsa");
    expect(call?.headers.authorization).toBeUndefined();
    expect(Object.keys(call?.headers ?? {}).filter((h) => /auth|key|token/i.test(h))).toEqual([]);
  });

  it("passes on the named values and nothing else of the report: no quote, no GPU payload, no event log", async () => {
    const r = await setup().run();
    expect(Object.keys(r).sort()).toEqual(
      ["attestations", "checked_at", "checks", "elapsed_ms", "model", "nonce"].sort(),
    );
    const text = JSON.stringify(r);
    for (const absent of [
      "intel_quote",
      "nvidia_payload",
      "evidence_list",
      "event_log",
      "TEST DOUBLE",
      "compose_hash",
      "gateway",
    ]) {
      expect(text, absent).not.toContain(absent);
    }
    expect(text.length).toBeLessThan(2000);
  });
});

describe("checkTee: the bindings fail when the report is not for this nonce or this signer", () => {
  it("fails the nonce binding (and O2) for a report and a GPU payload made for another nonce", async () => {
    const { run, server } = setup();
    server.reply = () => [
      fakeAttestation(NONCE, {
        reportNonce: OTHER_NONCE,
        requestNonce: OTHER_NONCE,
        gpuNonce: OTHER_NONCE,
      }),
    ];
    const r = await run();
    expect(statuses(r)).toMatchObject({ nonce: "fail", signer: "pass", o2: "fail" });
    expect(detail(r, "nonce")).toBe("report_data[32..64] is not this nonce");
    expect(detail(r, "o2")).toBe("the GPU payload's nonce is not this nonce");
  });

  it("fails the nonce binding when only request_nonce or only report_data names another nonce", async () => {
    const { run, server } = setup();
    server.reply = () => [fakeAttestation(NONCE, { requestNonce: OTHER_NONCE })];
    expect(detail(await run(), "nonce")).toBe("request_nonce is not this nonce");
    server.reply = () => [fakeAttestation(NONCE, { reportNonce: OTHER_NONCE })];
    expect(statuses(await run()).nonce).toBe("fail");
  });

  it("fails the signer binding when report_data[0..32] does not hold the signing address", async () => {
    const { run, server } = setup();
    server.reply = () => [fakeAttestation(NONCE, { reportSigner: "0".repeat(64) })];
    const r = await run();
    expect(statuses(r)).toMatchObject({ nonce: "pass", signer: "fail" });
    expect(detail(r, "signer")).toBe("report_data[0..32] is not the zero-padded signing address");
    // Another signer's address in report_data fails too.
    server.reply = () => [
      fakeAttestation(NONCE, { reportSigner: `${"ab".repeat(20)}${"0".repeat(24)}` }),
    ];
    expect(statuses(await run()).signer).toBe("fail");
  });

  it("fails both bindings and O1 for a quote that holds no TDX report data", async () => {
    const { run, server } = setup();
    server.reply = () => [{ ...fakeAttestation(NONCE), intel_quote: "0400" }];
    const r = await run();
    expect(statuses(r)).toMatchObject({ nonce: "fail", signer: "fail", o1: "fail" });
    expect(r.attestations[0]?.report_data).toBe("");
  });
});

describe("checkTee: a verifier that cannot run gives unavailable, never a pass or a fail", () => {
  it("shows O1 and O2 as not run when the verifier does not load, and still checks the bindings", async () => {
    for (const loadVerifier of [
      async () => null,
      async () => {
        throw new Error("no module");
      },
      // The SDK's own loader, given a module that cannot be imported, as on a Node the package refuses.
      () => loadDefaultOnlineVerifier(() => Promise.reject(new Error("Cannot find package"))),
    ]) {
      const r = await setup({ loadVerifier }).run();
      expect(statuses(r)).toEqual({
        nonce: "pass",
        signer: "pass",
        o1: "unavailable",
        o2: "unavailable",
      });
      expect(detail(r, "o1")).toContain("probarion verify --online");
      expect(r.attestations[0]?.tcb_status).toBeNull();
      expect(r.attestations[0]?.gpu).toBe("unavailable");
    }
  });

  it("still fails O2 without a verifier when the GPU payload is for another nonce", async () => {
    const { run, server } = setup({ loadVerifier: async () => null });
    server.reply = () => [fakeAttestation(NONCE, { gpuNonce: OTHER_NONCE })];
    expect(statuses(await run()).o2).toBe("fail");
  });

  it("reads Intel's and NVIDIA's transport errors as unavailable, and their verdicts as fail", async () => {
    const cases: [string, "o1" | "o2", TeeStatus][] = [
      ["quote.collateral_unavailable", "o1", "unavailable"],
      ["quote.invalid_result", "o1", "unavailable"],
      ["quote.verification_failed", "o1", "fail"],
      ["quote.unsupported_report_type", "o1", "fail"],
      ["gpu.nras_request_failed", "o2", "unavailable"],
      ["gpu.jwks_request_failed", "o2", "unavailable"],
      ["gpu.jwt_verification_failed", "o2", "unavailable"],
      ["gpu.attestation_rejected", "o2", "fail"],
      ["gpu.payload_invalid", "o2", "fail"],
    ];
    for (const [code, id, want] of cases) {
      const v = fakeVerifier(
        id === "o1"
          ? { quote: async () => Promise.reject(verificationError(code)) }
          : { gpu: async () => Promise.reject(verificationError(code)) },
      );
      const r = await setup({ loadVerifier: async () => v }).run();
      expect(statuses(r)[id], code).toBe(want);
      expect(detail(r, id), code).toContain(code);
      expect(statuses(r)[id === "o1" ? "o2" : "o1"], code).toBe("pass");
    }
    // A plain error with no code (a crash in the verifier) cannot be read as a verdict.
    const crash = fakeVerifier({ quote: async () => Promise.reject(new TypeError("boom")) });
    expect(statuses(await setup({ loadVerifier: async () => crash }).run()).o1).toBe("unavailable");
  });

  it("fails O1 when the verified quote breaks the SDK's policy: debug on, or a TCB status it refuses", async () => {
    for (const over of [
      { debugEnabled: true },
      { tcbStatus: "Revoked" },
      { reportDataHex: "00".repeat(64) },
    ]) {
      const v = fakeVerifier({ quote: async (hex) => dcapResult(hex, over) });
      const r = await setup({ loadVerifier: async () => v }).run();
      expect(statuses(r).o1, JSON.stringify(over)).toBe("fail");
    }
    const outOfDate = fakeVerifier({
      quote: async (hex) => dcapResult(hex, { tcbStatus: "OutOfDate" }),
    });
    const r = await setup({ loadVerifier: async () => outOfDate }).run();
    expect(statuses(r).o1).toBe("pass");
    expect(r.attestations[0]?.tcb_status).toBe("OutOfDate");
  });

  it("gives up on a verifier that does not answer within the time left, as unavailable", async () => {
    const never = new Promise<never>(() => {});
    const v = fakeVerifier({ quote: () => never, gpu: () => never });
    const started = Date.now();
    const r = await setup({ loadVerifier: async () => v, budgetMs: 1500 }).run();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(statuses(r)).toEqual({
      nonce: "pass",
      signer: "pass",
      o1: "unavailable",
      o2: "unavailable",
    });
    expect(detail(r, "o1")).toMatch(/timed out/);
  });

  it("says unavailable for O2 when the report carries no GPU evidence", async () => {
    const { run, server } = setup();
    server.reply = () => [fakeAttestation(NONCE, { gpuNonce: null })];
    const r = await run();
    expect(statuses(r).o2).toBe("unavailable");
    expect(r.attestations[0]?.gpu).toBe("none");
  });
});

describe("checkTee: NEAR AI that fails or is slow gives unavailable on every check", () => {
  const allUnavailable = {
    nonce: "unavailable",
    signer: "unavailable",
    o1: "unavailable",
    o2: "unavailable",
  };

  it("for an HTTP 500", async () => {
    const { run, server, verifier } = setup();
    server.reply = () => 500;
    const r = await run();
    expect(statuses(r)).toEqual(allUnavailable);
    expect(detail(r, "nonce")).toContain("HTTP 500");
    expect(r.model).toBeNull();
    expect(r.attestations).toEqual([]);
    expect(verifier.quotes).toEqual([]);
  });

  it("for a report that does not answer within its timeout", async () => {
    const { run, server } = setup({ reportTimeoutMs: 50 });
    server.reply = () => "hang";
    const started = Date.now();
    const r = await run();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(statuses(r)).toEqual(allUnavailable);
    expect(detail(r, "nonce")).toMatch(/did not answer within/);
  });

  it("for a fetch that throws, an answer that is not JSON, or one larger than the cap", async () => {
    const thrown = setup({
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    expect(statuses(await thrown.run())).toEqual(allUnavailable);
    const { run, server } = setup();
    server.reply = () => ({ raw: "<html>gateway</html>" });
    expect(statuses(await run())).toEqual(allUnavailable);
    server.reply = () => ({ raw: " ".repeat(MAX_REPORT_BYTES + 1) });
    const big = await run();
    expect(statuses(big)).toEqual(allUnavailable);
    expect(detail(big, "nonce")).toContain("larger than");
  });

  it("for a report with no model attestation", async () => {
    const { run, server } = setup();
    server.reply = () => [];
    const r = await run();
    expect(statuses(r)).toEqual(allUnavailable);
    expect(detail(r, "nonce")).toContain("holds no model attestation");
  });
});

describe("checkTee: which model and how many attestations", () => {
  it("asks the next preferred model when one holds no attestation or fails, and names the one checked", async () => {
    const { run, server } = setup();
    const [first, second, third] = ["m/one", "m/two", "m/three"];
    server.reply = (url) => {
      const m = url.searchParams.get("model");
      if (m === first) return 404;
      if (m === second) return [];
      return [fakeAttestation(url.searchParams.get("nonce") ?? "")];
    };
    const r = await run([first ?? "", second ?? "", third ?? ""]);
    expect(r.model).toBe(third);
    expect(server.calls.map((c) => c.url.searchParams.get("model"))).toEqual([
      first,
      second,
      third,
    ]);
    expect(statuses(r).nonce).toBe("pass");
  });

  it("checks at most MAX_ATTESTATIONS attestations, each one, and names a failing one by its signer", async () => {
    const { run, server, verifier } = setup();
    const signers = Array.from(
      { length: MAX_ATTESTATIONS + 2 },
      (_, i) => `0x${String(i + 1).repeat(40)}`,
    );
    server.reply = () =>
      signers.map((s, i) =>
        fakeAttestation(NONCE, i === 1 ? { signer: s, reportNonce: OTHER_NONCE } : { signer: s }),
      );
    const r = await run();
    expect(r.attestations).toHaveLength(MAX_ATTESTATIONS);
    expect(verifier.quotes).toHaveLength(MAX_ATTESTATIONS);
    expect(statuses(r)).toMatchObject({ nonce: "fail", signer: "pass", o1: "pass" });
    expect(detail(r, "nonce")).toBe(`${signers[1]}: report_data[32..64] is not this nonce`);
    expect(detail(r, "signer")).toContain(`for all ${MAX_ATTESTATIONS} attestations`);
  });

  it("asks NEARAI_MODEL alone when it is set, else the SDK's preferred private models in order", () => {
    expect(teeCheckModels("Qwen/Qwen3.8-27B")).toEqual(["Qwen/Qwen3.8-27B"]);
    expect(teeCheckModels(" z-ai/glm-5.3-flash ")).toEqual(["z-ai/glm-5.3-flash"]);
    for (const unset of [null, undefined, "", "  "]) {
      expect(teeCheckModels(unset)).toEqual(PREFERRED_PRIVATE_MODELS);
    }
  });
});
