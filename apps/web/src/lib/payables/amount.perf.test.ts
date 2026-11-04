import { beforeAll, describe, expect, it } from "vitest";
import { MAX_READ_UNITS } from "./amount";
import { MAX_TEXT_CHARS } from "./extract";
import { extractFacts, fingerprintText, invoiceNumberOf } from "./facts";

// The facts are read in linear time, whatever the text. One wall-clock case stays from the first ReDoS fix (50,000
// spaces after "Total" in under 100 ms); every heavier shape is checked by how its time grows instead, which does
// not flake on a busy machine: the best of five runs, four times the input takes at most eight times as long
// (against at least 2 ms, below which timers are noise), and never more than a second.

const H = "c".repeat(64);
const RUNS = 5;
/** An invoice head before a long line of codes (the shape of the re-review's inputs). */
const HEAD = "Invoice INV-1\nTotal 5 USDC\n";

/** The best of five runs of extractFacts and the fingerprint together (the pipeline computes both). */
function best(text: string): number {
  let ms = Number.POSITIVE_INFINITY;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    extractFacts(text, H, null);
    fingerprintText(text);
    ms = Math.min(ms, performance.now() - t0);
  }
  return ms;
}

/** The best of five runs of one function. */
function bestOf(run: () => unknown): number {
  let ms = Number.POSITIVE_INFINITY;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    run();
    ms = Math.min(ms, performance.now() - t0);
  }
  return ms;
}

