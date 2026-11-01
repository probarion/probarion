import { describe, expect, it } from "vitest";
import {
  describeTxResult,
  parseConnectError,
  parseTxOutcome,
  parseWalletError,
  sendLocked,
  settleSend,
  type TxResult,
} from "./outcome";

const HASH = "9fV2pZ7mUq5f6p3rGq7bX1tYkqfUu1Vb3bWm2C5g7h8J";

/** What a node puts in `status.SuccessValue`: the method's JSON return value, base64-encoded. */
const ret = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

/** A FinalExecutionOutcome shaped like the RPC's, with the given top-level status. */
function outcome(status: unknown, hash: string | null = HASH) {
  return {
    status,
    transaction: hash === null ? {} : { hash, signer_id: "owner.near", receiver_id: "x.near" },
    transaction_outcome: { id: hash, outcome: { status: { SuccessReceiptId: "r1" } } },
    receipts_outcome: [{ id: "r1", outcome: { status: { SuccessValue: "" } } }],
  };
}

const success = (value: unknown, method?: string) =>
  parseTxOutcome(outcome({ SuccessValue: ret(value) }), method);

describe("parseTxOutcome (Review Focus #1)", () => {
  it("reports success with the tx hash", () => {
    expect(
      parseTxOutcome({
        status: { SuccessValue: "" },
        transaction: { hash: HASH },
        receipts_outcome: [],
      }),
    ).toEqual({
      status: "ok",
      txHash: HASH,
      code: null,
      error: null,
    });
  });

  it("reports a contract refusal with its PROBARION code even though the wallet call resolved", () => {
    const failed = {
      status: {
        Failure: {
          ActionError: {
            index: 0,
            kind: {
              FunctionCallError: { ExecutionError: "Smart contract panicked: PROBARION:NotOwner" },
            },
          },
        },
      },
      transaction_outcome: { id: HASH },
      receipts_outcome: [],
    };
    const r = parseTxOutcome(failed);
    expect(r.status).toBe("failed");
    expect(r.code).toBe("NotOwner");
    expect(r.txHash).toBe(HASH);
  });

  it("treats a missing outcome as unknown, never as success", () => {
    expect(parseTxOutcome(undefined).status).toBe("unknown");
    expect(parseTxOutcome(null).status).toBe("unknown");
    expect(parseTxOutcome("ok").status).toBe("unknown");
    expect(parseTxOutcome([outcome({ SuccessValue: "" })]).status).toBe("unknown");
  });

  it("maps wallet rejections and thrown contract panics", () => {
    expect(parseWalletError(new Error("User rejected the request"))).toMatchObject({
      status: "failed",
      code: null,
    });
    expect(parseWalletError(new Error("Smart contract panicked: PROBARION:Frozen"))).toMatchObject({
      status: "failed",
      code: "Frozen",
    });
  });
});

