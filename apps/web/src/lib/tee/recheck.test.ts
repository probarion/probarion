import { describe, expect, it } from "vitest";
import { NONCE, OTHER_NONCE, SIGNER } from "../../../test/fixtures/tee";
import {
  allPass,
  checkFromBrowser,
  drawNonce,
  isTeeNonce,
  nonceProblem,
  readTeeAnswer,
  recheckInBrowser,
  signerProblem,
  type TeeAttestationValues,
  type TeeCheckResult,
} from "./recheck";

const bound = (nonce = NONCE, signer = SIGNER): TeeAttestationValues => ({
  signing_address: signer,
  request_nonce: nonce,
  report_data: `${signer.slice(2).toLowerCase()}${"0".repeat(24)}${nonce}`,
  tcb_status: "UpToDate",
  gpu: "pass",
});

/** An answer as the server sends it: its own four checks, all passed. */
function answer(over: Partial<TeeCheckResult> = {}): TeeCheckResult {
  return {
    nonce: NONCE,
    model: "Qwen/Qwen3.8-27B",
    checked_at: "2026-11-12T16:13:13.564Z",
    elapsed_ms: 4976,
    checks: (["nonce", "signer", "o1", "o2"] as const).map((id) => ({
      id,
      status: "pass" as const,
      detail: `server ${id}`,
    })),
    attestations: [bound()],
    ...over,
  };
}

const status = (rows: { id: string; status: string }[]) =>
  Object.fromEntries(rows.map((r) => [r.id, r.status]));

describe("the bindings the browser re-checks", () => {
  it("passes a report bound to the nonce and the signer, whatever the case of the signer's hex", () => {
    expect(nonceProblem(bound(), NONCE)).toBeNull();
    expect(signerProblem(bound())).toBeNull();
    expect(
      signerProblem({ ...bound(), signing_address: SIGNER.toUpperCase().replace("0X", "0x") }),
    ).toBeNull();
  });

  it("names what is wrong otherwise", () => {
    expect(nonceProblem(bound(OTHER_NONCE), NONCE)).toBe("report_data[32..64] is not this nonce");
    expect(nonceProblem({ ...bound(), request_nonce: OTHER_NONCE }, NONCE)).toBe(
      "request_nonce is not this nonce",
    );
    expect(nonceProblem({ ...bound(), report_data: "" }, NONCE)).toBe(
      "the TDX quote holds no 64-byte report data",
    );
    expect(signerProblem({ ...bound(), report_data: `${"0".repeat(64)}${NONCE}` })).toBe(
      "report_data[0..32] is not the zero-padded signing address",
    );
    expect(signerProblem({ ...bound(), signing_address: "0x1234" })).toBe(
      "the signing address is not a 20-byte EVM address",
    );
  });
});

describe("recheckInBrowser", () => {
  it("re-checks the bindings with the browser's own nonce, and takes O1 and O2 from the server", () => {
    const rows = recheckInBrowser(answer(), NONCE);
    expect(rows.map((r) => r.id)).toEqual(["nonce", "signer", "o1", "o2"]);
    expect(status(rows)).toEqual({ nonce: "pass", signer: "pass", o1: "pass", o2: "pass" });
    expect(rows[0]?.detail).toBe("report_data[32..64] and request_nonce equal this nonce");
    expect(rows[2]?.detail).toBe("server o1");
    expect(allPass(rows)).toBe(true);
  });

  it("fails a binding the server said passed, when the values do not hold it", () => {
    const rows = recheckInBrowser(answer({ attestations: [bound(OTHER_NONCE)] }), NONCE);
    expect(status(rows)).toMatchObject({ nonce: "fail", signer: "pass" });
    expect(allPass(rows)).toBe(false);
    const unsigned = recheckInBrowser(
      answer({ attestations: [{ ...bound(), report_data: `${"0".repeat(64)}${NONCE}` }] }),
      NONCE,
    );
    expect(status(unsigned)).toMatchObject({ nonce: "pass", signer: "fail" });
  });

  it("fails both bindings for an answer to another nonce, even one bound to that nonce", () => {
    const replay = answer({ nonce: OTHER_NONCE, attestations: [bound(OTHER_NONCE)] });
    const rows = recheckInBrowser(replay, NONCE);
    expect(status(rows)).toMatchObject({ nonce: "fail", signer: "fail" });
    expect(rows[0]?.detail).toContain("another nonce");
  });

  it("has nothing to re-check, so unavailable, when the server got no attestation", () => {
    const rows = recheckInBrowser(
      answer({
        model: null,
        attestations: [],
        checks: (["nonce", "signer", "o1", "o2"] as const).map((id) => ({
          id,
          status: "unavailable" as const,
          detail: "NEAR AI answered HTTP 500",
        })),
      }),
      NONCE,
    );
    expect(status(rows)).toEqual({
      nonce: "unavailable",
      signer: "unavailable",
      o1: "unavailable",
      o2: "unavailable",
    });
    expect(allPass(rows)).toBe(false);
  });

  it("checks every attestation and names the one that fails", () => {
    const other = "0x1111111111111111111111111111111111111111";
    const rows = recheckInBrowser(
      answer({ attestations: [bound(), bound(OTHER_NONCE, other)] }),
      NONCE,
    );
    expect(rows[0]).toEqual({
      id: "nonce",
      status: "fail",
      detail: `${other}: report_data[32..64] is not this nonce`,
    });
  });

  it("does not take a missing O1 or O2 row for a pass", () => {
    const rows = recheckInBrowser(answer({ checks: [] }), NONCE);
    expect(status(rows)).toMatchObject({ o1: "unavailable", o2: "unavailable" });
  });
});

