// The T6 fixtures carry request evidence under a ledger context (Task 14 B7): A8 and the mandate match pass on
// the committed snapshot with the committed invoice texts, which git keeps byte for byte.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hash.js";
import { PROPOSAL_MAX_TOKENS, PROPOSAL_REQUEST_TEMPLATE } from "../src/proposal-request.js";
import type { Snapshot } from "../src/types.js";
import { runChecks } from "../src/verify.js";
import {
  FIXTURE_INVOICE_TEXTS,
  INVOICE_FILES,
  makeFixtureSnapshot,
  SNAPSHOT_FILE,
} from "./fixtures/make-fixtures.js";

const NOW = new Date("2026-11-05T12:30:00.000Z");
const fixtureUrl = (name: string): URL => new URL(`./fixtures/${name}`, import.meta.url);

async function committed(): Promise<{ snapshot: Snapshot; texts: Map<string, string> }> {
  const snapshot = JSON.parse(await readFile(fixtureUrl(SNAPSHOT_FILE), "utf8")) as Snapshot;
  const texts = new Map<string, string>();
  for (const file of Object.values(INVOICE_FILES)) {
    const text = await readFile(fixtureUrl(file), "utf8");
    texts.set(sha256Hex(text), text);
  }
  return { snapshot, texts };
}

describe("TEST FIXTURE request evidence (template v1, under a ledger context)", () => {
  it("records request_inputs of template v1 on every attested decision, and the chain mandates", async () => {
    const s = await makeFixtureSnapshot();
    const attested = s.ledger.filter((e) => e.body.evidence !== null);
    expect(attested.map((e) => e.body.seq)).toEqual([0, 2]);
    for (const e of attested) {
      expect(e.body.evidence?.request_inputs?.template).toBe(PROPOSAL_REQUEST_TEMPLATE);
      expect(e.body.evidence?.request_inputs?.invoice_text_sha256).toBe(e.body.invoice_hash);
      expect(e.body.evidence?.request_inputs?.mandates.map((m) => m.id)).toEqual([
        e.body.mandate_id,
      ]);
    }
    expect(s.chain.mandates?.map((m) => m.id)).toEqual([1, 2]);
    expect(PROPOSAL_MAX_TOKENS).toBe(4096);
  });

  it("passes A8 and the mandate match on the committed snapshot with the committed invoice texts", async () => {
    const { snapshot, texts } = await committed();
    expect(texts.size).toBe(3);
    const report = await runChecks(snapshot, { now: NOW, invoiceTexts: texts });
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.id === "e")?.detail).toContain(
      "A8 (request binding and mandate match) passes for 2 of 2 attested decisions (seq 0, 2)",
    );
    const offline = await runChecks(snapshot, { now: NOW });
    expect(offline.checks.find((c) => c.id === "e")?.detail).toContain("A8 not run");
  });

  it("keeps the invoice texts byte for byte: the generator's text, LF only, and every invoice_hash is a text hash", async () => {
    const s = await makeFixtureSnapshot();
    for (const [key, file] of Object.entries(INVOICE_FILES)) {
      const bytes = await readFile(fixtureUrl(file));
      const text = FIXTURE_INVOICE_TEXTS[key as keyof typeof INVOICE_FILES];
      expect(bytes.equals(Buffer.from(text, "utf8")), file).toBe(true);
      expect(bytes.includes(0x0d), `${file} has a CR`).toBe(false);
    }
    const hashes = new Set(Object.values(FIXTURE_INVOICE_TEXTS).map((t) => sha256Hex(t)));
    for (const e of s.ledger)
      expect(hashes.has(String(e.body.invoice_hash)), `seq ${e.body.seq}`).toBe(true);
    for (const spend of s.chain.spends) expect(hashes.has(spend.invoice_hash)).toBe(true);
  });

  it("marks the invoice-text fixtures -text in .gitattributes", async () => {
    const attributes = await readFile(new URL("../../../.gitattributes", import.meta.url), "utf8");
    expect(attributes).toMatch(/^packages\/core\/test\/fixtures\/invoice-\*\.txt -text$/m);
  });
});