describe("parseTxOutcome: the shapes a wallet can hand back", () => {
  it("never reads success from anything but a SuccessValue string", () => {
    for (const status of [
      undefined,
      null,
      "NotStarted",
      "Started",
      {},
      { SuccessValue: 5 },
      { SuccessValue: null },
      { Other: "" },
    ]) {
      expect(parseTxOutcome(outcome(status)).status, JSON.stringify(status)).toBe("unknown");
    }
  });

  it("a SuccessReceiptId is not a final result: confirm on the explorer", () => {
    const r = parseTxOutcome(outcome({ SuccessReceiptId: "abc" }), "withdraw");
    expect(r.status).toBe("unknown");
    expect(r.txHash).toBe(HASH);
    expect(r.error).toMatch(/explorer/i);
  });

  it("a basic Failure status is a failure", () => {
    expect(parseTxOutcome(outcome("Failure"))).toMatchObject({ status: "failed", txHash: HASH });
  });

  it("takes the hash from transaction.hash, else transaction_outcome.id", () => {
    expect(
      parseTxOutcome({ status: { SuccessValue: "" }, transaction: { hash: "h1" } }).txHash,
    ).toBe("h1");
    expect(
      parseTxOutcome({ status: { SuccessValue: "" }, transaction_outcome: { id: "h2" } }).txHash,
    ).toBe("h2");
    expect(parseTxOutcome({ status: { SuccessValue: "" } }).txHash).toBeNull();
    expect(
      parseTxOutcome({
        status: { SuccessValue: "" },
        transaction: { hash: "" },
        transaction_outcome: { id: 5 },
      }).txHash,
    ).toBeNull();
    // both present and different: the transaction's own hash wins
    expect(
      parseTxOutcome({
        status: { SuccessValue: "" },
        transaction: { hash: "h1" },
        transaction_outcome: { id: "h2" },
      }).txHash,
    ).toBe("h1");
  });

  it("does not build an explorer link from something that cannot be a hash", () => {
    const long = "x".repeat(200);
    expect(
      parseTxOutcome({ status: { SuccessValue: "" }, transaction: { hash: long } }).txHash,
    ).toBeNull();
    expect(parseWalletError(Object.assign(new Error("e"), { txHash: long })).txHash).toBeNull();
  });

  it("a method named like an Object.prototype key is not a reader", () => {
    for (const method of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(parseTxOutcome(outcome({ SuccessValue: "" }), method).status, method).toBe("ok");
    }
  });

  it("keeps an unknown PROBARION code out of `code` but the text in `error`", () => {
    const r = parseTxOutcome(
      outcome({
        Failure: {
          ActionError: { kind: { FunctionCallError: { ExecutionError: "PROBARION:Mystery" } } },
        },
      }),
    );
    expect(r.status).toBe("failed");
    expect(r.code).toBeNull();
    expect(r.error).toContain("PROBARION:Mystery");
  });

  it("reads the code only from the failure, never from receipt logs", () => {
    const o = outcome({ Failure: { ActionError: { kind: "Other" } } });
    o.receipts_outcome = [
      { id: "r1", outcome: { logs: ["PROBARION:NotOwner"], status: { SuccessValue: "" } } },
    ] as never;
    expect(parseTxOutcome(o).code).toBeNull();
  });

  it("truncates a long failure text", () => {
    const r = parseTxOutcome(outcome({ Failure: { text: "x".repeat(5000) } }));
    expect(r.error?.length).toBeLessThanOrEqual(500);
  });

  it("does not throw on a cyclic or bigint failure", () => {
    const cyc: Record<string, unknown> = { n: 1n };
    cyc.self = cyc;
    expect(parseTxOutcome(outcome({ Failure: cyc })).status).toBe("failed");
  });
});

