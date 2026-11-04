import { describe, expect, it } from "vitest";
import { checkRegex } from "../../../test/fixtures/redos";
import { REGEXES_FOR_TESTS } from "./amount";

// The battery's checker on planted regexes (ruling W-T13-B19): each slow one must be flagged, each control must
// pass. The old forms of three regexes the reader fixed are rebuilt from the current sources, so the test also
// shows the checker would have caught them.

const B = String.fromCharCode(92);

/** The current regex with one written piece replaced by its old form. */
function older(name: string, now: string, before: string): RegExp {
  const re = REGEXES_FOR_TESTS[name];
  if (re === undefined) throw new Error(`no ${name}`);
  if (!re.source.includes(now)) throw new Error(`${name} no longer holds ${now}`);
  return new RegExp(re.source.replace(now, before), re.flags);
}

const PLANTED: [string, RegExp][] = [
  ["two blank runs after a letter", /a\s*\s*b/],
  ["two blank runs after #", /#\s*\s*c/],
  ["two blank runs after a digit", /1\s*\s*c/],
  ["two blank runs after $ before a digit", /\$\s*\s*\d/],
  ["two blank runs after a two-letter label", /Tx\s*\s*c/],
  [
    "two blank runs in the last branch of an alternation",
    /(?:alpha|beta|gamma|delta)\s*b|omega\s*\s*c/,
  ],
  ["an exponential nested repeat", /ab(?:\s+)+c/],
  [
    "DOCUMENT_REF before ruling B19",
    older("DOCUMENT_REF", `${B}s*(?:[:#.-]${B}s*)?[a-z0-9])`, `${B}s*[:#.${B}t-]?${B}s*[a-z0-9])`),
  ],
  [
    "INVOICE_TITLE at bf90477",
    older(
      "INVOICE_TITLE",
      `(?:[^a-z0-9]*$|(?:[ ${B}t]*(?:#|no${B}.?(?![a-z])|number|num${B}.?(?![a-z])|n${B}u00b0))?(?:[^a-z0-9]*$|[ ${B}t:#.]*(?=[^${B}s]{0,64}${B}d)[^${B}s(]))`,
      `(?:[^a-z0-9]*$|[ ${B}t]*(?:#|no${B}.?(?![a-z])|number|num${B}.?(?![a-z])|n${B}u00b0)?[ ${B}t:#.]*(?:[^a-z0-9]*$|(?=[^${B}s]*${B}d)[^${B}s(]+))`,
    ),
  ],
  [
    "UNFOLDED_NUMBER at bf90477",
    older("UNFOLDED_NUMBER", `${B}s*(?:[:#.]${B}s*)?|`, `${B}s*[:#.]?${B}s*|`),
  ],
];

const CONTROLS: [string, RegExp][] = [
  ["one blank run after a letter", /a\s*b/],
  ["one blank run after #", /#\s*c/],
  ["a label, a separator and a figure", /(?<![a-z])total\s*:?\s?\d/i],
  ["a bounded blank run", /Tx[ \t]{0,4}\s{0,4}c/],
  ["DOCUMENT_REF", REGEXES_FOR_TESTS.DOCUMENT_REF as RegExp],
  ["INVOICE_TITLE", REGEXES_FOR_TESTS.INVOICE_TITLE as RegExp],
  ["UNFOLDED_NUMBER", REGEXES_FOR_TESTS.UNFOLDED_NUMBER as RegExp],
];

describe("the ReDoS battery's checker", () => {
  it.each(PLANTED)(
    "flags %s",
    (_why, re) => {
      expect(checkRegex(re)).not.toBeNull();
    },
    120_000,
  );

  it.each(CONTROLS)(
    "passes %s",
    (_why, re) => {
      expect(checkRegex(re)).toBeNull();
    },
    120_000,
  );
});
