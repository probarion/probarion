import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { REGEXES_FOR_TESTS, readAmount } from "./amount";

// The ReDoS battery (ruling W-T13-B18). Every RegExp the reader and the lexicon declare runs against adversarial
// runs of about 20,000 characters (blanks, punctuation, letters, digits and their alternations, each closed by a
// character that forces a mismatch), alone and after a label word of its own, in under 50 ms each (best of 3). The
// regex literals are read from the source, so a new one is covered as soon as it is written; a regex built at run
// time is reached through REGEXES_FOR_TESTS, which must name every top-level one.

const LIMIT_MS = 50;
const UNITS = [" ", "\t", "\n", ":", "#", ".", "-", ",", "a", "1", "é", " :", "1,", "a ", "inv"];
const CLOSERS = ["x", "!"];
/** A run is first tried at 1,000 characters, so a regex that is far from linear fails there, before 20,000. */
const SIZES = [1_000, 20_000];

interface Scanned {
  /** Each regex literal anywhere in the file (functions too), compiled from its own text. */
  literals: { where: string; re: RegExp }[];
  /** The top-level consts built at run time (new RegExp, phrases()). */
  built: string[];
}

function scan(name: string): Scanned {
  const text = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
  const src = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const literals: Scanned["literals"] = [];
  const visit = (node: ts.Node) => {
    if (ts.isRegularExpressionLiteral(node)) {
      const t = node.text;
      const end = t.lastIndexOf("/");
      const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
      literals.push({
        where: `${name}:${line}`,
        re: new RegExp(t.slice(1, end), t.slice(end + 1)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  const built: string[] = [];
  for (const st of src.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      const e = d.initializer;
      if (
        e &&
        ((ts.isNewExpression(e) && e.expression.getText(src) === "RegExp") ||
          (ts.isCallExpression(e) && e.expression.getText(src) === "phrases"))
      )
        built.push(d.name.getText(src));
    }
  }
  return { literals, built };
}

const amount = scan("amount.ts");
const lexicon = scan("lexicon.ts");

/** Every regex once (by source and flags), with where it is declared. */
const REGEXES = (() => {
  const all = [
    ...amount.literals,
    ...lexicon.literals,
    ...Object.entries(REGEXES_FOR_TESTS).map(([n, re]) => ({ where: `amount.ts ${n}`, re })),
  ];
  const seen = new Map<string, { where: string; re: RegExp }>();
  for (const r of all) {
    const key = `${r.re.flags}/${r.re.source}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
})();

/**
 * The label prefixes of a regex: none, and up to four words of two letters or more written in its source ("lnvolce",
 * "total"), each alone and closed by "#" or ":" as a label is ("invoice#", "total:").
 */
function labelsOf(re: RegExp): string[] {
  const words = [
    ...new Set((re.source.match(/(?<![\\a-z])[a-z]{2,}/gi) ?? []).map((w) => w.toLowerCase())),
  ];
  return ["", ...words.slice(0, 4).flatMap((w) => [w, `${w}#`, `${w}:`])];
}

/** The best of up to 3 runs of `re.test(text)`, in ms (a first run under the limit is the answer). */
function bestMs(re: RegExp, text: string): number {
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k < 3 && best >= LIMIT_MS; k++) {
    re.lastIndex = 0;
    const t0 = performance.now();
    re.test(text);
    best = Math.min(best, performance.now() - t0);
  }
  re.lastIndex = 0;
  return best;
}

describe("the ReDoS battery", () => {
  it("reaches every RegExp the reader and the lexicon declare", () => {
    expect(amount.literals.length).toBeGreaterThan(150);
    for (const name of amount.built) expect(Object.keys(REGEXES_FOR_TESTS), name).toContain(name);
    expect(lexicon.built).toEqual([]); // the lexicon's regexes are literals, read from the source
    expect(lexicon.literals.length).toBeGreaterThanOrEqual(7);
  });

  it.each(REGEXES.map((r) => [r.where, r.re] as const))(
    "%s stays linear on long runs, alone and after its own label words",
    (_where, re) => {
      const slow: string[] = [];
      for (const label of labelsOf(re)) {
        for (const unit of UNITS) {
          for (const closer of CLOSERS) {
            for (const size of SIZES) {
              const text = `${label}${unit.repeat(Math.ceil(size / unit.length))}${closer}`;
              const ms = bestMs(re, text);
              if (ms >= LIMIT_MS) {
                slow.push(
                  `${JSON.stringify(label)} + ${JSON.stringify(unit)} x ${size} + ${closer}: ${ms.toFixed(0)} ms`,
                );
                break; // a larger run of the same shape is slower still
              }
            }
          }
        }
      }
      expect(slow).toEqual([]);
    },
    60_000,
  );

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
  ])("reads %s, past the title gate, in under 50 ms", (_why, text) => {
    let best = Number.POSITIVE_INFINITY;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      readAmount(text);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(LIMIT_MS);
  });
});
