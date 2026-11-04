import { beforeAll, describe, expect, it } from "vitest";
import { MAX_READ_UNITS } from "./amount";
import { MAX_TEXT_CHARS } from "./extract";
import { extractFacts } from "./facts";

// The facts are read in linear time, whatever the text. One wall-clock case stays from the first ReDoS fix (50,000
// spaces after "Total" in under 100 ms); every heavier shape is checked by how its time grows instead, which does
// not flake on a busy machine: the best of three runs, four times the input takes at most eight times as long
// (against at least 2 ms, below which timers are noise), and never more than a second.

const H = "c".repeat(64);
const RUNS = 3;

function best(text: string): number {
  let ms = Number.POSITIVE_INFINITY;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    extractFacts(text, H, null);
    ms = Math.min(ms, performance.now() - t0);
  }
  return ms;
}

describe("extractFacts on adversarial text", () => {
  beforeAll(() => {
    extractFacts("Invoice INV-1\nPO: PO-4471\nFrom: Acme\nPay to a.near\nTotal 5 USDC", H, null); // warm up
  });

  it("reads 50,000 spaces after Total in under 100 ms", () => {
    const text = `Total${" ".repeat(50_000)}`;
    expect(extractFacts(text, H, null)).toMatchObject({ amount: "0", amountIssue: "unreadable" });
    expect(best(text)).toBeLessThan(100);
  });

  // Each shape at n and at 4n characters (4n stays under the read cap, so the whole reader runs).
  const shapes: [string, (n: number) => string][] = [
    ["spaces after Total, then a figure", (n) => `Total${" ".repeat(n)}$9,999`],
    ["tabs and line breaks after Total", (n) => `Total${" \t\n".repeat(n / 3)}`],
    ["repeated Total tokens", (n) => "Total ".repeat(n / 6)],
    ["repeated Total tokens before one figure", (n) => `${"Total ".repeat(n / 6)}$1`],
    ["repeated readable totals", (n) => "Total 1 USDC\n".repeat(n / 13)],
    ["repeated glued totals", (n) => "Total00\n".repeat(n / 8)],
    ["repeated look-alike labels", (n) => "T\u0966tal $9\n".repeat(n / 9)],
    ["repeated payable lines with dates", (n) => "Due date: 2026-12-01\n".repeat(n / 21)],
    ["repeated line items", (n) => "Logo design $700.00\n".repeat(n / 20)],
    ["colons and dashes after Total", (n) => `Total${":-".repeat(n / 2)} $1`],
    ["dot leaders", (n) => `Total ${".".repeat(n)} $1`],
    ["a long dash run before a total", (n) => `Sub${"-".repeat(n)}total $5`],
    ["a figure of many digits", (n) => `Total $${"1".repeat(n)}`],
    ["grouped digits without end", (n) => `Total $1${",000".repeat(n / 4)}`],
    ["spaces after Invoice", (n) => `Invoice${" ".repeat(n)}x`],
    ["spaces after PO", (n) => `PO${" ".repeat(n)}x`],
    ["spaces after a payee label", (n) => `From:${" ".repeat(n)}`],
    ["a long dotted name", (n) => "a.".repeat(n / 2)],
    ["hyphen runs (the NEAR account shape)", (n) => `${"a-".repeat(31)}.`.repeat(n / 63)],
    ["capital words", (n) => "ABC ".repeat(n / 4)],
    ["text in another script", (n) => "\u682a\u5f0f\u4f1a\u793e ".repeat(n / 5)],
    ["characters NFKC expands", (n) => "\ufdfa".repeat(n / 18)],
  ];

  it.each(shapes)("grows linearly on %s", (_why, shape) => {
    const n = 12_500;
    expect(shape(4 * n).length).toBeLessThanOrEqual(MAX_READ_UNITS);
    const small = best(shape(n));
    const large = best(shape(4 * n));
    expect(large).toBeLessThan(1000);
    expect(large).toBeLessThanOrEqual(8 * Math.max(small, 2));
  });

  it("scans 500 KB of the NEAR-account shape for payee hints in well under 200 ms", () => {
    const text = `${"a-".repeat(31)}.`.repeat(7940).slice(0, 500_000);
    expect(text.length).toBeGreaterThan(10 * MAX_TEXT_CHARS - 1);
    expect(best(text)).toBeLessThan(200);
  });
});
