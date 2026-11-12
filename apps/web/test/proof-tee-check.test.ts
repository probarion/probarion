// The live TEE check on /proof: one card after the decisions, the same on every vault's page, and kept apart from the
// per-decision checks A1 to A7, which read the ledger and never this check. Rendered as a visitor gets it.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks, type Snapshot } from "@probarion/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProofView } from "@/components/proof/ProofView";
import { TeeCheckPanel, TeeResult } from "@/components/proof/TeeCheckPanel";
import type { Network } from "@/lib/config";
import { decisionRows } from "@/lib/proof/decisions";
import type { ProofOk } from "@/lib/proof/service";
import fixture from "@/lib/site/valid-snapshot.json";
import { recheckInBrowser, type TeeCheckResult } from "@/lib/tee/recheck";
import { importsOf, resolveLocal, toPosix } from "./deploy-scan";
import { NONCE, SIGNER } from "./fixtures/tee";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(WEB, "src");
const ROOT = join(WEB, "..", "..");
const demo = JSON.parse(
  readFileSync(join(ROOT, "docs", "evidence", "demo-vault", "snapshot-2026-11-09.json"), "utf8"),
) as Snapshot;
const attested = fixture as unknown as Snapshot;

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");
const count = (s: string, part: string) => s.split(part).length - 1;

async function page(snapshot: Snapshot, teeModel: string | null = "Qwen/Qwen3.8-27B") {
  const network = snapshot.network as Network;
  const result: ProofOk = {
    status: "ok",
    vault: snapshot.vault,
    network,
    kind: "team",
    audience: "public",
    snapshot,
    report: await runChecks(snapshot),
  };
  const decisions = await decisionRows(snapshot, network);
  return renderToStaticMarkup(createElement(ProofView, { result, decisions, teeModel }));
}

/** The card: from its section to the next section. */
function card(out: string): string {
  const start = out.lastIndexOf("<section", out.indexOf('id="tee-check"'));
  expect(start).toBeGreaterThan(-1);
  return out.slice(start, out.indexOf("</section>", start) + "</section>".length);
}