describe("R12: a successful wallet outcome is not a successful action", () => {
  describe("create_vault (contracts/factory/src/lib.rs: on_vault_created -> Option<AccountId>)", () => {
    it("returns the vault account on success", () => {
      expect(success("acme.vaults.probarion.near", "create_vault")).toEqual({
        status: "ok",
        txHash: HASH,
        code: null,
        error: null,
      });
    });

    it("null means the batch rolled back and the deposit was refunded: refused", () => {
      expect(success(null, "create_vault")).toEqual({
        status: "failed",
        txHash: HASH,
        code: null,
        error: "name taken or deposit too low, refunded",
      });
    });

    it("an empty, numeric or non-string result is not a created vault", () => {
      expect(parseTxOutcome(outcome({ SuccessValue: "" }), "create_vault").status).toBe("unknown");
      expect(success(7, "create_vault").status).toBe("unknown");
      expect(success({}, "create_vault").status).toBe("unknown");
      expect(success("", "create_vault").status).toBe("unknown");
    });

    it("a PROBARION:InsufficientDeposit panic is still a refusal with its code", () => {
      const r = parseTxOutcome(
        outcome({
          Failure: {
            ActionError: {
              index: 0,
              kind: {
                FunctionCallError: {
                  ExecutionError: "Smart contract panicked: PROBARION:InsufficientDeposit",
                },
              },
            },
          },
        }),
        "create_vault",
      );
      expect(r).toMatchObject({ status: "failed", code: "InsufficientDeposit" });
    });
  });

  describe("approve (contracts/vault/src/held.rs: PromiseOrValue<SpendResult>)", () => {
    const spend = (status: string) => ({ spend_id: 4, status });

    it("paid and burned are ok", () => {
      expect(success(spend("paid"), "approve")).toEqual({
        status: "ok",
        txHash: HASH,
        code: null,
        error: null,
      });
      expect(success(spend("burned"), "approve")).toEqual({
        status: "ok",
        txHash: HASH,
        code: null,
        error: null,
      });
    });

    it("failed means the payout failed and the reservation was released: refused", () => {
      expect(success(spend("failed"), "approve")).toEqual({
        status: "failed",
        txHash: HASH,
        code: null,
        error: "payout failed, reservation released",
      });
    });

    it("any other status is not a confirmed payout", () => {
      for (const s of ["held", "pending", "rejected", "expired", "PAID", ""]) {
        expect(success(spend(s), "approve").status, s).toBe("unknown");
      }
      expect(success({ spend_id: 4 }, "approve").status).toBe("unknown");
      expect(success(null, "approve").status).toBe("unknown");
      expect(success("paid", "approve").status).toBe("unknown");
      expect(parseTxOutcome(outcome({ SuccessValue: "" }), "approve").status).toBe("unknown");
    });
  });

  describe("withdraw_intents (intents ft_withdraw -> U128, 0 when nothing left Intents)", () => {
    it("a positive amount is ok", () => {
      expect(success("5000000", "withdraw_intents").status).toBe("ok");
    });

    it('"0" means the withdrawal was refunded inside Intents: refused', () => {
      const r = success("0", "withdraw_intents");
      expect(r.status).toBe("failed");
      expect(r.error).toMatch(/nothing was withdrawn/i);
    });

    it("anything else is not a confirmed withdrawal", () => {
      expect(success(5, "withdraw_intents").status).toBe("unknown");
      expect(success("x", "withdraw_intents").status).toBe("unknown");
      expect(success(null, "withdraw_intents").status).toBe("unknown");
      expect(parseTxOutcome(outcome({ SuccessValue: "" }), "withdraw_intents").status).toBe(
        "unknown",
      );
    });
  });

  describe("create_mandate (returns the new mandate id)", () => {
    it("a positive id is ok", () => {
      expect(success(3, "create_mandate").status).toBe("ok");
    });
    it("no id is not a created mandate", () => {
      expect(success(0, "create_mandate").status).toBe("unknown");
      expect(success("3", "create_mandate").status).toBe("unknown");
      expect(parseTxOutcome(outcome({ SuccessValue: "" }), "create_mandate").status).toBe(
        "unknown",
      );
    });
  });

  describe("methods that return nothing", () => {
    it.each([
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
    ])("%s is ok on an empty SuccessValue", (method) => {
      expect(parseTxOutcome(outcome({ SuccessValue: "" }), method)).toEqual({
        status: "ok",
        txHash: HASH,
        code: null,
        error: null,
      });
    });
  });

  it("an undecodable SuccessValue on a method that must return something is unknown", () => {
    for (const method of ["create_vault", "approve", "withdraw_intents", "create_mandate"]) {
      expect(
        parseTxOutcome(outcome({ SuccessValue: "***not base64***" }), method).status,
        method,
      ).toBe("unknown");
      expect(
        parseTxOutcome(
          outcome({ SuccessValue: Buffer.from("not json").toString("base64") }),
          method,
        ).status,
        method,
      ).toBe("unknown");
    }
  });

  it("decodes UTF-8 and ignores the method for a method it does not know", () => {
    expect(success({ any: "thing é" }, "some_other_method").status).toBe("ok");
    expect(success(null).status).toBe("ok");
  });
});

