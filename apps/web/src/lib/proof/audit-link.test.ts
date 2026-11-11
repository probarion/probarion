// The console's audit link for one Payables cycle (G4): the card of its decision on the vault's proof page.
import type { LedgerEntry } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { fullCardHref, fullCardSeq, proofAuditHref } from "./audit-link";

const VAULT = "demo.vaults.probarion.testnet";
const HASH = "d".repeat(64);
const entry = (seq: number, kind: string, bodyHash: string) =>
  ({ body_hash: bodyHash, body: { seq, kind } }) as unknown as LedgerEntry;
const ledger = [
  entry(0, "decision", "a".repeat(64)),
  entry(5, "decision", HASH),
  entry(6, "payment", "b".repeat(64)),
];

describe("proofAuditHref", () => {
  it("points at the spend's anchor when the contract created a spend", () => {
    expect(proofAuditHref(VAULT, ledger, { spendId: 2, decisionHash: HASH })).toBe(
      `/proof/${VAULT}#spend-2`,
    );
    // The spend id is enough: the proof page puts its anchor on the decision the chain binds it to.
    expect(proofAuditHref(VAULT, null, { spendId: 0, decisionHash: HASH })).toBe(
      `/proof/${VAULT}#spend-0`,
    );
  });

  it("points at the decision's seq when there is no spend", () => {
    expect(proofAuditHref(VAULT, ledger, { spendId: null, decisionHash: HASH })).toBe(
      `/proof/${VAULT}#seq-5`,
    );
  });

  it("is null when neither a spend nor the decision entry is known", () => {
    expect(
      proofAuditHref(VAULT, ledger, { spendId: null, decisionHash: "e".repeat(64) }),
    ).toBeNull();
    expect(proofAuditHref(VAULT, null, { spendId: null, decisionHash: HASH })).toBeNull();
    // Only a decision entry has a card: a payment entry with the hash does not count.
    expect(
      proofAuditHref(VAULT, ledger, { spendId: null, decisionHash: "b".repeat(64) }),
    ).toBeNull();
    // A spend id that is not a whole number names no anchor.
    expect(
      proofAuditHref(VAULT, ledger, { spendId: -1 as never, decisionHash: "e".repeat(64) }),
    ).toBeNull();
  });

  it("encodes the vault in the path, as the page's other proof link does", () => {
    expect(proofAuditHref("a b", null, { spendId: 1, decisionHash: HASH })).toBe(
      "/proof/a%20b#spend-1",
    );
  });
});

describe("fullCardHref and fullCardSeq", () => {
  it("links an older decision's full card on the same page, and reads the seq back from the address", () => {
    expect(fullCardHref(7)).toBe("?seq=7#seq-7");
    expect(fullCardSeq("7")).toBe(7);
    expect(fullCardSeq("0")).toBe(0);
    expect(fullCardSeq("999999999")).toBe(999999999);
  });

  it("reads nothing else as a seq", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "-1",
      "01",
      "1.5",
      "x",
      "1e3",
      " 1",
      "1234567890",
      ["1"],
      1,
    ]) {
      expect(fullCardSeq(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