/** 19 distinct word-like codes, then a digit run: each code's contexts are read around the code. */
const CODES = "ALL AMD BAM BOB BTN CAD CUP CVE GEL MAD MDL MOP NEAR PEN PHP SOL SOS SVC TOP TRY ";

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
    // Word-like currency codes on one long line (each code is tested once per line).
    ["the word-like code ALL", (n) => `${HEAD}${"ALL ".repeat(n / 4)}`.slice(0, n)],
    ["the word-like code CAD", (n) => `${HEAD}${"CAD ".repeat(n / 4)}`.slice(0, n)],
    ["the word NEAR", (n) => `${HEAD}${"NEAR ".repeat(n / 5)}`.slice(0, n)],
    ["lower-case codes next to figures", (n) => "eur 1 ".repeat(n / 6)],
    ["codes glued to figures", (n) => "70EUR ".repeat(n / 6)],
    ["letter-spaced labels", (n) => "T o t a l ".repeat(n / 10)],
    ["labels split by a space", (n) => "To tal ".repeat(n / 7)],
    ["labels split across lines", (n) => "Tot-\nal\n".repeat(n / 8)],
    ["status words", (n) => "Status: ".repeat(n / 8)],
    ["stamps behind separators", (n) => "- void ".repeat(n / 7)],
    ["currency fields", (n) => "Currency ".repeat(n / 9)],
    ["repeated headers with totals", (n) => "INVOICE\nTotal 1 USDC\n".repeat(n / 21)],
    ["repeated payee headers with totals", (n) => "From: a\nTotal 1 USDC\n".repeat(n / 21)],
    ["repeated deductions and balances", (n) => "Deposit paid $1\nBalance due $1\n".repeat(n / 31)],
    ["rows of sums", (n) => "$1 ".repeat(n / 3)],
    ["labels with no figure", (n) => "Balance\n".repeat(n / 8)],
    ["a long underscore run inside a word", (n) => `a${"_".repeat(n - 2)}a`],
    ["a long space run after a stamp separator", (n) => `Invoice -${" ".repeat(n)}x`],
    // The fourth re-review's shapes.
    ["a payee line of percentages", (n) => "Pay to 1% ".repeat(n / 10)],
    ["a payee line of signed figures", (n) => "Pay to +5 ".repeat(n / 10)],
    ["characters NFKC doubles", (n) => "\ufb00".repeat(n / 2)],
    ["short lines of an I look-alike", (n) => `Total $5\n${"\u0406\u0406\u0406\n".repeat(n / 4)}`],
    [
      "short letter-spaced Cyrillic lines",
      (n) => `INVOICE\nTotal $1\n${"\u0410 \u0412 \u0421\n".repeat(n / 6)}`,
    ],
    [
      "distinct short lines of non-ASCII capitals",
      (n) => Array.from({ length: n / 10 }, (_, i) => `\u0406\u0406 ${i}`).join("\n"),
    ],
    [
      "many word-like codes before a digit run",
      (n) => `INVOICE\n${CODES}${"5".repeat(n)}`.slice(0, n),
    ],
    ["blank-rendering characters", (n) => "Logo\u2800design ".repeat(n / 12)],
    ["dash-like characters in numbers", (n) => "INV\u27961001 ".repeat(n / 9)],
  ];

  it.each(shapes)("grows linearly on %s", (_why, shape) => {
    const n = 12_000;
    expect(shape(4 * n).length).toBeLessThanOrEqual(MAX_READ_UNITS);
    const small = best(shape(n));
    const large = best(shape(4 * n));
    expect(large).toBeLessThan(1000);
    expect(large).toBeLessThanOrEqual(8 * Math.max(small, 2));
  });

  it.each([
    ["ALL", `${HEAD}${"ALL ".repeat(12_500)}`.slice(0, 50_000), "currency"],
    ["CAD", `${HEAD}${"CAD ".repeat(12_500)}`.slice(0, 50_000), "currency"],
    ["NEAR", `${HEAD}${"NEAR ".repeat(12_500)}`.slice(0, 50_000), null],
    ["ALL, unsliced", `${HEAD}${"ALL ".repeat(12_493)}`, "currency"],
  ])("reads a 50,000-character line of the code %s in under 100 ms", (_code, text, issue) => {
    expect(extractFacts(text, H, null).amountIssue).toBe(issue);
    expect(best(text)).toBeLessThan(100);
  });

  it.each([
    ["a payee line of percentages", "Pay to 1% ".repeat(4995)],
    [
      "short lines of an I look-alike",
      `Total $5\n${"\u0406\u0406\u0406\n".repeat(12_500)}`.slice(0, 50_000),
    ],
    [
      "short letter-spaced Cyrillic lines",
      `INVOICE INV-1001\nFrom: Acme\nTotal due: $100.00\n${"\u0410 \u0412 \u0421\n".repeat(8325)}`,
    ],
    [
      "many word-like codes before a digit run",
      `INVOICE\n${CODES}${"5".repeat(50_000)}`.slice(0, 50_000),
    ],
    ["characters NFKC doubles, up to the cap", "\ufb00".repeat(25_000)],
    ["characters NFKC expands past the cap", "\ufdfa".repeat(2_777)],
  ])("reads %s (50,000 characters) in under 100 ms", (_why, text) => {
    expect(text.length).toBeLessThanOrEqual(MAX_READ_UNITS);
    expect(best(text)).toBeLessThan(100);
  });

  it("refuses a text that NFKC expands past twice its length, before reading it", () => {
    expect(extractFacts(`Total 5 USDC\n${"\ufdfa".repeat(100)}`, H, null)).toMatchObject({
      amount: "0",
      amountIssue: "unreadable",
    });
    // Twice its length is still read.
    expect(extractFacts(`INVOICE\nTotal 5 USDC\n${"\ufb00".repeat(100)}`, H, null).amount).toBe(
      "5000000",
    );
  });

  it.each([
    ["ASCII", "a".repeat(50_000)],
    ["characters NFKC expands", "\ufdfa".repeat(50_000)],
    ["blank-rendering characters and dashes", "\u2800\u2796".repeat(25_000)],
  ])(
    "fingerprints and reads the number of 50,000 characters of %s in under 100 ms",
    (_why, text) => {
      expect(bestOf(() => fingerprintText(text))).toBeLessThan(100);
      expect(bestOf(() => invoiceNumberOf(text))).toBeLessThan(100);
    },
  );

  it.each([
    ["ASCII", `Invoice INV-1\nTotal 5 USDC\n${"a".repeat(4 * 1024 * 1024)}`],
    ["characters NFKC expands", "\ufdfa".repeat(4 * 1024 * 1024)],
    ["short lines of an I look-alike", "\u0406\u0406\u0406\n".repeat(1024 * 1024)],
  ])("reads, fingerprints and numbers 4 MiB of %s in under a second", (_why, text) => {
    const t0 = performance.now();
    expect(extractFacts(text, H, null).amount).toBe("0");
    fingerprintText(text);
    invoiceNumberOf(text);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("reads a 4 MiB text in under a second, without throwing", () => {
    const text = `Total 5 USDC\n${"a".repeat(4 * 1024 * 1024 - 13)}`;
    const t0 = performance.now();
    expect(extractFacts(text, H, null)).toMatchObject({ amount: "0", amountIssue: "unreadable" });
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("scans 500 KB of the NEAR-account shape for payee hints in well under 200 ms", () => {
    const text = `${"a-".repeat(31)}.`.repeat(7940).slice(0, 500_000);
    expect(text.length).toBeGreaterThan(10 * MAX_TEXT_CHARS - 1);
    expect(best(text)).toBeLessThan(200);
  });
});
