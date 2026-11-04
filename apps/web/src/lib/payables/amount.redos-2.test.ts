import { describe, expect, it } from "vitest";
import { checkRegex, readerRegexes } from "../../../test/fixtures/redos";
import { REGEXES_FOR_TESTS } from "./amount";

// The ReDoS battery, part 2 of 3: the sweep of every third regex of amount.ts and lexicon.ts (amount.redos.test.ts
// has the completeness check, the whole-reader cases and part 1; test/fixtures/redos.ts has the checker).

const regexes = readerRegexes(new URL("./", import.meta.url), REGEXES_FOR_TESTS);

describe("the ReDoS battery, part 2", () => {
  it.each(regexes.filter((_, k) => k % 3 === 1).map((r) => [r.where, r.re] as const))(
    "%s stays linear on long runs after its own literal pieces",
    (_where, re) => expect(checkRegex(re)).toBeNull(),
    120_000,
  );
});
