// The Decisions section of /proof (G7) and its audit links (G4), rendered as a visitor gets it: on the committed
// fixture with two attested decisions, on the testnet demo vault's rules-only snapshot, and on tampered copies. The
// page must show what each decision's A1 to A7 found, and never claim more (that the TEE or its quote was verified),
// nor inline the raw quote.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks, type Snapshot } from "@probarion/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyAuditLink, OpenLinkedDecision } from "@/components/proof/DecisionLinks";
import { ATTESTATION_MEANINGS, DecisionPanel } from "@/components/proof/DecisionPanel";
import { DECISIONS_SHOWN, Decisions, ProofView } from "@/components/proof/ProofView";
import type { Network } from "@/lib/config";
import {
  DECISION_LIMITS,
  type DecisionRow,
  decisionRows,
  INPUTS_BINDING_NOTE,
  NO_MODEL,
  onlineCommand,
} from "@/lib/proof/decisions";
import type { ProofOk } from "@/lib/proof/service";
import fixture from "@/lib/site/valid-snapshot.json";
import { elementsOf } from "./fixtures/elements";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const demo = JSON.parse(
  readFileSync(join(ROOT, "docs", "evidence", "demo-vault", "snapshot-2026-11-09.json"), "utf8"),
) as Snapshot;
const attested = fixture as unknown as Snapshot;

/** Markup as text: tags dropped, the entities React writes decoded, spaces collapsed. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

const count = (s: string, part: string) => s.split(part).length - 1;

async function page(snapshot: Snapshot, decisions?: DecisionRow[]) {
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
  const rows = decisions ?? (await decisionRows(snapshot, network));
  return renderToStaticMarkup(createElement(ProofView, { result, decisions: rows }));
}

/** The Decisions section of a rendered page: from its card to the section after it. */
function section(out: string): string {
  const start = out.indexOf('id="decisions"');
  expect(start).toBeGreaterThan(-1);
  const ends = ['aria-labelledby="burns"', 'id="verify"']
    .map((m) => out.indexOf(m, start))
    .filter((i) => i > start);
  return out.slice(start, Math.min(...ends));
}

/** One card of the section: from its id to the next card. */
function card(out: string, seq: number): string {
  const start = out.indexOf(`id="seq-${seq}"`);
  expect(start, `seq-${seq}`).toBeGreaterThan(-1);
  const next = out.indexOf("data-decision=", out.indexOf("data-decision=", start) + 1);
  return out.slice(start, next < 0 ? undefined : next);
}

const COLUMNS = [
  "What the TEE saw",
  "What the TEE signed",
  "What the code and the contract checked",
] as const;