describe("the unknown outcome: never retry (the SDK's TxOutcomeUnknownError rule)", () => {
  const timeouts = [
    "Exceeded 60 seconds waiting for the transaction to complete",
    "TIMEOUT_ERROR: the request timed out",
    "Timeout while waiting for the transaction",
    "Failed to fetch",
    "fetch failed",
    "NetworkError when attempting to fetch resource",
    "socket hang up",
    "read ECONNRESET",
    "connect ETIMEDOUT 1.2.3.4:443",
  ];

  it.each(timeouts)(
    "a wallet error that may be a timeout after broadcast is unknown: %s",
    (message) => {
      const r = parseWalletError(new Error(message));
      expect(r.status).toBe("unknown");
      expect(r.error).toContain(message);
    },
  );

  it("a wallet error that carries a tx hash is unknown, not failed", () => {
    const withProps = (props: Record<string, unknown>) =>
      Object.assign(new Error("Something went wrong"), props);
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
      const r = parseWalletError(e);
      expect(r.status, JSON.stringify(e)).toBe("unknown");
      expect(r.txHash, JSON.stringify(e)).toBe(HASH);
    }
  });

  it("takes a hash named in the message too, but only next to a transaction keyword", () => {
    expect(parseWalletError(new Error(`Transaction ${HASH} failed to complete`))).toMatchObject({
      status: "unknown",
      txHash: HASH,
    });
    expect(parseWalletError(new Error(`see https://nearblocks.io/txns/${HASH}`))).toMatchObject({
      status: "unknown",
      txHash: HASH,
    });
    expect(parseWalletError(new Error(`tx hash: ${HASH}`))).toMatchObject({
      status: "unknown",
      txHash: HASH,
    });
    // a public key in the message is not a transaction hash
    const key = "ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M";
    expect(parseWalletError(new Error(`bad key ${key}`))).toMatchObject({
      status: "failed",
      txHash: null,
    });
  });

  it("keeps the PROBARION code of a wallet error that also has a hash, but stays unknown", () => {
    const e = Object.assign(new Error("Smart contract panicked: PROBARION:NotOwner"), {
      txHash: HASH,
    });
    expect(parseWalletError(e)).toMatchObject({
      status: "unknown",
      txHash: HASH,
      code: "NotOwner",
    });
  });

  it("finds the PROBARION code a wallet wrapped as the cause of its own error", () => {
    const wrapped = new Error("Transaction failed", {
      cause: new Error("Smart contract panicked: PROBARION:HoldExpired"),
    });
    expect(parseWalletError(wrapped)).toMatchObject({ status: "failed", code: "HoldExpired" });
    expect(
      parseWalletError({ message: "failed", cause: { message: "PROBARION:Frozen" } }),
    ).toMatchObject({
      code: "Frozen",
    });
  });

  it("a plain rejection with no hash is a definite failure", () => {
    for (const message of [
      "User rejected the request",
      "User closed the window",
      "Wallet is still loading",
      "No accounts found",
    ]) {
      expect(parseWalletError(new Error(message)), message).toMatchObject({
        status: "failed",
        txHash: null,
      });
    }
  });

  it("copes with a string, a plain object and junk as the thrown value", () => {
    expect(parseWalletError("User rejected")).toMatchObject({
      status: "failed",
      error: "User rejected",
    });
    expect(parseWalletError({ message: "PROBARION:Frozen" })).toMatchObject({
      status: "failed",
      code: "Frozen",
    });
    expect(parseWalletError(undefined).status).toBe("failed");
    expect(parseWalletError(null).status).toBe("failed");
    expect(parseWalletError(42).status).toBe("failed");
    // an empty message still tells the owner something
    expect(parseWalletError(undefined).error).toMatch(/no message/);
    expect(parseWalletError(new Error("")).error).toMatch(/no message/);
    expect(parseWalletError("   ").error).toMatch(/no message/);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(parseWalletError(cyc).status).toBe("failed");
    const deep = { cause: undefined as unknown };
    deep.cause = deep;
    expect(parseWalletError(Object.assign(new Error("x"), deep)).status).toBe("failed");
  });

  it("truncates a long error", () => {
    expect(parseWalletError(new Error("y".repeat(5000))).error?.length).toBeLessThanOrEqual(500);
  });

  it("an error raised before anything was sent (no wallet) is a definite failure, even if it says timeout", () => {
    const r = parseConnectError(new Error("Failed to fetch the wallet manifest (timeout)"));
    expect(r).toMatchObject({ status: "failed", txHash: null, code: null });
    expect(r.error).toContain("timeout");
    expect(parseConnectError(undefined).status).toBe("failed");
  });

  describe("settleSend signs exactly once and never throws", () => {
    it("calls the wallet once when it resolves with an outcome", async () => {
      let calls = 0;
      const r = await settleSend(async () => {
        calls++;
        return outcome({ SuccessValue: "" });
      }, "freeze");
      expect(calls).toBe(1);
      expect(r.status).toBe("ok");
    });

    it("calls the wallet once when it throws a timeout, and the result is unknown", async () => {
      let calls = 0;
      const r = await settleSend(async () => {
        calls++;
        throw new Error("Exceeded 60 seconds waiting for the transaction to complete");
      }, "withdraw");
      expect(calls).toBe(1);
      expect(r.status).toBe("unknown");
    });

    it("calls the wallet once when it throws with a hash, and the result is unknown", async () => {
      let calls = 0;
      const r = await settleSend(async () => {
        calls++;
        throw Object.assign(new Error("nope"), { txHash: HASH });
      }, "approve");
      expect(calls).toBe(1);
      expect(r).toMatchObject({ status: "unknown", txHash: HASH });
    });

    it("calls the wallet once when it resolves with nothing, and the result is unknown", async () => {
      let calls = 0;
      const r = await settleSend(async () => {
        calls++;
        return undefined;
      }, "approve");
      expect(calls).toBe(1);
      expect(r.status).toBe("unknown");
    });

    it("calls the wallet once on a user rejection, and the result is failed", async () => {
      let calls = 0;
      const r = await settleSend(async () => {
        calls++;
        throw new Error("User rejected the request");
      });
      expect(calls).toBe(1);
      expect(r).toMatchObject({ status: "failed", txHash: null });
    });

    it("a synchronous throw is still a result", async () => {
      const r = await settleSend(() => {
        throw new Error("PROBARION:RequiresOneYocto");
      });
      expect(r).toMatchObject({ status: "failed", code: "RequiresOneYocto" });
    });

    it("maps the method's SuccessValue (R12 holds through settleSend)", async () => {
      const r = await settleSend(
        async () => outcome({ SuccessValue: ret({ spend_id: 1, status: "failed" }) }),
        "approve",
      );
      expect(r).toMatchObject({ status: "failed", error: "payout failed, reservation released" });
    });
  });

  it("an unknown result locks the button until the owner has checked the explorer", () => {
    const base = { txHash: HASH, code: null, error: null };
    expect(sendLocked({ status: "unknown", ...base })).toBe(true);
    expect(sendLocked({ status: "ok", ...base })).toBe(false);
    expect(sendLocked({ status: "failed", ...base })).toBe(false);
    expect(sendLocked(null)).toBe(false);
  });
});

