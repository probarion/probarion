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
  const NEW_NUMBER = "ask the payee for an invoice with a new number";

  // The owner's Reject (0007 invoice_reject) frees the number, and the takeover runs this text again on its row.
  it("offers a re-upload only for an earlier invoice that waits for the owner", () => {
    const notice = numberDuplicateNotice(
      match({ status: "awaiting_owner", outcome_status: "held" }),
    );
    expect(notice).toMatch(
      /^Duplicate number: .*same invoice number.*Nothing was sent.*signed ledger/,
    );
    expect(notice.endsWith("If the owner rejects it, upload this one again.")).toBe(true);
    expect(notice).not.toContain(NEW_NUMBER);
  });

  // invoice_insert (0016) keeps these numbers blocked, and nothing in the app moves such a row on: an upload of this
  // text again would only answer 409, so the notice must not offer one. A row left in processing is one of them: the
  // tenant lease means its cycle is not running when this rule runs, so it was cut off and may have paid.
  it.each([
    [{ status: "processing", outcome_status: null }, "A held spend may still pay."],
    [{ status: "decided", outcome_status: "paid" }, "was paid, so this one is not paid again."],
    [{ status: "decided", outcome_status: "burned" }, "was paid, so this one is not paid again."],
    [{ status: "decided", outcome_status: "settled" }, "was paid, so this one is not paid again."],
    [
      { status: "decided", outcome_status: "held" },
      `even once the approver rejects it or it expires: then ${NEW_NUMBER}.`,
    ],
    [{ status: "unconfirmed", outcome_status: "unconfirmed" }, "A held spend may still pay."],
    [
      { status: "received", outcome_status: null },
      "The number stays blocked while that invoice may still pay.",
    ],
  ] as const)(
    "offers no re-upload for an earlier invoice %j, whose number stays blocked",
    (state, tail) => {
      const notice = numberDuplicateNotice(match(state));
      expect(notice).toMatch(
        /^Duplicate number: .*same invoice number.*Nothing was sent.*signed ledger/,
      );
      expect(notice.endsWith(tail)).toBe(true);
      expect(notice).not.toContain(AGAIN);
    },
  );

  // A new number for a bill that was paid would let it pass both guards and the contract's DuplicateInvoice.
  it("gives no new-number advice for an earlier invoice that was paid", () => {
    for (const outcome_status of ["paid", "burned", "settled"] as const) {
      expect(numberDuplicateNotice(match({ status: "decided", outcome_status }))).not.toContain(
        NEW_NUMBER,
      );
    }
  });

  // A spend the vault holds (SpendStatus Held) has not paid but may still be approved: a new number for that bill could
  // be paid as well. For an earlier invoice whose outcome the app does not know, the advice waits for a spend that can
  // no longer pay, or for none at all, under its ref.
  it.each(["processing", "unconfirmed"] as const)(
    "asks for a new number after a %s invoice only once its spend cannot pay",
    (status) => {
      const notice = numberDuplicateNotice(match({ status, outcome_status: null }));
      expect(notice).toContain(
        `If the vault's spends show none under that invoice's ref, or one that failed, was rejected or expired, ${NEW_NUMBER}.`,
      );
      expect(notice).toContain("A held spend may still pay.");
      expect(notice).not.toMatch(/did not pay/);
    },
  );

  it("names neither the number nor the earlier invoice's hash", () => {
    for (const status of ["awaiting_owner", "processing", "unconfirmed", "decided"] as const) {
      expect(numberDuplicateNotice(match({ status }))).not.toContain(EARLIER);
    }
  });
});