describe("/proof Decisions on the committed fixture (two attested decisions, one rules-only)", () => {
  it("adds the section after the checks and before the steps to verify", async () => {
    const out = await page(attested);
    const t = text(out);
    expect(out).toMatch(/<h2 id="decisions-title"[^>]*>Decisions<\/h2>/);
    expect(t.indexOf("Decisions Every decision")).toBeGreaterThan(t.indexOf("Checks These are"));
    expect(t.indexOf("Decisions Every decision")).toBeLessThan(
      t.indexOf("Verify it yourself, offline"),
    );
    expect(t).toContain("3 decisions · 2 made with model output");
    // The approved width: the page's column, and 1040 px from 1100 px up.
    expect(out).toMatch(/class="[^"]*min-\[1100px\]:w-\[1040px\][^"]*" id="decisions"/);
  });

  it("lists every decision newest first, each with its anchor and its spends' anchors", async () => {
    const out = section(await page(attested));
    const order = [...out.matchAll(/data-decision="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([4, 2, 0]);
    for (const id of ["seq-4", "seq-2", "seq-0", "spend-2", "spend-1"]) {
      expect(out, id).toContain(`id="${id}"`);
    }
    expect(card(out, 2)).toContain('id="spend-2"');
    expect(card(out, 0)).toContain('id="spend-1"');
    expect(card(out, 4)).not.toContain('id="spend-');
    // Each card links its own anchors, and its copy control is a plain link to the spend's (or else the seq's).
    expect(card(out, 2)).toContain('href="#seq-2"');
    expect(card(out, 2)).toMatch(/<a[^>]*href="#spend-2"[^>]*>Copy audit link<\/a>/);
    expect(card(out, 4)).toMatch(/<a[^>]*href="#seq-4"[^>]*>Copy audit link<\/a>/);
    expect(text(card(out, 2))).toContain("In snapshot.json: ledger[2]");
  });

  it("never gives two elements of the page the same id", async () => {
    const ids = [...(await page(attested)).matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(20);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("opens only the newest decision made with model output", async () => {
    const out = section(await page(attested));
    const opened = (seq: number) => /<details class="group\/card" open="">/.test(card(out, seq));
    expect([opened(4), opened(2), opened(0)]).toEqual([false, true, false]);
  });

  it("shows the three columns for each attested decision, stacked on a phone", async () => {
    const out = section(await page(attested));
    for (const seq of [2, 0]) {
      const c = card(out, seq);
      for (const heading of COLUMNS) expect(text(c), `${seq} ${heading}`).toContain(heading);
      expect(c).toContain('class="mt-4 grid gap-3 md:grid-cols-3"');
    }
    const t = text(card(out, 0));
    // The model id is the ledger entry's own (evidence.model), not a placeholder.
    expect(t).toContain("Model test-fixture/not-a-real-model");
    expect(t).not.toMatch(/placeholder/i);
    expect(t).toContain("System prompt PROPOSAL_SYSTEM_PROMPT");
    expect(t).toContain(INPUTS_BINDING_NOTE);
    expect(t).toContain(
      "invoice_hash 998f15d4aa451bbbfa0dc2dadb570720fd24f8468cb3c9f99745681966e90890",
    );
    expect(t).toContain('#1 "TEST FIXTURE mandate 1 (NEAR vendor)": pays vendor.fixture.testnet');
    expect(t).toContain("Proposal pay 25 USDC, mandate 1, confidence 0.93");
    expect(t).toContain(
      "Reasoning (as the model wrote it) TEST FIXTURE: not a real NEAR AI Cloud attestation.",
    );
    expect(t).toContain("chat_id chatcmpl-test-fixture-0");
    expect(t).toContain("Signer 0x39cf9b81BEdE0a4e0685772cA85Bf0AacF11F7E8");
    expect(t).toContain("Code rules: 16 of 16 pass");
    expect(t).toContain("Spend #1's decision_hash is this entry's body_hash: paid, 25 USDC");
    expect(t).toContain("All 14 passed: the contract accepted the spend.");
  });

  it("marks A1 to A7 per attested decision, with one line each saying what it shows", async () => {
    const out = section(await page(attested));
    for (const seq of [2, 0]) {
      const c = card(out, seq);
      const marks = [...c.matchAll(/data-attestation="(A\d)" data-result="(pass|fail)"/g)].map(
        (m) => `${m[1]}:${m[2]}`,
      );
      expect(marks, String(seq)).toEqual(
        ["A1", "A2", "A3", "A4", "A5", "A6", "A7"].map((a) => `${a}:pass`),
      );
      expect(count(c, 'role="img" aria-label="pass"')).toBe(7);
      for (const meaning of Object.values(ATTESTATION_MEANINGS)) expect(text(c)).toContain(meaning);
      expect(text(c)).toContain("Consistent offline: A1 to A7 pass");
      expect(text(c)).toContain("A1-A7 pass offline");
      expect(text(c)).toContain("quote not checked here");
    }
  });

  it("states the fixed limits and the online command for each attested decision", async () => {
    const out = section(await page(attested));
    const t = text(out);
    expect(count(t, DECISION_LIMITS)).toBe(2);
    expect(count(t, onlineCommand("testnet", attested.vault))).toBe(2);
    expect(onlineCommand("testnet", attested.vault)).toMatch(/verify .*--online$/);
  });

  it("shows a rules-only decision with no TEE column: no model was used", async () => {
    const c = card(section(await page(attested)), 4);
    const t = text(c);
    expect(t).toContain(NO_MODEL);
    expect(t).toContain("No model was used");
    expect(t).toContain("What the code checked");
    expect(t).toContain("What the contract checked");
    for (const heading of COLUMNS) expect(t).not.toContain(heading);
    expect(c).not.toContain("data-attestation=");
    expect(t).toContain("not sent The code refused this decision, so nothing reached the contract");
    expect(t).toContain("mandate.payee_mismatch");
  });

  it("never claims the TEE was verified, and never inlines the raw quote or response", async () => {
    const out = await page(attested);
    const t = text(out);
    expect(t).not.toMatch(/TEE verified|verified TEE|quote verified|quote is verified/i);
    const first = fixture.ledger[0];
    if (!first) throw new Error("fixture changed");
    const ev = (
      first.body as unknown as {
        evidence: { report: { intel_quote: string }; response_body: string };
      }
    ).evidence;
    // The quote's header, and no long run of hex anywhere: a hash or a report_data half is 64 characters at most.
    expect(out).not.toContain(ev.report.intel_quote.slice(0, 64));
    expect(out).not.toMatch(/[0-9a-fA-F]{129}/);
    expect(t).not.toContain(ev.response_body);
    expect(t).not.toContain('"choices"');
    // Sizes only, and where the bytes are.
    expect(t).toContain("TDX quote v4, 632 bytes, not shown here (in snapshot.json");
    expect(t).toContain("Response body, 520 bytes, in snapshot.json");
    expect(section(out)).toContain(`href="/proof/${attested.vault}/snapshot.json"`);
  });

  it("links each contract tx on the explorer of the vault's network", async () => {
    const out = section(await page(attested));
    expect(out).toContain(
      'href="https://testnet.nearblocks.io/txns/4UViDBu8eHvNMe7WB24hDfDA5un4R5Wmy7ENLWGeRecF"',
    );
    expect(out).toContain(
      'href="https://testnet.nearblocks.io/txns/Afyz99fesbMSdpHXc5Fc6bqhsaPJ8Wrc7gc8JgBicCsT"',
    );
    expect(out).not.toContain("https://nearblocks.io/");
    expect(text(out)).toContain("Contract tx, seq 3 on testnet.nearblocks.io (opens in a new tab)");
    // On mainnet the same entry links nearblocks.io.
    const rows = await decisionRows(attested, "mainnet");
    const row = rows.find((r) => r.seq === 2) as DecisionRow;
    const main = renderToStaticMarkup(
      createElement(DecisionPanel, { row, vault: attested.vault, network: "mainnet" }),
    );
    expect(main).toContain(
      'href="https://nearblocks.io/txns/4UViDBu8eHvNMe7WB24hDfDA5un4R5Wmy7ENLWGeRecF"',
    );
    expect(main).not.toContain("testnet.nearblocks.io");
    expect(text(main)).toContain(onlineCommand("mainnet", attested.vault));
  });

  it("tells a screen reader which links open a new tab", async () => {
    const out = await page(attested);
    const newTab = count(out, 'target="_blank"');
    expect(count(section(out), 'target="_blank"')).toBeGreaterThan(0);
    expect(count(out, '<span class="sr-only"> (opens in a new tab)</span>')).toBe(newTab);
  });

  it("links check (e) to the decisions, on the same page", async () => {
    const out = await page(attested);
    const link = out.match(/<a[^>]*href="#decisions"[^>]*>Each decision, below<\/a>/)?.[0];
    expect(link).toBeDefined();
    expect(link).not.toContain("target=");
    const checkE = out.slice(out.indexOf('id="check-e"'), out.indexOf('id="check-f"'));
    expect(checkE).toContain('href="#decisions"');
  });

  it("escapes what the model wrote, and fails A7 when the recorded proposal is edited", async () => {
    const s = structuredClone(fixture) as unknown as {
      ledger: { body: { proposal: { reasoning: string } | null } }[];
    };
    const p = s.ledger[0]?.body.proposal;
    if (!p) throw new Error("fixture changed");
    p.reasoning = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const out = section(await page(s as unknown as Snapshot));
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
    const c = card(out, 0);
    expect(c).toContain('data-attestation="A7" data-result="fail"');
    expect(count(c, 'role="img" aria-label="fail"')).toBe(1);
    expect(text(c)).toContain("Not consistent offline: A7 fails");
    expect(text(c)).toContain("A1-A7: A7 fails");
  });
});

describe("/proof Decisions on the testnet demo vault (rules-only)", () => {
  it("lists its five decisions with no TEE column and none open", async () => {
    const out = section(await page(demo));
    const t = text(out);
    expect([...out.matchAll(/data-decision="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([
      5, 4, 3, 1, 0,
    ]);
    expect(t).toContain("5 decisions · 0 made with model output");
    expect(count(t, NO_MODEL)).toBe(5);
    for (const heading of COLUMNS) expect(t).not.toContain(heading);
    expect(out).not.toContain("data-attestation=");
    expect(out).not.toContain('open=""');
    expect(t).not.toContain(DECISION_LIMITS);
    expect(t).not.toMatch(/TEE verified|quote verified/i);
  });

  it("puts each spend's anchor on the decision the chain binds it to, and links its tx on testnet", async () => {
    const out = section(await page(demo));
    expect(card(out, 1)).toContain('id="spend-1"');
    expect(card(out, 5)).toContain('id="spend-2"');
    expect(card(out, 1)).toContain(
      'href="https://testnet.nearblocks.io/txns/HFyW61UZXfwpqhgqWq9bXnRXaYiEnpk4WPUHDAEydQp1"',
    );
    expect(out).not.toContain("https://nearblocks.io/");
    // The first decision was held by the code: nothing reached the contract.
    expect(text(card(out, 0))).toContain("not sent The code held this decision");
  });
});

describe("paging and the client parts", () => {
  it(`shows the ${DECISIONS_SHOWN} newest decisions and keeps the older ones, anchors included, behind one control`, async () => {
    const rows = await decisionRows(demo, "testnet");
    const base = rows[1] as DecisionRow;
    const many = Array.from({ length: DECISIONS_SHOWN + 3 }, (_, i) => {
      const seq = DECISIONS_SHOWN + 2 - i;
      return { ...base, seq, id: `seq-${seq}`, spendIds: [] };
    });
    const out = section(await page(demo, many));
    const t = text(out);
    expect(t).toContain(
      `${DECISIONS_SHOWN + 3} decisions · 0 made with model output · showing the ${DECISIONS_SHOWN} newest`,
    );
    const older = out.indexOf('data-older="3"');
    expect(older).toBeGreaterThan(out.indexOf(`id="seq-3"`));
    expect(t).toContain("Show 3 older decisions");
    expect(t).toContain("seq 2 to seq 0");
    for (const seq of [2, 1, 0]) expect(out.indexOf(`id="seq-${seq}"`)).toBeGreaterThan(older);
  });

  it("says when the decisions could not be listed, and when there are none", async () => {
    const result = {
      status: "ok",
      vault: demo.vault,
      network: "testnet",
      kind: "team",
      audience: "public",
      snapshot: demo,
      report: await runChecks(demo),
    } as ProofOk;
    expect(
      text(renderToStaticMarkup(createElement(ProofView, { result, decisions: null }))),
    ).toContain(
      "The decisions could not be listed from this snapshot. The checks above still ran on it.",
    );
    expect(
      text(renderToStaticMarkup(createElement(ProofView, { result, decisions: [] }))),
    ).toContain("No decision is in this vault's ledger yet.");
  });

  it("puts the hash opener in the section, and the copy control is a plain link without JavaScript", async () => {
    const rows = await decisionRows(attested, "testnet");
    const tree = Decisions({ vault: attested.vault, network: "testnet", rows });
    expect(elementsOf(tree, OpenLinkedDecision)).toHaveLength(1);
    expect(renderToStaticMarkup(createElement(OpenLinkedDecision))).toBe("");
    const copy = renderToStaticMarkup(createElement(CopyAuditLink, { anchor: "spend-4" }));
    expect(copy).toMatch(
      /^<a href="#spend-4">Copy audit link<\/a><span class="sr-only" aria-live="polite"><\/span>$/,
    );
  });

  it("keeps the client file small: it imports neither core nor the decision rows", () => {
    const src = readFileSync(join(ROOT, "apps/web/src/components/proof/DecisionLinks.tsx"), "utf8");
    expect(src.startsWith('"use client";')).toBe(true);
    expect(src).not.toMatch(/@probarion\/core|lib\/proof\/decisions|lib\/proof\/view/);
    const helper = readFileSync(join(ROOT, "apps/web/src/lib/proof/decision-hash.ts"), "utf8");
    expect(helper).not.toMatch(/^import /m);
  });
});
