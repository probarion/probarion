import type { DecisionInput } from "@probarion/core";
import { describe, expect, it } from "vitest";
import {
  NUMBER_DUPLICATE_RULE,
  numberDuplicateNotice,
  numberDuplicateRule,
} from "./number-duplicate";
import type { NumberMatch } from "./store";

const EARLIER = "a".repeat(64);
const PAYEE = { type: "near", account_id: "vendor.near" } as const;
const match = (over: Partial<NumberMatch> = {}): NumberMatch => ({
  id: "0b6f1c1e-0000-4000-8000-000000000001",
  invoice_hash: EARLIER,
  status: "decided",
  outcome_status: "paid",
  ...over,
});
const check = (m: NumberMatch) => numberDuplicateRule(m, PAYEE).check({} as DecisionInput, null);

describe("numberDuplicateRule", () => {
  it("refuses, naming the payee and the earlier invoice by its hash, never by its number", () => {
    const rule = numberDuplicateRule(match(), PAYEE);
    expect(rule.id).toBe(NUMBER_DUPLICATE_RULE);
    expect(NUMBER_DUPLICATE_RULE).toBe("custom.invoice_number_duplicate");
    expect(check(match())).toEqual({
      id: NUMBER_DUPLICATE_RULE,
      outcome: "refuse",
      detail: `another invoice to near:vendor.near has the same invoice number: invoice ${EARLIER}, which was paid. Nothing is sent.`,
    });
  });

  it.each([
    [{ status: "decided", outcome_status: "paid" }, "was paid"],
    [{ status: "decided", outcome_status: "burned" }, "was paid"],
    [{ status: "decided", outcome_status: "settled" }, "was paid"],
    [{ status: "decided", outcome_status: "held" }, "is held for approval"],
    [{ status: "unconfirmed", outcome_status: "unconfirmed" }, "was sent, confirmation pending"],
    [{ status: "awaiting_owner", outcome_status: "held" }, "waits for the owner"],
    [{ status: "processing", outcome_status: null }, "has an unknown outcome"],
  ] as const)("words an earlier invoice %j as %j", (state, words) => {
    expect(check(match(state)).detail).toContain(`, which ${words}. Nothing is sent.`);
  });
});

describe("numberDuplicateNotice", () => {
  const AGAIN = "upload this one again";
  const NOT_FREED =
    "The console does not yet free a number when that spend fails, is rejected or expires.";
  const STATES = [
    { status: "awaiting_owner", outcome_status: "held" },
    { status: "processing", outcome_status: null },
    { status: "unconfirmed", outcome_status: "unconfirmed" },
    { status: "decided", outcome_status: "paid" },
    { status: "decided", outcome_status: "burned" },
    { status: "decided", outcome_status: "settled" },
    { status: "decided", outcome_status: "held" },
    { status: "received", outcome_status: null },
  ] as const;

  // The owner's Reject (0007 invoice_reject) clears the earlier invoice's number, and the takeover runs this text
  // again on its row.
  it("offers a re-upload only for an earlier invoice that waits for the owner, after a Reject", () => {
    const notice = numberDuplicateNotice(
      match({ status: "awaiting_owner", outcome_status: "held" }),
      true,
    );
    expect(notice).toMatch(
      /^Duplicate number: .*same invoice number.*Nothing was sent.*signed ledger/,
    );
    expect(notice.endsWith("If the owner rejects it, upload this one again.")).toBe(true);
  });

  // A Confirm can end held on chain (the number stays blocked), with a failure that leaves the row waiting or in
  // processing, or refused because that invoice's text was already paid (which frees the number of a paid bill).
  it.each(STATES)("does not offer a re-upload after a Confirm, for %j", (state) => {
    expect(numberDuplicateNotice(match(state), true)).not.toMatch(/\bconfirms?\b/i);
  });

  // invoice_set_outcome did not write this cycle's refusal: the new row stays in processing, so an upload of it again
  // answers 409 whatever happens to the earlier invoice.
  it.each(STATES)("offers no re-upload when the refusal was not recorded, for %j", (state) => {
    const notice = numberDuplicateNotice(match(state), false);
    expect(notice).toBe(
      'Duplicate number: another invoice to this payee has the same invoice number. Nothing was sent, but the refusal could not be written to this invoice: the console shows it as "Outcome unknown: do not resend", and the number stays blocked.',
    );
  });

  // invoice_insert (0016) keeps these numbers blocked, and nothing in the app moves such a row on: an upload of this
  // text again would only answer 409, so the notice must not offer one. A row left in processing is one of them: the
  // tenant lease means its cycle is not running when this rule runs, so it was cut off and may have paid.
  it.each([
    [
      { status: "processing", outcome_status: null },
      `may have paid, so the number stays blocked. ${NOT_FREED}`,
    ],
    [{ status: "decided", outcome_status: "paid" }, "was paid, so this one is not paid again."],
    [{ status: "decided", outcome_status: "burned" }, "was paid, so this one is not paid again."],
    [{ status: "decided", outcome_status: "settled" }, "was paid, so this one is not paid again."],
    [{ status: "decided", outcome_status: "held" }, `so the number stays blocked. ${NOT_FREED}`],
    [
      { status: "unconfirmed", outcome_status: "unconfirmed" },
      `is not confirmed, so the number stays blocked. ${NOT_FREED}`,
    ],
    [
      { status: "received", outcome_status: null },
      "The number stays blocked while that invoice may still pay.",
    ],
  ] as const)(
    "offers no re-upload for an earlier invoice %j, whose number stays blocked",
    (state, tail) => {
      const notice = numberDuplicateNotice(match(state), true);
      expect(notice).toMatch(
        /^Duplicate number: .*same invoice number.*Nothing was sent.*signed ledger/,
      );
      expect(notice.endsWith(tail)).toBe(true);
      expect(notice).not.toContain(AGAIN);
    },
  );

  // A bill reissued under a new number passes both guards and the contract's DuplicateInvoice. The console cannot show
  // that the earlier spend can no longer pay (a held spend may still be approved, a transaction whose outcome is
  // unknown can land for 48 hours), so no state's notice suggests one.
  it.each(STATES)("gives no advice to reissue the bill under a new number, for %j", (state) => {
    for (const recorded of [true, false]) {
      expect(numberDuplicateNotice(match(state), recorded)).not.toMatch(
        /new number|reissue|another number/i,
      );
    }
  });

  it("names neither the number nor the earlier invoice's hash", () => {
    for (const status of ["awaiting_owner", "processing", "unconfirmed", "decided"] as const) {
      for (const recorded of [true, false]) {
        expect(numberDuplicateNotice(match({ status }), recorded)).not.toContain(EARLIER);
      }
    }
  });
});
