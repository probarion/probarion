import { describe, expect, it } from "vitest";
import {
  assessPayee,
  editDistance,
  isNearAccountId,
  type KnownPayee,
  lookalikeOf,
  PAYEE_BLOCKLIST,
  type PayeeRef,
  type PayeeSignals,
  parsePayeeRef,
  payeeRefOf,
  samePayee,
} from "../src/index.js";
import blocklistFile from "../src/payee-blocklist.json" with { type: "json" };

const READ_AT = "2026-11-14T00:00:00.000Z";
const VENDOR: PayeeRef = { chain: "near", address: "vendor.testnet" };
/** The Base payee of mainnet S2 (docs/evidence/mainnet-v0), in its EIP-55 checksum case. */
const BASE_PAYEE: PayeeRef = {
  chain: "base",
  address: "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27",
};
const IMPLICIT = `${"a".repeat(60)}b0b0`;

function known(payee: PayeeRef, paid = 0, mandates: number[] = [1]): KnownPayee {
  return { payee, paid, mandates };
}

/** A NEAR payee with every signal read and nothing found: the vault paid it twice under mandate 1. */
function signals(over: Partial<PayeeSignals> = {}): PayeeSignals {
  return {
    network: "testnet",
    payee: VENDOR,
    read_at: READ_AT,
    exists: true,
    contract: false,
    new_7d: false,
    code_changed_7d: false,
    past_block: 276_522_861,
    known_payees: [known(VENDOR, 2)],
    why_unknown: {},
    ...over,
  };
}

function baseSignals(over: Partial<PayeeSignals> = {}): PayeeSignals {
  return signals({
    network: "mainnet",
    payee: BASE_PAYEE,
    exists: null,
    code_changed_7d: null,
    past_block: null,
    known_payees: [known(BASE_PAYEE, 1)],
    ...over,
  });
}

const ids = (s: PayeeSignals, opts?: Parameters<typeof assessPayee>[1]) =>
  assessPayee(s, opts).reasons.map((r) => `${r.level}:${r.id}`);

describe("assessPayee: the verdict is the highest level among the reasons", () => {
  it("allows a payee with every check passed, and says what it checked", () => {
    const a = assessPayee(signals());
    expect(a.verdict).toBe("allow");
    expect(a.network).toBe("testnet");
    expect(a.payee).toEqual(VENDOR);
    expect(a.checked_at).toBe(READ_AT);
    expect(a.reasons.map((r) => `${r.level}:${r.id}`)).toEqual([
      "info:not_blocklisted",
      "info:no_lookalike",
      "info:paid_before",
      "info:found",
      "info:no_contract",
      "info:older_than_7d",
      "info:code_unchanged_7d",
    ]);
    expect(a.reasons.find((r) => r.id === "paid_before")?.text).toBe(
      "This vault paid near:vendor.testnet 2 times before.",
    );
  });

  it("is pure: the same signals give the same assessment, and the input is not changed", () => {
    const s = signals({ new_7d: true });
    const copy = structuredClone(s);
    expect(assessPayee(s)).toEqual(assessPayee(s));
    expect(s).toEqual(copy);
  });

  it("lists block reasons first, then warn, then info", () => {
    const levels = assessPayee(
      signals({ payee: { chain: "near", address: "vend0r.testnet" }, contract: true }),
    ).reasons.map((r) => r.level);
    expect(levels.indexOf("block")).toBe(0);
    expect(levels.lastIndexOf("block")).toBeLessThan(levels.indexOf("warn"));
    expect(levels.lastIndexOf("warn")).toBeLessThan(levels.indexOf("info"));
  });
});

