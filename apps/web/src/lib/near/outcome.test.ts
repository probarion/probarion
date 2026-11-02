import { describe, expect, it } from "vitest";
import {
  CALLBACK_METHODS,
  type ChainOutcome,
  describeTxResult,
  interpretChain,
  isTxHash,
  NOT_CONFIRMED_HEADLINE,
  NOT_SENT_HEADLINE,
  notSent,
  READERS,
  reportFromError,
  reportFromOutcome,
  sendLocked,
  type TxResult,
  UNKNOWN_HEADLINE,
  unconfirmed,
  withWords,
} from "./outcome";
import { GAS, type GasMethod, type ReadableMethod } from "./tx";

const HASH = "9fV2pZ7mUq5f6p3rGq7bX1tYkqfUu1Vb3bWm2C5g7h8J";
const HASH43 = HASH.slice(0, 43);
/** Every method the console can read the result of: the gas table's, and a plain Transfer. */
const ALL_METHODS = [...(Object.keys(GAS) as GasMethod[]), "Transfer"] as ReadableMethod[];

/** What a ChainOutcome says for a call that ran and returned `value`. */
function ran(value: unknown, over: Partial<ChainOutcome> = {}): ChainOutcome {
  return {
    txHash: HASH,
    ok: true,
    failed: false,
    value,
    empty: false,
    code: null,
    failure: null,
    firstReceiptOk: true,
    receiptFailed: false,
    ...over,
  };
}
const nothing = (over: Partial<ChainOutcome> = {}) => ran(null, { empty: true, ...over });

/** A top-level Failure, with whether the transaction's first receipt (the call itself) succeeded. */
function failedTx(firstReceiptOk: boolean | null, over: Partial<ChainOutcome> = {}): ChainOutcome {
  return {
    txHash: HASH,
    ok: false,
    failed: true,
    value: null,
    empty: false,
    code: null,
    failure: "Smart contract panicked: something",
    firstReceiptOk,
    receiptFailed: true,
    ...over,
  };
}

