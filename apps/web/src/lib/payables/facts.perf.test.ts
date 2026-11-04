import { beforeAll, describe, expect, it } from "vitest";
import { MAX_TEXT_CHARS } from "./extract";
import { extractFacts } from "./facts";

// W-T13-R2 (f): the readers run in linear time. Before this round, three adjacent unbounded `\s*` groups after
// "Total" (and the same shape after "Invoice" and "PO") backtracked: 4,000 spaces took about 15 s, 8,000 more than
// a minute. Every input here is at least MAX_TEXT_CHARS long (the longest text the pipeline reads) and must be read
// in under 100 ms. The best of three runs is compared with the limit, so a garbage-collection pause or a machine
// busy with the other test files does not fail the test; a regex that backtracks is slow on every run.

const H = "c".repeat(64);
const LIMIT_MS = 100;
const RUNS = 3;

function timed(text: string): { ms: number; f: ReturnType<typeof extractFacts> } {
  let best = Number.POSITIVE_INFINITY;
  let f = extractFacts("", H, null);
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    f = extractFacts(text, H, null);
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: best, f };
}

describe("extractFacts on adversarial text", () => {
  beforeAll(() => {
    extractFacts("Total 5 USDC\nInvoice INV-1\nPO: PO-4471\nFrom: Acme\nPay to a.near", H, null); // warm up
  });

  it("reads 50,000 spaces after Total in under 100 ms (the ruling's case)", () => {
    const { ms, f } = timed(`Total${" ".repeat(50_000)}`);
    expect(f).toMatchObject({ amount: "0", amountIssue: "not_found" });
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it.each([
    ["tabs and line breaks after Total", `Total${" \t\n".repeat(17_000)}`, "not_found"],
    ["spaces between Total and a figure", `Total${" ".repeat(50_000)}9,999`, "unreadable"],
    ["repeated Total tokens", "Total ".repeat(10_000), "not_found"],
    ["repeated Total tokens before one figure", `${"Total ".repeat(9_000)}1`, "unreadable"],
    ["repeated readable totals", "Total 1 USDC\n".repeat(4_000), null],
    ["colons and dashes after Total", `Total${":-".repeat(25_000)} 1`, "unreadable"],
    ["a long dash run before a total", `Sub${"-".repeat(50_000)}total 5`, "not_found"],
    ["a long space run before a total", `Sub${" ".repeat(50_000)}total 5`, "not_found"],
    ["a figure of 50,000 digits", `Total ${"1".repeat(50_000)}`, "unreadable"],
    ["grouped digits without end", `Total 1${",000".repeat(12_500)}`, "unreadable"],
    ["spaces after Grand", `Grand${" ".repeat(50_000)}x`, "not_found"],
    ["spaces after a currency code", `Total USD${" ".repeat(50_000)}x`, "not_found"],
  ])("reads %s in under 100 ms", (_why, text, issue) => {
    expect(text.length).toBeGreaterThanOrEqual(MAX_TEXT_CHARS);
    const { ms, f } = timed(text);
    expect(f.amountIssue).toBe(issue);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  // The other facts are read with regexes too: none of them may backtrack either.
  it.each([
    ["spaces after Invoice", `Invoice${" ".repeat(50_000)}x`],
    ["spaces after PO", `PO${" ".repeat(50_000)}x`],
    ["spaces after Purchase order", `Purchase order${" ".repeat(50_000)}x`],
    ["spaces after a payee label", `From:${" ".repeat(50_000)}`],
    ["a long dotted name that is no NEAR account", "a.".repeat(25_000)],
    ["a long hyphenated name", "a-".repeat(25_000)],
    ["a long word after Invoice", `Invoice ${"A".repeat(50_000)}`],
  ])("reads %s in under 100 ms", (_why, text) => {
    expect(text.length).toBeGreaterThanOrEqual(MAX_TEXT_CHARS);
    expect(timed(text).ms).toBeLessThan(LIMIT_MS);
  });

  it("refuses text that NFKC expands past what is read, quickly", () => {
    const { ms, f } = timed("\ufdfa".repeat(MAX_TEXT_CHARS));
    expect(f).toMatchObject({ amount: "0", amountIssue: "unreadable" });
    expect(ms).toBeLessThan(LIMIT_MS);
  });
});