describe("not_found", () => {
  it("blocks a named NEAR account that does not exist, and skips the reads it has no account for", () => {
    const a = assessPayee(
      signals({ exists: false, contract: null, new_7d: null, code_changed_7d: null }),
    );
    expect(a.verdict).toBe("block");
    expect(a.reasons[0]).toEqual({
      id: "not_found",
      level: "block",
      text: "No account vendor.testnet exists on NEAR testnet. Check the name with the payee: whoever creates this account would receive the payments.",
    });
    expect(a.reasons.map((r) => r.id)).not.toContain("contract_unknown");
  });

  it("warns, not blocks, for an unfunded implicit account (64 hex, or 0x and 40 hex)", () => {
    for (const address of [IMPLICIT, `0x${"c".repeat(40)}`]) {
      const payee: PayeeRef = { chain: "near", address };
      const a = assessPayee(
        signals({
          payee,
          exists: false,
          contract: null,
          new_7d: null,
          code_changed_7d: null,
          known_payees: [known(payee, 1)],
        }),
      );
      expect(a.verdict, address).toBe("warn");
      expect(a.reasons[0]?.id).toBe("not_found");
      expect(a.reasons[0]?.text).toContain("it has not been funded");
    }
  });

  it("warns when existence is unknown, with the reason the read failed", () => {
    const a = assessPayee(
      signals({
        exists: "unknown",
        contract: "unknown",
        why_unknown: { exists: "view_account: network error: timed out after 3000ms" },
      }),
    );
    expect(a.verdict).toBe("warn");
    expect(a.reasons.find((r) => r.id === "exists_unknown")?.text).toBe(
      "Could not read whether vendor.testnet exists on NEAR testnet (view_account: network error: timed out after 3000ms).",
    );
  });

  it("treats a NEAR existence a reader left out (null) as unknown: at least warn", () => {
    expect(assessPayee(signals({ exists: null })).verdict).toBe("warn");
  });
});