describe("isTxHash: base58, 43 or 44 characters", () => {
  it("accepts a real hash of either length", () => {
    expect(isTxHash(HASH)).toBe(true);
    expect(isTxHash(HASH43)).toBe(true);
    expect(isTxHash("3DFV2thBU9V4b5w7kM691poLJ8SWiCqp46LKBn1Fy9cX")).toBe(true);
  });

  it("refuses the wrong length, the characters base58 leaves out, and anything that is not a string", () => {
    expect(isTxHash(HASH.slice(0, 42))).toBe(false);
    expect(isTxHash(`${HASH}1`)).toBe(false);
    for (const bad of ["0", "O", "I", "l"]) {
      expect(isTxHash(bad + HASH.slice(1)), bad).toBe(false);
    }
    for (const bad of ["", "h1", " ".repeat(44), `${HASH}\n`, `${HASH} `, null, undefined, 5, {}]) {
      expect(isTxHash(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("reportFromOutcome: the wallet's object yields a hash and a signer, nothing else", () => {
  const wallet = (status: unknown, hash: unknown = HASH, signer: unknown = "owner.near") => ({
    status,
    transaction: { hash, signer_id: signer, receiver_id: "x.near" },
    transaction_outcome: { id: hash },
    receipts_outcome: [],
  });

  it("takes transaction.hash and transaction.signer_id", () => {
    expect(reportFromOutcome(wallet({ SuccessValue: "" }))).toEqual({
      txHash: HASH,
      signerId: "owner.near",
      message: null,
      code: null,
    });
  });

  it("does not care what status the wallet claims: a success, a failure and a lie give the same report", () => {
    const claims = [
      { SuccessValue: "" },
      { SuccessValue: "bnVsbA==" },
      { Failure: { ActionError: { kind: "x" } } },
      "Started",
      undefined,
      null,
    ];
    for (const status of claims) {
      expect(reportFromOutcome(wallet(status)), JSON.stringify(status)).toEqual({
        txHash: HASH,
        signerId: "owner.near",
        message: null,
        code: null,
      });
    }
  });

  it("takes the hash from transaction_outcome.id, then a plain hash field", () => {
    expect(reportFromOutcome({ transaction_outcome: { id: HASH } }).txHash).toBe(HASH);
    expect(reportFromOutcome({ txHash: HASH }).txHash).toBe(HASH);
    expect(reportFromOutcome({ transactionHash: HASH }).txHash).toBe(HASH);
  });

  it("the transaction's own hash wins over transaction_outcome.id", () => {
    const other = HASH.replace("9", "8");
    expect(
      reportFromOutcome({ transaction: { hash: HASH }, transaction_outcome: { id: other } }).txHash,
    ).toBe(HASH);
  });

  it("a hash that is not base58 of 43-44 characters is no hash", () => {
    for (const bad of ["h1", "", 5, null, "x".repeat(200), HASH.replace("9", "0"), `${HASH}1`]) {
      expect(reportFromOutcome(wallet({ SuccessValue: "" }, bad)).txHash, String(bad)).toBeNull();
    }
  });

  it("a signer that is not a NEAR account is no signer", () => {
    for (const bad of ["Owner.near", "a b", "", 5, null, "x".repeat(65)]) {
      expect(
        reportFromOutcome(wallet({ SuccessValue: "" }, HASH, bad)).signerId,
        String(bad),
      ).toBeNull();
    }
  });

  it("no outcome, and outcomes that are not objects, give an empty report", () => {
    const empty = { txHash: null, signerId: null, message: null, code: null };
    for (const v of [undefined, null, "ok", 5, [wallet({ SuccessValue: "" })]]) {
      expect(reportFromOutcome(v), JSON.stringify(v)).toEqual(empty);
    }
  });
});

describe("reportFromError: a wallet that threw", () => {
  const withProps = (props: Record<string, unknown>) =>
    Object.assign(new Error("Something went wrong"), props);

  it("finds a hash an error carries, a few levels in", () => {
    for (const e of [
      withProps({ txHash: HASH }),
      withProps({ tx_hash: HASH }),
      withProps({ transactionHash: HASH }),
      withProps({ transaction: { hash: HASH } }),
      withProps({ transaction_outcome: { id: HASH } }),
      withProps({ context: { transactionHash: HASH } }),
      withProps({ cause: { txHash: HASH } }),
      withProps({ result: { transaction: { hash: HASH } } }),
      { message: "boom", txHash: HASH },
    ]) {
      expect(reportFromError(e).txHash, JSON.stringify(e)).toBe(HASH);
    }
  });

  it("finds the signer next to the hash", () => {
    expect(
      reportFromError(withProps({ transaction: { hash: HASH, signer_id: "owner.near" } })).signerId,
    ).toBe("owner.near");
    expect(reportFromError(withProps({ signerId: "owner.near" })).signerId).toBe("owner.near");
  });

  it("takes a hash named in the message only next to a transaction keyword, in the right case", () => {
    expect(reportFromError(new Error(`Transaction ${HASH} failed to complete`)).txHash).toBe(HASH);
    expect(reportFromError(new Error(`TRANSACTION ${HASH}`)).txHash).toBe(HASH);
    expect(reportFromError(new Error(`see https://nearblocks.io/txns/${HASH}`)).txHash).toBe(HASH);
    expect(reportFromError(new Error(`tx hash: ${HASH}`)).txHash).toBe(HASH);
    expect(reportFromError(new Error(`tx_id=${HASH}`)).txHash).toBe(HASH);
    // a public key is not a transaction hash
    const key = "ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M";
    expect(reportFromError(new Error(`bad key ${key}`)).txHash).toBeNull();
    // the base58 alphabet has no 0, O, I or l: no case-insensitive lenience
    for (const c of ["0", "O", "I", "l"]) {
      const bad = c + HASH.slice(1);
      expect(reportFromError(new Error(`Transaction ${bad}`)).txHash, c).toBeNull();
    }
    // too long to be a hash
    expect(reportFromError(new Error(`Transaction ${HASH}1`)).txHash).toBeNull();
  });

  it("no hash anywhere is no hash", () => {
    for (const e of [
      new Error("User rejected the request"),
      "closed",
      undefined,
      { message: "x" },
    ]) {
      expect(reportFromError(e).txHash).toBeNull();
    }
  });

  it("keeps the wallet's words and a known PROBARION code in them, but promotes nothing else", () => {
    const r = reportFromError(new Error("Smart contract panicked: PROBARION:NotOwner"));
    expect(r.code).toBe("NotOwner");
    expect(r.message).toBe("Smart contract panicked: PROBARION:NotOwner");
    expect(reportFromError(new Error("PROBARION:Mystery")).code).toBeNull();
  });

  it("finds the code a wallet wrapped as the cause of its own error", () => {
    const wrapped = new Error("Transaction failed", {
      cause: new Error("Smart contract panicked: PROBARION:HoldExpired"),
    });
    expect(reportFromError(wrapped).code).toBe("HoldExpired");
    expect(
      reportFromError({ message: "failed", cause: { message: "PROBARION:Frozen" } }).code,
    ).toBe("Frozen");
  });

  it("copes with a string, a plain object and junk as the thrown value", () => {
    expect(reportFromError("User rejected").message).toBe("User rejected");
    expect(reportFromError(undefined).message).toMatch(/no message/);
    expect(reportFromError(new Error("")).message).toMatch(/no message/);
    expect(reportFromError("   ").message).toMatch(/no message/);
    expect(reportFromError(null).message).toMatch(/no message/);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(reportFromError(cyc).message).toContain("Circular");
    const deep = { cause: undefined as unknown };
    deep.cause = deep;
    expect(reportFromError(Object.assign(new Error("x"), deep)).txHash).toBeNull();
    const hostile = {
      get cause(): unknown {
        throw new Error("boom");
      },
    };
    expect(() => reportFromError(hostile)).not.toThrow();
  });
});

describe("what an unconfirmed send looks like", () => {
  it("keeps the hash, the code and the wallet's words", () => {
    expect(
      unconfirmed({ txHash: HASH, signerId: "owner.near", message: "Timeout", code: "Frozen" }),
    ).toEqual({ status: "unknown", txHash: HASH, code: "Frozen", error: "Timeout" });
  });

  it("says something useful when the wallet said nothing", () => {
    expect(unconfirmed({ txHash: null, signerId: null, message: null, code: null }).error).toMatch(
      /no transaction/,
    );
    expect(unconfirmed({ txHash: HASH, signerId: null, message: null, code: null }).error).toMatch(
      /no result/,
    );
  });

  it("truncates a long message", () => {
    const long = unconfirmed({
      txHash: null,
      signerId: null,
      message: "y".repeat(5000),
      code: null,
    });
    expect(long.error?.length).toBeLessThanOrEqual(500);
  });

  it("a send that never left us is a definite failure with no hash", () => {
    expect(notSent(new Error("Wallet is still loading"))).toEqual({
      status: "failed",
      txHash: null,
      code: null,
      error: "Wallet is still loading",
    });
    expect(notSent(undefined).error).toMatch(/no message/);
  });
});

describe("the per-method readers are exhaustive", () => {
  it("has a reader for every method in the gas table, plus Transfer, and nothing else", () => {
    expect(Object.keys(READERS).sort()).toEqual([...Object.keys(GAS), "Transfer"].sort());
  });

  it("names the callback methods from the contracts", () => {
    expect([...CALLBACK_METHODS].sort()).toEqual(["approve", "create_vault", "withdraw_intents"]);
  });
});

describe("R12: a call that ran is not an action that worked", () => {
  describe("create_vault (contracts/factory/src/lib.rs: on_vault_created -> Option<AccountId>)", () => {
    it("a vault account is ok", () => {
      expect(interpretChain("create_vault", ran("acme.vaults.probarion.near"))).toEqual({
        status: "ok",
        txHash: HASH,
        code: null,
        error: null,
      });
    });

    it("null means the batch rolled back and the deposit was refunded: failed, with exactly that reason", () => {
      expect(interpretChain("create_vault", ran(null))).toEqual({
        status: "failed",
        txHash: HASH,
        code: null,
        error: "name taken or deposit too low, refunded",
      });
    });

    it("null stays refused even though a receipt of the batch failed (that is why it is null)", () => {
      expect(interpretChain("create_vault", ran(null, { receiptFailed: true })).status).toBe(
        "failed",
      );
    });

    it("an empty, numeric or non-account result is not a created vault", () => {
      expect(interpretChain("create_vault", nothing()).status).toBe("unknown");
      for (const v of [7, {}, "", "Not An Account", true]) {
        expect(interpretChain("create_vault", ran(v)).status, JSON.stringify(v)).toBe("unknown");
      }
    });

    it("a created vault with a failed receipt in its tree is not whole: unknown", () => {
      expect(
        interpretChain("create_vault", ran("acme.vaults.probarion.near", { receiptFailed: true }))
          .status,
      ).toBe("unknown");
    });
  });

  describe("approve (contracts/vault/src/held.rs: PromiseOrValue<SpendResult>)", () => {
    const spend = (status: string) => ({ spend_id: 4, status });

    it("paid and burned are ok", () => {
      for (const status of ["paid", "burned"]) {
        expect(interpretChain("approve", ran(spend(status))).status, status).toBe("ok");
      }
    });

    it("failed means the payout failed and the reservation was released: failed, with exactly that reason", () => {
      expect(interpretChain("approve", ran(spend("failed"), { receiptFailed: true }))).toEqual({
        status: "failed",
        txHash: HASH,
        code: null,
        error: "payout failed, reservation released",
      });
    });

    it("any other status is not a confirmed payout", () => {
      for (const s of ["held", "pending", "rejected", "expired", "PAID", ""]) {
        expect(interpretChain("approve", ran(spend(s))).status, s).toBe("unknown");
      }
      for (const v of [{ spend_id: 4 }, null, "paid", 5]) {
        expect(interpretChain("approve", ran(v)).status, JSON.stringify(v)).toBe("unknown");
      }
      expect(interpretChain("approve", nothing()).status).toBe("unknown");
    });

    it("a payout reported paid next to a failed receipt is a contradiction: unknown", () => {
      expect(interpretChain("approve", ran(spend("paid"), { receiptFailed: true })).status).toBe(
        "unknown",
      );
    });
  });

  describe("withdraw_intents (intents ft_withdraw -> U128, 0 when nothing left Intents)", () => {
    it("a positive amount is ok", () => {
      expect(interpretChain("withdraw_intents", ran("5000000")).status).toBe("ok");
    });

    it('"0" means the withdrawal was undone inside Intents: failed', () => {
      const r = interpretChain("withdraw_intents", ran("0"));
      expect(r.status).toBe("failed");
      expect(r.error).toMatch(/nothing was withdrawn/i);
    });

    it("anything else is not a confirmed withdrawal", () => {
      for (const v of [5, "x", null, "05", "-1", {}]) {
        expect(interpretChain("withdraw_intents", ran(v)).status, JSON.stringify(v)).toBe(
          "unknown",
        );
      }
      expect(interpretChain("withdraw_intents", nothing()).status).toBe("unknown");
    });
  });

  describe("create_mandate (returns the new mandate's id)", () => {
    it("a positive id is ok", () => {
      expect(interpretChain("create_mandate", ran(3)).status).toBe("ok");
    });
    it("no id is not a created mandate", () => {
      for (const v of [0, -1, 1.5, "3", null]) {
        expect(interpretChain("create_mandate", ran(v)).status, JSON.stringify(v)).toBe("unknown");
      }
      expect(interpretChain("create_mandate", nothing()).status).toBe("unknown");
    });
  });

  describe("methods that return nothing", () => {
    const quiet: ReadableMethod[] = [
      "Transfer",
      "freeze",
      "unfreeze",
      "reject",
      "add_agent",
      "remove_agent",
      "set_ledger_key",
      "revoke_mandate",
      "withdraw",
      "storage_deposit",
      "ft_transfer",
    ];
    it.each(quiet)("%s is ok on an empty SuccessValue", (method) => {
      expect(interpretChain(method, nothing())).toEqual({
        status: "ok",
        txHash: HASH,
        code: null,
        error: null,
      });
    });
  });
});

describe("a success with a failed step under it is not whole (W-T6-R1)", () => {
  it.each([
    "add_agent",
    "remove_agent",
    "set_ledger_key",
    "revoke_mandate",
    "freeze",
    "unfreeze",
    "reject",
    "withdraw",
    "Transfer",
  ] as ReadableMethod[])("%s: a failed receipt under a top-level success is unknown", (method) => {
    const r = interpretChain(method, nothing({ receiptFailed: true }));
    expect(r.status).toBe("unknown");
    expect(r.txHash).toBe(HASH);
    expect(r.error).toMatch(/explorer/);
  });

  it("create_mandate: a failed payee registration under a returned id is unknown", () => {
    expect(interpretChain("create_mandate", ran(2, { receiptFailed: true })).status).toBe(
      "unknown",
    );
    expect(interpretChain("create_mandate", ran(2)).status).toBe("ok");
  });
});

describe("a failed top-level status (W-T6-R1)", () => {
  it.each([...CALLBACK_METHODS])(
    "%s: the call ran and a later step failed: unknown, so the button stays locked",
    (method) => {
      for (const first of [true, null]) {
        const r = interpretChain(method, failedTx(first, { code: "Frozen" }));
        expect(r.status, `${method} first=${first}`).toBe("unknown");
        expect(r.code).toBe("Frozen");
        expect(r.error).toMatch(/part of it may have happened/);
        expect(r.error).toContain("Smart contract panicked");
      }
    },
  );

  it.each([...CALLBACK_METHODS])("%s: the first receipt failed: a plain failure", (method) => {
    const r = interpretChain(method, failedTx(false, { code: "NotApprover" }));
    expect(r).toMatchObject({ status: "failed", txHash: HASH, code: "NotApprover" });
    expect(r.error).toContain("Smart contract panicked");
  });

  it.each(ALL_METHODS.filter((m) => !CALLBACK_METHODS.has(m)))(
    "%s (not a callback method): failed whatever the receipts say",
    (method) => {
      for (const first of [true, false, null]) {
        expect(interpretChain(method, failedTx(first)).status, `${method} first=${first}`).toBe(
          "failed",
        );
      }
    },
  );

  it("a status that is neither a success nor a failure is not final: unknown", () => {
    const notFinal: ChainOutcome = {
      ...ran(null),
      ok: false,
      failed: false,
      failure: "transaction outcome is not final: Started",
    };
    for (const method of ALL_METHODS) {
      const r = interpretChain(method, notFinal);
      expect(r.status, method).toBe("unknown");
      expect(r.error).toContain("not final");
    }
    expect(interpretChain("freeze", { ...notFinal, failure: null }).error).toMatch(/not final/);
  });

  it("truncates a long failure", () => {
    expect(
      interpretChain("freeze", failedTx(false, { failure: "x".repeat(5000) })).error?.length,
    ).toBeLessThanOrEqual(500);
  });
});

describe("what the owner reads", () => {
  const r = (over: Partial<TxResult>): TxResult => ({
    status: "ok",
    txHash: HASH,
    code: null,
    error: null,
    ...over,
  });

  it("an unconfirmed send locks the button; nothing else does", () => {
    expect(sendLocked(r({ status: "unknown" }))).toBe(true);
    expect(sendLocked(r({ status: "unknown", txHash: null }))).toBe(true);
    expect(sendLocked(r({ status: "ok" }))).toBe(false);
    expect(sendLocked(r({ status: "failed" }))).toBe(false);
    expect(sendLocked(null)).toBe(false);
  });

  it("unknown with a hash says sent, and to confirm on the explorer", () => {
    const v = describeTxResult(r({ status: "unknown", error: "Exceeded 60 seconds" }));
    expect(v).toEqual({
      tone: "warn",
      headline: "Sent: confirm on the explorer",
      detail: "Exceeded 60 seconds",
      explorer: "tx",
    });
    expect(UNKNOWN_HEADLINE).toBe("Sent: confirm on the explorer");
  });

  it("unknown with no hash (a cancel, a closed wallet) says not confirmed and to check first", () => {
    const v = describeTxResult(
      r({ status: "unknown", txHash: null, error: "User rejected the request" }),
    );
    expect(v).toEqual({
      tone: "warn",
      headline: "Not confirmed: if you approved in your wallet, check the explorer first",
      detail: "User rejected the request",
      explorer: "account",
    });
    expect(NOT_CONFIRMED_HEADLINE).toBe(v.headline);
  });

  it("an unknown result shows the code next to the wallet's or chain's words", () => {
    expect(
      describeTxResult(r({ status: "unknown", code: "LackBalanceForState", error: "out of NEAR" }))
        .detail,
    ).toBe("LackBalanceForState: out of NEAR");
    expect(describeTxResult(r({ status: "unknown", code: "Frozen", error: null })).detail).toBe(
      "Frozen",
    );
  });

  it("no unknown result ever says failed, refused or try again", () => {
    for (const result of [
      r({ status: "unknown", error: "The wallet gave no result for this transaction." }),
      r({ status: "unknown", txHash: null, error: "The wallet gave no transaction." }),
      unconfirmed(reportFromError(new Error("TIMEOUT_ERROR"))),
      unconfirmed(reportFromOutcome(undefined)),
      interpretChain("approve", failedTx(true)),
      interpretChain("freeze", nothing({ receiptFailed: true })),
    ]) {
      const v = describeTxResult(result);
      expect(v.tone).toBe("warn");
      expect(`${v.headline}`).not.toMatch(/try again|retry|failed|refused/i);
    }
  });

  it("ok is Done with the transaction link", () => {
    expect(describeTxResult(r({}))).toEqual({
      tone: "good",
      headline: "Done",
      detail: null,
      explorer: "tx",
    });
    expect(describeTxResult(r({ txHash: null })).explorer).toBeNull();
  });

  it("a chain-confirmed failure is Refused, with the code, the reason and the link", () => {
    expect(describeTxResult(r({ status: "failed", code: "NotOwner", error: "panic" }))).toEqual({
      tone: "bad",
      headline: "Refused: NotOwner",
      detail: "panic",
      explorer: "tx",
    });
    expect(describeTxResult(r({ status: "failed", error: "panic" })).headline).toBe("Refused");
  });

  it("a send that never left us is Not sent, with no link", () => {
    expect(
      describeTxResult(
        r({ status: "failed", txHash: null, error: "Your wallet is connected as a.near" }),
      ),
    ).toEqual({
      tone: "bad",
      headline: "Not sent",
      detail: "Your wallet is connected as a.near",
      explorer: null,
    });
    expect(NOT_SENT_HEADLINE).toBe("Not sent");
  });

  it("the R12 refusals read as a refusal with their reason, and invite no blind retry", () => {
    const v = describeTxResult(interpretChain("create_vault", ran(null)));
    expect(v.headline).toBe("Refused");
    expect(v.detail).toBe("name taken or deposit too low, refunded");
    expect(`${v.headline} ${v.detail}`).not.toMatch(/try again|retry/i);
  });
});

describe("withWords: a wrapper's wording on top of ours", () => {
  const base = describeTxResult({
    status: "unknown",
    txHash: HASH,
    code: "LackBalanceForState",
    error: "the vault is out of NEAR",
  });

  it("replaces the headline and the detail it names, and nothing else", () => {
    const v = withWords(base, {
      headline: "Sent, check your wallet",
      detail: "Top up your account",
    });
    expect(v).toEqual({
      ...base,
      headline: "Sent, check your wallet",
      detail: "Top up your account",
    });
    expect(v.tone).toBe(base.tone);
    expect(v.explorer).toBe(base.explorer);
  });

  it("keeps what it does not name, and a null detail clears the line", () => {
    expect(withWords(base, { detail: "only the detail" })).toEqual({
      ...base,
      detail: "only the detail",
    });
    expect(withWords(base, { headline: "only the headline" })).toEqual({
      ...base,
      headline: "only the headline",
    });
    expect(withWords(base, { detail: null }).detail).toBeNull();
    expect(withWords(base, { detail: undefined }).detail).toBe(base.detail);
    expect(withWords(base, {})).toEqual(base);
  });

  it("no words at all leaves the view as it is", () => {
    expect(withWords(base, null)).toBe(base);
    expect(withWords(base, undefined)).toBe(base);
  });

  it("does not change the view it was given", () => {
    const frozen = Object.freeze({ ...base });
    withWords(frozen, { headline: "x", detail: "y" });
    expect(frozen).toEqual(base);
  });
});