describe("describeTxResult: what the owner reads", () => {
  const r = (over: Partial<TxResult>): TxResult => ({
    status: "ok",
    txHash: HASH,
    code: null,
    error: null,
    ...over,
  });

  it("unknown says sent and to confirm on the explorer, never failed or try again", () => {
    for (const result of [
      r({ status: "unknown", error: "The wallet returned no outcome; confirm on the explorer." }),
      r({ status: "unknown", txHash: null, error: "Exceeded 60 seconds" }),
      parseWalletError(new Error("TIMEOUT_ERROR")),
      parseTxOutcome(undefined),
      parseTxOutcome(outcome({ SuccessReceiptId: "x" })),
    ]) {
      const v = describeTxResult(result);
      expect(v.tone).toBe("warn");
      expect(v.headline).toBe("Sent: confirm on the explorer");
      expect(`${v.headline} ${v.detail ?? ""}`).not.toMatch(/try again|retry|failed|refused/i);
    }
  });

  it("unknown points at the transaction when it has a hash, else at the signer's account", () => {
    expect(describeTxResult(r({ status: "unknown" })).explorer).toBe("tx");
    expect(describeTxResult(r({ status: "unknown", txHash: null })).explorer).toBe("account");
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

  it("failed is Refused with the code, the reason, and the link when there is a transaction", () => {
    expect(describeTxResult(r({ status: "failed", code: "NotOwner", error: "panic" }))).toEqual({
      tone: "bad",
      headline: "Refused: NotOwner",
      detail: "panic",
      explorer: "tx",
    });
    expect(describeTxResult(r({ status: "failed", txHash: null, error: "User rejected" }))).toEqual(
      {
        tone: "bad",
        headline: "Refused",
        detail: "User rejected",
        explorer: null,
      },
    );
  });

  it("failed never invites a blind retry either", () => {
    const v = describeTxResult(
      parseTxOutcome(outcome({ SuccessValue: ret(null) }), "create_vault"),
    );
    expect(v.headline).toBe("Refused");
    expect(v.detail).toBe("name taken or deposit too low, refunded");
    expect(`${v.headline} ${v.detail}`).not.toMatch(/try again|retry/i);
  });
});