describe("readTeeAnswer reads the route's answer as untrusted JSON", () => {
  it("keeps the named fields and drops the rest", () => {
    const read = readTeeAnswer({
      ...answer(),
      extra: "x",
      attestations: [{ ...bound(), intel_quote: "04" }],
    });
    expect(read?.attestations[0]).toEqual(bound());
    expect(read).not.toHaveProperty("extra");
  });

  it("refuses what is not an answer", () => {
    for (const bad of [
      null,
      "text",
      [],
      { checks: [] },
      { ...answer(), checks: [{ id: "o1", status: "maybe", detail: "" }] },
      { ...answer(), checks: [{ id: "o9", status: "pass", detail: "" }] },
      { ...answer(), attestations: [{ signing_address: 1 }] },
    ]) {
      expect(readTeeAnswer(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("checkFromBrowser", () => {
  const random = (bytes: Uint8Array) => {
    bytes.set(Uint8Array.from(NONCE.match(/../g) ?? [], (h) => Number.parseInt(h, 16)));
    return bytes;
  };
  let clock = 0;
  const now = () => (clock += 1500);

  it("draws a 32-byte nonce as 64 lowercase hex", () => {
    expect(drawNonce(random)).toBe(NONCE);
    expect(isTeeNonce(drawNonce((b) => b))).toBe(true);
    expect(isTeeNonce(NONCE.toUpperCase())).toBe(false);
  });

  it("sends the nonce and nothing else, then re-checks the answer with it", async () => {
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    const r = await checkFromBrowser({
      random,
      now,
      fetch: async (input, init) => {
        sent.push({ url: String(input), init });
        return Response.json(answer());
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`/api/tee/check?nonce=${NONCE}`);
    expect(sent[0]?.init?.method ?? "GET").toBe("GET");
    expect(sent[0]?.init?.body).toBeUndefined();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nonce).toBe(NONCE);
    expect(r.tookMs).toBe(1500);
    expect(allPass(r.rows)).toBe(true);
  });

  it("re-checks with its own nonce: an answer for another one fails", async () => {
    const r = await checkFromBrowser({
      random,
      now,
      fetch: async () =>
        Response.json(answer({ nonce: OTHER_NONCE, attestations: [bound(OTHER_NONCE)] })),
    });
    expect(r.ok && status(r.rows)).toMatchObject({ nonce: "fail", signer: "fail" });
  });

  it("says why when the check did not run: the limit, an error, no answer, or one it cannot read", async () => {
    const cases: [typeof fetch, string][] = [
      [
        async () =>
          Response.json(
            { error: "rate_limited" },
            { status: 429, headers: { "Retry-After": "12" } },
          ),
        "Too many checks from all visitors together. Try again in 12 s.",
      ],
      [
        async () => Response.json({ error: "unavailable" }, { status: 503 }),
        "The check did not run (HTTP 503).",
      ],
      [
        async () => {
          throw new TypeError("Failed to fetch");
        },
        "The check could not be reached.",
      ],
      [async () => new Response("<html>"), "The answer could not be read."],
    ];
    for (const [fetch, message] of cases) {
      const r = await checkFromBrowser({ random, now, fetch });
      expect(r).toEqual({ ok: false, nonce: NONCE, message });
    }
  });
});
