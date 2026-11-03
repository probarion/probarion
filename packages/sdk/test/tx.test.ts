import { describe, expect, it } from "vitest";
import { ProbarionError } from "../src/errors.js";
import {
  firstReceiptSucceeded,
  isOutOfNearCode,
  OUT_OF_GAS_NEAR_DETAIL,
  OUT_OF_NEAR_DETAIL,
  parseTxOutcome,
} from "../src/tx.js";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

describe("parseTxOutcome", () => {
  it("decodes a JSON success value and the tx hash", () => {
    const out = parseTxOutcome({
      status: { SuccessValue: b64({ spend_id: 3, status: "paid" }) },
      transaction: { hash: "TxHash1" },
      transaction_outcome: { id: "TxHash1" },
      receipts_outcome: [],
    });
    expect(out).toMatchObject({
      ok: true,
      txHash: "TxHash1",
      value: { spend_id: 3, status: "paid" },
      code: null,
    });
  });

  it("treats an empty success value as null", () => {
    expect(
      parseTxOutcome({ status: { SuccessValue: "" }, transaction: { hash: "T" } }).value,
    ).toBeNull();
  });

  it("returns a non-JSON success value as text", () => {
    expect(
      parseTxOutcome({
        status: { SuccessValue: Buffer.from("plain").toString("base64") },
        transaction: { hash: "T" },
      }).value,
    ).toBe("plain");
  });

  it("maps a contract panic to its vault code", () => {
    const out = parseTxOutcome({
      status: {
        Failure: {
          ActionError: {
            index: 0,
            kind: {
              FunctionCallError: {
                ExecutionError: "Smart contract panicked: PROBARION:OverPerPayment",
              },
            },
          },
        },
      },
      transaction_outcome: { id: "TxHash2" },
    });
    expect(out).toMatchObject({ ok: false, txHash: "TxHash2", code: "OverPerPayment" });
  });

  it("maps a HostError.GuestPanic panic message too", () => {
    const out = parseTxOutcome({
      status: {
        Failure: {
          ActionError: {
            index: 0,
            kind: {
              FunctionCallError: { HostError: { GuestPanic: { panic_msg: "PROBARION:Frozen" } } },
            },
          },
        },
      },
      transaction: { hash: "T" },
    });
    expect(out).toMatchObject({ ok: false, code: "Frozen" });
  });

  it("keeps non-contract failures without a code", () => {
    const out = parseTxOutcome({
      status: { Failure: { InvalidTxError: { NotEnoughAllowance: {} } } },
      transaction: { hash: "T3" },
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBeNull();
    expect(out.failure).toContain("NotEnoughAllowance");
  });

  it("gives an unknown PROBARION code null plus the raw detail, never a crash", () => {
    const out = parseTxOutcome({
      status: {
        Failure: {
          ActionError: {
            index: 0,
            kind: {
              FunctionCallError: { ExecutionError: "Smart contract panicked: PROBARION:Mystery" },
            },
          },
        },
      },
      transaction: { hash: "T4" },
    });
    expect(out).toMatchObject({ ok: false, code: null, txHash: "T4" });
    expect(out.failure).toContain("PROBARION:Mystery");
  });

  it("falls back to a receipt's failure status for the code", () => {
    const out = parseTxOutcome({
      status: { Failure: { ActionError: { index: 0, kind: "UnknownKind" } } },
      transaction: { hash: "T5" },
      receipts_outcome: [
        { id: "r1", outcome: { logs: [], status: { SuccessReceiptId: "x" } } },
        {
          id: "r2",
          outcome: {
            logs: [],
            status: {
              Failure: {
                ActionError: {
                  index: 0,
                  kind: { FunctionCallError: { ExecutionError: "PROBARION:BadSeq" } },
                },
              },
            },
          },
        },
      ],
    });
    expect(out).toMatchObject({ ok: false, code: "BadSeq" });
  });

  it("ignores a PROBARION code that only appears in a receipt's logs", () => {
    const out = parseTxOutcome({
      status: { Failure: { InvalidTxError: "InvalidSignature" } },
      transaction: { hash: "T6" },
      receipts_outcome: [
        { id: "r1", outcome: { logs: ["PROBARION:NoMandate"], status: { SuccessValue: "" } } },
      ],
    });
    expect(out.code).toBeNull();
  });

  it("does not call a not-yet-final status a success", () => {
    for (const status of ["Started", "NotStarted", { SuccessReceiptId: "abc" }]) {
      const out = parseTxOutcome({ status, transaction: { hash: "T7" } });
      expect(out).toMatchObject({ ok: false, code: null, value: null });
      expect(out.failure).toContain("not final");
    }
  });

  it("rejects a result that is not an object", () => {
    expect(() => parseTxOutcome(null)).toThrow(ProbarionError);
    expect(() => parseTxOutcome("nope")).toThrow(ProbarionError);
  });

  it("copes with a result without status or hash", () => {
    const out = parseTxOutcome({});
    expect(out).toMatchObject({ ok: false, txHash: null, code: null });
  });
});

// R15. The shapes below come from near-api-js 7.4.0 (`ActionErrorKind` and `InvalidTxError` in
// types.gen, and the parsers in `parseActionError` / `parseInvalidTransactionError`).
describe("parseTxOutcome: LackBalanceForState (R15)", () => {
  const actionError = {
    status: {
      Failure: {
        ActionError: {
          index: null,
          kind: {
            LackBalanceForState: {
              account_id: "acme.vaults.probarion.testnet",
              amount: "4800000000000000000000",
            },
          },
        },
      },
    },
    transaction: { hash: "TxLack1" },
  };

  it("maps ActionError.kind.LackBalanceForState to a readable out-of-NEAR failure", () => {
    const out = parseTxOutcome(actionError);
    expect(out).toMatchObject({
      ok: false,
      txHash: "TxLack1",
      value: null,
      code: "LackBalanceForState",
      failure:
        "vault is out of free NEAR; top up with a plain transfer (each paid spend keeps about 0.0048 NEAR of storage)",
    });
    expect(out.failure).toBe(OUT_OF_NEAR_DETAIL);
    expect(out.raw).toBe(actionError);
  });

  it("maps the action error without an index key", () => {
    const out = parseTxOutcome({
      status: {
        Failure: {
          ActionError: { kind: { LackBalanceForState: { account_id: "v.testnet", amount: "1" } } },
        },
      },
    });
    expect(out.code).toBe("LackBalanceForState");
  });

  it("maps InvalidTxError.LackBalanceForState (rejected before execution)", () => {
    const out = parseTxOutcome({
      status: {
        Failure: {
          InvalidTxError: { LackBalanceForState: { signer_id: "v.testnet", amount: "7" } },
        },
      },
      transaction: { hash: "TxLack2" },
    });
    expect(out).toMatchObject({
      ok: false,
      code: "LackBalanceForState",
      failure: OUT_OF_NEAR_DETAIL,
    });
  });

  it("maps NotEnoughBalanceForDeposit whose reason is LackBalanceForState", () => {
    const out = parseTxOutcome({
      status: {
        Failure: {
          InvalidTxError: {
            NotEnoughBalanceForDeposit: {
              balance: "1",
              cost: "2",
              reason: "LackBalanceForState",
              signer_id: "v.testnet",
            },
          },
        },
      },
    });
    expect(out.code).toBe("LackBalanceForState");
  });

  it("maps the node's plain-text storage message", () => {
    const out = parseTxOutcome({
      status: {
        Failure: {
          ActionError: {
            index: 0,
            kind: {
              FunctionCallError: {
                ExecutionError:
                  'Account "v.testnet" doesn\'t have enough balance to cover storage, required to have 4800000000000000000000 yoctoNEAR more',
              },
            },
          },
        },
      },
    });
    expect(out.code).toBe("LackBalanceForState");
  });

  it("prefers a contract panic code over the storage hint", () => {
    const out = parseTxOutcome({
      status: {
        Failure: {
          ActionError: {
            index: 0,
            kind: { FunctionCallError: { ExecutionError: "PROBARION:Frozen" } },
          },
        },
      },
    });
    expect(out.code).toBe("Frozen");
  });
});

describe("parseTxOutcome: NotEnoughBalance (the vault cannot prepay gas)", () => {
  it("maps InvalidTxError.NotEnoughBalance to its own out-of-NEAR code and text", () => {
    const out = parseTxOutcome({
      status: {
        Failure: {
          InvalidTxError: {
            NotEnoughBalance: {
              balance: "1",
              cost: "20000000000000000000000",
              signer_id: "v.testnet",
            },
          },
        },
      },
      transaction: { hash: "TxGas1" },
    });
    expect(out).toMatchObject({
      ok: false,
      txHash: "TxGas1",
      code: "NotEnoughBalance",
      failure: OUT_OF_GAS_NEAR_DETAIL,
    });
    expect(out.failure).toBe(
      "vault holds less NEAR than a spend must prepay for gas (about 0.02 NEAR at 200 Tgas); top up with a plain transfer",
    );
  });

  it("maps a NotEnoughBalanceForDeposit whose reason is NotEnoughBalance", () => {
    const out = parseTxOutcome({
      status: {
        Failure: {
          InvalidTxError: {
            NotEnoughBalanceForDeposit: {
              balance: "1",
              cost: "2",
              reason: "NotEnoughBalance",
              signer_id: "v.testnet",
            },
          },
        },
      },
    });
    expect(out.code).toBe("NotEnoughBalance");
  });

  it("keeps the storage text for the storage case, even next to a deposit reason", () => {
    const out = parseTxOutcome({
      status: {
        Failure: {
          InvalidTxError: {
            NotEnoughBalanceForDeposit: {
              balance: "1",
              cost: "2",
              reason: "LackBalanceForState",
              signer_id: "v.testnet",
            },
          },
        },
      },
    });
    expect(out).toMatchObject({ code: "LackBalanceForState", failure: OUT_OF_NEAR_DETAIL });
  });

  it("does not take free text or other keys for a balance refusal", () => {
    const out = parseTxOutcome({
      status: {
        Failure: {
          ActionError: {
            index: 0,
            kind: { FunctionCallError: { ExecutionError: "the payee says NotEnoughBalance soon" } },
          },
        },
      },
    });
    expect(out.code).toBeNull();
  });

  it("isOutOfNearCode accepts exactly the two balance codes", () => {
    expect(isOutOfNearCode("LackBalanceForState")).toBe(true);
    expect(isOutOfNearCode("NotEnoughBalance")).toBe(true);
    expect(isOutOfNearCode("Frozen")).toBe(false);
    expect(isOutOfNearCode(null)).toBe(false);
  });
});

describe("firstReceiptSucceeded", () => {
  const withReceipts = (first: unknown, rest: unknown[] = []) => ({
    transaction_outcome: {
      id: "T",
      outcome: { receipt_ids: ["r1"], status: { SuccessReceiptId: "r1" } },
    },
    receipts_outcome: [{ id: "r1", outcome: { status: first } }, ...rest],
  });

  it("is false when the call's own receipt failed", () => {
    expect(firstReceiptSucceeded(withReceipts({ Failure: { ActionError: {} } }))).toBe(false);
  });

  it("is true when the call ran and a later receipt failed", () => {
    expect(
      firstReceiptSucceeded(
        withReceipts({ SuccessReceiptId: "r2" }, [
          { id: "r2", outcome: { status: { Failure: { ActionError: {} } } } },
        ]),
      ),
    ).toBe(true);
    expect(firstReceiptSucceeded(withReceipts({ SuccessValue: "" }))).toBe(true);
  });

  it("finds the call's receipt by id even when it is not listed first", () => {
    expect(
      firstReceiptSucceeded({
        transaction_outcome: { id: "T", outcome: { receipt_ids: ["r2"] } },
        receipts_outcome: [
          { id: "r1", outcome: { status: { SuccessValue: "" } } },
          { id: "r2", outcome: { status: { Failure: {} } } },
        ],
      }),
    ).toBe(false);
  });

  it("is null when the result carries no receipts to tell", () => {
    expect(firstReceiptSucceeded(null)).toBeNull();
    expect(firstReceiptSucceeded({})).toBeNull();
    expect(firstReceiptSucceeded({ receipts_outcome: [] })).toBeNull();
    expect(firstReceiptSucceeded(withReceipts("Unknown"))).toBeNull();
  });
});
