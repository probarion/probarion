import { describe, expect, it } from "vitest";
import { checkRegex, LIMIT_MS, readerRegexes, scanModule } from "../../../test/fixtures/redos";
import { REGEXES_FOR_TESTS, readAmount } from "./amount";

// The ReDoS battery (rulings W-T13-B18 and B19), part 1 of 3: completeness, whole-reader cases, and the sweep of
// every third regex (test/fixtures/redos.ts checkRegex; parts 2 and 3 sweep the others, amount.redos-self.test.ts
// shows the checker flags planted slow regexes). Every RegExp of amount.ts and lexicon.ts is swept: the regex literals
// are read from the source, and a regex built at run time must be a top-level const listed in REGEXES_FOR_TESTS.

const PAYABLES = new URL("./", import.meta.url);
const amount = scanModule(new URL("amount.ts", PAYABLES), "amount.ts");
const lexicon = scanModule(new URL("lexicon.ts", PAYABLES), "lexicon.ts");

/**
 * The two helpers allowed to build a RegExp inside a function, and why each is covered:
 *   - phrases(): every call is the whole initialiser of a top-level const, which REGEXES_FOR_TESTS lists;
 *   - codeUse(): compiles one pattern per currency code, the same but for the code's letters; REGEXES_FOR_TESTS
 *     lists it for a word-like code (CAD) and for NEAR, whose bracket form differs.
 */
const HELPERS = new Set(["phrases", "codeUse"]);

describe("the ReDoS battery", () => {
  it("reaches every RegExp the reader and the lexicon declare", () => {
    const listed = new Set(Object.keys(REGEXES_FOR_TESTS));
    expect(amount.literals.length).toBeGreaterThan(150);
    // Every `new RegExp(...)` and `RegExp(...)`: a listed top-level const, or inside an allowed helper.
    for (const c of amount.constructions) {
      if (c.topLevel !== null) expect(listed, `${c.where} ${c.topLevel}`).toContain(c.topLevel);
      else
        expect(
          HELPERS,
          `${c.where} builds a RegExp in ${c.inFunction ?? "a nested expression"}`,
        ).toContain(c.inFunction);
    }
    const phrases = amount.calls.get("phrases");
    expect(phrases?.other, "phrases() called outside a top-level const").toBe(0);
    for (const name of phrases?.topLevel ?? []) expect(listed, name).toContain(name);
    expect(listed).toContain("CODE_USE_CAD");
    expect(listed).toContain("CODE_USE_NEAR");
    // The lexicon builds none: its regexes are literals, read from the source.
    expect(lexicon.constructions).toEqual([]);
    expect(lexicon.literals.length).toBeGreaterThanOrEqual(7);
  });

  const regexes = readerRegexes(PAYABLES, REGEXES_FOR_TESTS);
  it.each(regexes.filter((_, k) => k % 3 === 0).map((r) => [r.where, r.re] as const))(
    "%s stays linear on long runs after its own literal pieces",
    (_where, re) => expect(checkRegex(re)).toBeNull(),
    120_000,
  );

  /** Ten lines of an invoice, so a line after them is read past the header and the title gate. */
  const HEAD10 =
    "INVOICE INV-1\nAcme Design LLC\n1 Main St\nSpringfield\nIL 62701\nDate: 2026-11-01\nDue: 2026-12-01\nBill to: Beta\nTerms: Net 30\nLogo design $700.00\n";
  it.each([
    [
      "an invoice title line of 2,000 spaces",
      `Invoice${" ".repeat(2_000)}x\nAcme Design LLC\nLogo design $700.00\nTotal: $700.00`,
    ],
    [
      "a number label followed by 20,000 spaces",
      `INVOICE INV-1\ninvoice#${" ".repeat(20_000)}x\nLogo design $700.00\nTotal: $700.00`,
    ],
    [
      "a number label followed by 20,000 line ends",
      `INVOICE INV-1\ninvoice#${"\n".repeat(20_000)}x\nLogo design $700.00\nTotal: $700.00`,
    ],
    [
      "a receipt field on line 11 followed by 40,000 spaces and a mark",
      `${HEAD10}receipt#${" ".repeat(40_000)}!\nTotal: $700.00`,
    ],
    [
      "a receipt field on line 11 followed by 40,000 tabs and a mark",
      `${HEAD10}receipt#${"\t".repeat(40_000)}!\nTotal: $700.00`,
    ],
  ])(`reads %s, past the title gate, in under ${LIMIT_MS} ms`, (_why, text) => {
    let best = Number.POSITIVE_INFINITY;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      readAmount(text);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(LIMIT_MS);
  });
});