describe("blocklisted", () => {
  it("blocks a payee on the seed list of its network, with the entry's evidence URL", () => {
    const payee: PayeeRef = { chain: "near", address: "attacker-eval.testnet" };
    const a = assessPayee(signals({ payee, known_payees: null }));
    expect(a.verdict).toBe("block");
    expect(a.reasons[0]).toEqual({
      id: "blocklisted",
      level: "block",
      text: "near:attacker-eval.testnet is on Probarion's seed blocklist: the attacker's account in Probarion's own eval cases; Probarion does not hold it; no report of wrongdoing.",
      evidence: "https://github.com/probarion/probarion/blob/main/eval/cases.json",
    });
  });

  it("matches on the entry's network only, and takes a list from the caller", () => {
    const payee: PayeeRef = { chain: "near", address: "attacker-eval.testnet" };
    expect(ids(signals({ network: "mainnet", payee, known_payees: null }))).toContain(
      "info:not_blocklisted",
    );
    const own = [
      {
        network: "testnet" as const,
        payee: VENDOR,
        reason: "test entry",
        evidence: "https://example.com/report",
        added: "2026-11-14",
      },
    ];
    expect(assessPayee(signals(), { blocklist: own }).verdict).toBe("block");
  });

  it("seeds only the attacker's accounts from Probarion's own eval cases and fixtures, not a third party's", () => {
    expect(blocklistFile.about).toContain("A seed list, not a reputation service");
    expect(blocklistFile.about).toContain("Probarion does not hold them");
    expect(PAYEE_BLOCKLIST.length).toBe(blocklistFile.entries.length);
    for (const e of PAYEE_BLOCKLIST) {
      expect(e.reason).toMatch(
        /^the attacker's account in .*Probarion.*; Probarion does not hold it; no report of wrongdoing$/,
      );
      expect(e.evidence).toMatch(/^https:\/\/github\.com\/probarion\/probarion\/blob\/main\//);
      expect(e.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["mainnet", "testnet"]).toContain(e.network);
      expect(e.payee.chain).toBe("near");
      expect(isNearAccountId(e.payee.address)).toBe(true);
    }
    // attacker.testnet and attacker.near exist and are not Probarion's.
    const listed = PAYEE_BLOCKLIST.map((e) => e.payee.address);
    expect(listed).not.toContain("attacker.testnet");
    expect(listed).not.toContain("attacker.near");
    expect(Object.isFrozen(PAYEE_BLOCKLIST)).toBe(true);
  });
});

describe("lookalike", () => {
  it("blocks a Base address with the same first 4 and last 4 hex characters as a known payee", () => {
    const fake: PayeeRef = { chain: "base", address: "0xB22E00000000000000000000000000000000eB27" };
    const a = assessPayee(baseSignals({ payee: fake }));
    expect(a.verdict).toBe("block");
    expect(a.reasons[0]).toEqual({
      id: "lookalike",
      level: "block",
      text: "base:0xB22E00000000000000000000000000000000eB27 looks like base:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27, the payee of mandate 1 (the same first 4 and last 4 hex characters). Check every character with the payee through another channel before you sign.",
    });
  });

  it("does not flag 0xB22EAcDf…EB27 against its own lowercase form: it is the same payee, paid before", () => {
    const lower: PayeeRef = { chain: "base", address: BASE_PAYEE.address.toLowerCase() };
    expect(lookalikeOf(lower, BASE_PAYEE)).toBeNull();
    expect(samePayee(lower, BASE_PAYEE)).toBe(true);
    const a = assessPayee(baseSignals({ payee: lower }));
    expect(a.verdict).toBe("allow");
    expect(a.reasons.map((r) => r.id)).toContain("paid_before");
  });

  it("does not flag the same hex digits on another chain, nor hex addresses of different lengths", () => {
    const ethImplicit: PayeeRef = { chain: "near", address: BASE_PAYEE.address.toLowerCase() };
    expect(lookalikeOf(ethImplicit, BASE_PAYEE)).toBeNull();
    expect(lookalikeOf({ chain: "near", address: IMPLICIT }, BASE_PAYEE)).toBeNull();
  });

  it("blocks an implicit NEAR account that shares the first 4 and last 4 hex characters", () => {
    const fake: PayeeRef = { chain: "near", address: `aaaa${"0".repeat(56)}b0b0` };
    expect(lookalikeOf(fake, { chain: "near", address: IMPLICIT })).toBe(
      "the same first 4 and last 4 hex characters",
    );
  });

  it("blocks a named account at most 2 edits from a known payee when both are 6 characters or longer", () => {
    expect(lookalikeOf({ chain: "near", address: "vendro.testnet" }, VENDOR)).toBe(
      "one edit apart",
    );
    expect(lookalikeOf({ chain: "near", address: "vendors1.testnet" }, VENDOR)).toBe(
      "2 edits apart",
    );
    expect(lookalikeOf({ chain: "near", address: "vendorsxy.testnet" }, VENDOR)).toBeNull();
    // Shorter than 6: a single edit is too common to mean anything.
    expect(
      lookalikeOf({ chain: "near", address: "ab.ne" }, { chain: "near", address: "ac.ne" }),
    ).toBeNull();
    const a = assessPayee(signals({ payee: { chain: "near", address: "vendro.testnet" } }));
    expect(a.verdict).toBe("block");
    expect(a.reasons[0]?.id).toBe("lookalike");
  });

  it("measures the 6 characters on the whole account id, its ending included: a.near and b.near look alike", () => {
    const a: PayeeRef = { chain: "near", address: "a.near" };
    expect(lookalikeOf(a, { chain: "near", address: "b.near" })).toBe("one edit apart");
    expect(
      lookalikeOf({ chain: "near", address: "shop1.near" }, { ...a, address: "shop2.near" }),
    ).toBe("one edit apart");
  });

  it("blocks a name equal to a known payee after the confusables l/1, o/0 and rn/m", () => {
    const fold = "the same after reading rn as m, l as 1 and o as 0";
    expect(lookalikeOf({ chain: "near", address: "vend0r.testnet" }, VENDOR)).toBe(fold);
    expect(
      lookalikeOf({ chain: "near", address: "a1.near" }, { chain: "near", address: "al.near" }),
    ).toBe(fold);
    expect(
      lookalikeOf(
        { chain: "near", address: "rnoney.near" },
        { chain: "near", address: "money.near" },
      ),
    ).toBe(fold);
  });

  it("checks Solana addresses by their first 4 and last 4 characters, in exact case", () => {
    const real: PayeeRef = {
      chain: "solana",
      address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    };
    const fake: PayeeRef = {
      chain: "solana",
      address: "7xKX1111111111111111111111111111111111gAsU",
    };
    expect(lookalikeOf(fake, real)).toBe("the same first 4 and last 4 characters");
    expect(
      lookalikeOf({ ...fake, address: fake.address.replace("7xKX", "7xkX") }, real),
    ).toBeNull();
  });

  it("compares with every known payee but the payee itself", () => {
    const vendor2: PayeeRef = { chain: "near", address: "vendor2.testnet" };
    const a = assessPayee(signals({ known_payees: [known(VENDOR, 2), known(vendor2, 0, [3, 4])] }));
    expect(a.verdict).toBe("block");
    expect(a.reasons[0]?.text).toContain(
      "looks like near:vendor2.testnet, the payee of mandates 3, 4",
    );
  });
});

describe("contract", () => {
  it("warns for a NEAR account with code, and says a Safe or multisig is a contract too", () => {
    const a = assessPayee(signals({ contract: true }));
    expect(a.verdict).toBe("warn");
    const reason = a.reasons.find((r) => r.id === "contract");
    expect(reason?.level).toBe("warn");
    expect(reason?.text).toContain("A Safe or another multisig is also a contract");
  });

  it("warns for a Base address with code (eth_getCode is not 0x)", () => {
    const a = assessPayee(baseSignals({ contract: true }));
    expect(a.verdict).toBe("warn");
    expect(a.reasons.find((r) => r.id === "contract")?.text).toBe(
      "base:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27 has contract code on Base. A Safe is also a contract: confirm whose it is.",
    );
  });
});

describe("new_7d and code_changed_7d", () => {
  it("warns for a NEAR account that did not exist about 7 days ago, and names the block", () => {
    const a = assessPayee(signals({ new_7d: true, code_changed_7d: null }));
    expect(a.verdict).toBe("warn");
    expect(a.reasons.find((r) => r.id === "new_7d")?.text).toBe(
      "The account did not exist about 7 days ago (block 276522861): it is new.",
    );
    expect(a.reasons.map((r) => r.id)).not.toContain("code_change_unknown");
  });

  it("warns for a Base address with nonce 0", () => {
    const a = assessPayee(baseSignals({ new_7d: true }));
    expect(a.verdict).toBe("warn");
    expect(a.reasons.find((r) => r.id === "new_7d")?.text).toContain("(nonce 0)");
  });

  it("says that a Base nonce above 0 does not show an age, and that a contract has one too", () => {
    expect(assessPayee(baseSignals()).reasons.find((r) => r.id === "older_than_7d")?.text).toBe(
      "Its nonce on Base is above 0 (it has sent a transaction, or it is a deployed contract). This does not show its age.",
    );
  });

  it("warns when the code changed in about the last 7 days", () => {
    const a = assessPayee(signals({ contract: true, code_changed_7d: true }));
    expect(a.reasons.find((r) => r.id === "code_changed_7d")?.level).toBe("warn");
  });

  it("does not read code changes on Base: any code is already the contract warning", () => {
    expect(ids(baseSignals())).toEqual([
      "info:not_blocklisted",
      "info:no_lookalike",
      "info:paid_before",
      "info:no_contract",
      "info:older_than_7d",
    ]);
  });
});

describe("first_payment and paid_before", () => {
  it("warns on a first payment and suggests approval_above 0", () => {
    const a = assessPayee(signals({ known_payees: [known(VENDOR, 0)] }));
    expect(a.verdict).toBe("warn");
    expect(a.reasons[0]).toEqual({
      id: "first_payment",
      level: "warn",
      text: "This vault has not paid near:vendor.testnet before. Set approval_above to 0 on its mandate, so an approver signs each payment until you trust this payee.",
    });
  });

  it("warns on a payee the vault does not know at all", () => {
    expect(ids(signals({ known_payees: [] }))).toContain("warn:first_payment");
  });

  it("is info when the vault paid it before", () => {
    expect(ids(signals({ known_payees: [known(VENDOR, 1)] }))).toContain("info:paid_before");
  });

  it("takes the known payees from the options over the signals", () => {
    expect(assessPayee(signals(), { knownPayees: [] }).verdict).toBe("warn");
    expect(ids(signals(), { knownPayees: null })).toContain("warn:history_not_checked");
  });

  it("warns when the vault's history is unknown, and when no vault was given", () => {
    const a = assessPayee(
      signals({ known_payees: "unknown", why_unknown: { known_payees: "list_spends: HTTP 503" } }),
    );
    expect(a.verdict).toBe("warn");
    expect(a.reasons[0]?.text).toBe(
      "Could not read this vault's mandates and spends, so past payments and lookalikes were not checked (list_spends: HTTP 503).",
    );
    // Without a vault the lookalike and first-payment checks do not run: an old plain account still warns.
    const none = assessPayee(signals({ known_payees: null }));
    expect(none.verdict).toBe("warn");
    expect(none.reasons[0]).toEqual({
      id: "history_not_checked",
      level: "warn",
      text: "No vault given: lookalikes of its payees and past payments were not checked, so this may be a first payment.",
    });
  });
});

describe("never fails open", () => {
  const unknowns: Array<[string, Partial<PayeeSignals>]> = [
    ["exists", { exists: "unknown" }],
    ["contract", { contract: "unknown" }],
    ["new_7d", { new_7d: "unknown" }],
    ["code_changed_7d", { code_changed_7d: "unknown" }],
    ["known_payees", { known_payees: "unknown" }],
    ["contract null on NEAR", { contract: null }],
    ["new_7d null on NEAR", { new_7d: null }],
    ["code_changed_7d null on NEAR", { code_changed_7d: null }],
  ];
  it.each(unknowns)("an unreadable %s is at least warn", (_name, over) => {
    expect(assessPayee(signals(over)).verdict).not.toBe("allow");
  });

  it("warns, and does not throw, on signals built by hand with a missing or malformed history", () => {
    const bad = [
      undefined,
      "nope",
      {},
      [{ payee: VENDOR, paid: 2 }],
      [{ payee: null, paid: 2, mandates: [1] }],
    ] as unknown as PayeeSignals["known_payees"][];
    for (const known_payees of bad) {
      const a = assessPayee(signals({ known_payees }));
      expect(a.verdict, JSON.stringify(known_payees)).toBe("warn");
      expect(a.reasons[0]?.id).toBe("history_unknown");
    }
    const noBlock = assessPayee(
      signals({ past_block: undefined, why_unknown: undefined } as unknown as PayeeSignals),
    );
    expect(noBlock.reasons.find((r) => r.id === "older_than_7d")?.text).toBe(
      "The account existed about 7 days ago.",
    );
  });

  it("warns for Base reads that are unknown (Base testnet has no RPC) and for Solana, which is not read", () => {
    expect(
      assessPayee(baseSignals({ network: "testnet", contract: "unknown", new_7d: "unknown" }))
        .verdict,
    ).toBe("warn");
    const sol: PayeeRef = {
      chain: "solana",
      address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    };
    expect(
      assessPayee(
        signals({
          payee: sol,
          exists: null,
          contract: "unknown",
          new_7d: "unknown",
          known_payees: [known(sol, 3)],
        }),
      ).verdict,
    ).toBe("warn");
  });

  it("blocks a payee that is not a valid address for its chain, whatever the signals say", () => {
    for (const payee of [
      { chain: "near", address: "Vendor.testnet" },
      { chain: "base", address: "0x123" },
      { chain: "solana", address: "0OIl" },
      { chain: "tron", address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb" },
    ] as PayeeRef[]) {
      const a = assessPayee(signals({ payee }));
      expect(a.verdict, payee.address).toBe("block");
      expect(a.reasons.map((r) => r.id)).toEqual(["invalid_address"]);
    }
  });
});

describe("helpers", () => {
  it("parsePayeeRef reads near:, base: and solana:, and a bare NEAR account", () => {
    expect(parsePayeeRef("near:vendor.testnet")).toEqual({ ok: true, payee: VENDOR });
    expect(parsePayeeRef(" vendor.testnet ")).toEqual({ ok: true, payee: VENDOR });
    expect(parsePayeeRef(`base:${BASE_PAYEE.address}`)).toEqual({ ok: true, payee: BASE_PAYEE });
    expect(parsePayeeRef(BASE_PAYEE.address)).toEqual({
      ok: false,
      problem: `write near:${BASE_PAYEE.address} or base:${BASE_PAYEE.address}: a bare 0x value is both`,
    });
    expect(parsePayeeRef("tron:abc").ok).toBe(false);
    expect(parsePayeeRef("near:Vendor").ok).toBe(false);
    expect(parsePayeeRef("").ok).toBe(false);
  });

  it("payeeRefOf drops an Intents payee's asset", () => {
    expect(
      payeeRefOf({
        type: "intents",
        chain: "base",
        address: BASE_PAYEE.address,
        asset: "base-x.omft.near",
      }),
    ).toEqual(BASE_PAYEE);
    expect(payeeRefOf({ type: "near", account_id: "vendor.testnet" })).toEqual(VENDOR);
  });

  it("editDistance counts a swap of two neighbours as one edit", () => {
    expect(editDistance("vendor", "vendro")).toBe(1);
    expect(editDistance("vendor", "vendor")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });
});