describe("/proof's live TEE check card", () => {
  it("is on the page once, as its own card after the decisions and before the burns and the offline steps", async () => {
    for (const snapshot of [attested, demo]) {
      const out = await page(snapshot);
      expect(count(out, 'id="tee-check"')).toBe(1);
      const at = out.indexOf('id="tee-check"');
      expect(at).toBeGreaterThan(out.indexOf('id="decisions"'));
      expect(at).toBeLessThan(out.indexOf('id="verify"'));
      const burns = out.indexOf('aria-labelledby="burns"');
      if (burns > -1) expect(at).toBeLessThan(burns);
      // Its own card: the decisions section closes before it starts.
      const decisions = out.slice(out.indexOf('id="decisions"'), out.lastIndexOf("<section", at));
      expect(count(decisions, "<section")).toBe(count(decisions, "</section>") - 1);
    }
  });

  it("is the same on every vault's page", async () => {
    expect(card(await page(attested))).toBe(card(await page(demo)));
  });

  it("says what it checks and what it does not, and what is sent", async () => {
    const t = text(card(await page(attested)));
    expect(t).toContain("Check the TEE now");
    expect(t).toContain("This checks the TEE that serves Qwen/Qwen3.8-27B right now");
    expect(t).toContain("with a random nonce your browser draws");
    expect(t).toContain("It does not re-check the decisions above.");
    expect(t).toContain("Only the nonce is sent: nothing you typed or uploaded.");
    expect(t).not.toMatch(/\bverified\b|\bpass(ed)?\b/);
    const unset = text(card(await page(attested, null)));
    expect(unset).toContain("This checks the TEE that serves the model Payables uses right now");
  });

  it("shows a run's rows, the measurement as a named non-check linked to its write-up, and the values", () => {
    const answer: TeeCheckResult = {
      nonce: NONCE,
      model: "Qwen/Qwen3.8-27B",
      checked_at: "2026-11-12T16:13:13.564Z",
      elapsed_ms: 4976,
      checks: [
        { id: "nonce", status: "pass", detail: "server nonce" },
        { id: "signer", status: "pass", detail: "server signer" },
        { id: "o1", status: "pass", detail: "Intel DCAP verified the TDX quote" },
        { id: "o2", status: "unavailable", detail: "[gpu.nras_request_failed] NVIDIA NRAS" },
      ],
      attestations: [
        {
          signing_address: SIGNER,
          request_nonce: NONCE,
          report_data: `${SIGNER.slice(2)}${"0".repeat(24)}${NONCE}`,
          tcb_status: "UpToDate",
          gpu: "unavailable",
        },
      ],
    };
    const check = {
      ok: true as const,
      nonce: NONCE,
      answer,
      rows: recheckInBrowser(answer, NONCE),
      tookMs: 5028,
    };
    const out = renderToStaticMarkup(createElement(TeeResult, { check }));
    const t = text(out);
    expect(t).toContain("Not every check could run, so this is not a pass.");
    for (const id of ["nonce", "signer", "o1", "o2", "measurement"]) {
      expect(out).toContain(`data-tee-check="${id}"`);
    }
    expect(out).toMatch(/data-tee-check="o2" data-status="unavailable"/);
    expect(t).toContain("Nonce bound (re-checked in this browser) pass");
    expect(t).toContain("report_data[32..64] and request_nonce equal this nonce");
    expect(t).toContain("O2: NVIDIA GPU evidence (NVIDIA NRAS, run by the server) not run");
    expect(t).toContain("TEE measurement not pinned");
    expect(out).toContain(
      'href="https://github.com/probarion/probarion/blob/main/docs/measurement-pin-2026-11.md"',
    );
    for (const value of [
      NONCE,
      SIGNER,
      "Qwen/Qwen3.8-27B",
      "UpToDate",
      "not verified here",
      "2026-11-12 16:13:13 UTC",
      "5.0 s",
    ]) {
      expect(t, value).toContain(value);
    }
    const passed = renderToStaticMarkup(
      createElement(TeeResult, {
        check: {
          ...check,
          rows: check.rows.map((r) => ({ ...r, status: "pass" as const })),
        },
      }),
    );
    expect(text(passed)).toContain("All four checks passed for this nonce.");
  });

  it("starts with no result and a button that sends the check", () => {
    const out = renderToStaticMarkup(createElement(TeeCheckPanel, { model: "m" }));
    expect(out).toMatch(/<button type="button"[^>]*>Check the TEE now<\/button>/);
    expect(out).not.toContain("data-tee-check");
    expect(out).toContain('aria-live="polite"');
  });
});

describe("the per-decision checks never read the live TEE check", () => {
  /** Every app module `roots` load, type-only imports included. */
  function graph(roots: string[]): Set<string> {
    const seen = new Set<string>();
    const todo = [...roots];
    while (todo.length > 0) {
      const f = todo.pop();
      if (f === undefined || seen.has(f)) continue;
      seen.add(f);
      for (const imp of importsOf(readFileSync(f, "utf8"))) {
        const next = resolveLocal(imp.spec, f, SRC);
        if (next !== null) todo.push(next);
      }
    }
    return seen;
  }
  const rel = (f: string) => toPosix(relative(SRC, f));

  it("imports nothing of lib/tee or the TEE panel from the decision cards or the rows they show", () => {
    const roots = [
      "components/proof/DecisionPanel.tsx",
      "components/proof/DecisionLinks.tsx",
      "lib/proof/decisions.ts",
      "lib/proof/decision-cache.ts",
    ].map((p) => join(SRC, p));
    const loaded = [...graph(roots)].map(rel);
    expect(loaded).toContain("components/proof/DecisionPanel.tsx");
    expect(loaded.length).toBeGreaterThan(roots.length);
    expect(loaded.filter((f) => f.startsWith("lib/tee/") || f.includes("TeeCheck"))).toEqual([]);
    for (const r of roots) {
      expect(readFileSync(r, "utf8"), rel(r)).not.toMatch(/tee\/check|TeeCheck|api\/tee/);
    }
  });

  it("keeps the panel's client code away from the server check", () => {
    const loaded = [...graph([join(SRC, "components/proof/TeeCheckPanel.tsx")])].map(rel);
    expect(loaded).toContain("lib/tee/recheck.ts");
    expect(loaded).not.toContain("lib/tee/check.ts");
  });
});
