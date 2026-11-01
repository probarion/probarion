import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { generateKeyPair, publicKeyFromSecret } from "@probarion/core";
import { baseEncode, encodeTransaction, type Provider, type SignedTransaction } from "near-api-js";
import { LackBalanceForStateActionError } from "near-api-js/rpc-errors";
import { describe, expect, it } from "vitest";
import { ConfigError, ProbarionError } from "../src/errors.js";
import { NearApiJsSender, OUT_OF_NEAR_DETAIL, parseTxOutcome } from "../src/tx.js";

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

// A throwaway key for tests only. It is derived from a fixed seed and holds nothing anywhere.
const VAULT = "acme.vaults.probarion.testnet";
const agentKey = generateKeyPair(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const ledgerKey = generateKeyPair(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));

interface FakeProviderOptions {
  respond?: (signed: SignedTransaction) => unknown;
  failWith?: unknown;
}

/** Just the three provider methods `Account.signAndSendTransaction` uses. No network. */
function fakeProvider(options: FakeProviderOptions = {}) {
  const sent: { signed: SignedTransaction; waitUntil: unknown }[] = [];
  const provider = {
    viewAccessKey: async () => ({
      nonce: 7n,
      permission: "FullAccess",
      block_hash: baseEncode(new Uint8Array(32).fill(2)),
      block_height: 99,
    }),
    viewBlock: async () => ({
      header: { hash: baseEncode(new Uint8Array(32).fill(3)), height: 100 },
    }),
    sendTransactionUntil: async (signed: SignedTransaction, waitUntil: unknown) => {
      sent.push({ signed, waitUntil });
      if (options.failWith !== undefined) throw options.failWith;
      return options.respond?.(signed) ?? { status: { SuccessValue: "" } };
    },
  } as unknown as Provider;
  return { provider, sent };
}

function senderWith(key = agentKey, options: FakeProviderOptions = {}) {
  const fake = fakeProvider(options);
  const urls: string[] = [];
  const sender = new NearApiJsSender({
    accountId: VAULT,
    secretKey: key.secretKey,
    rpcUrl: () => "https://rpc.test/key-in-path",
    createProvider: (url) => {
      urls.push(url);
      return fake.provider;
    },
  });
  return { sender, urls, ...fake };
}

describe("NearApiJsSender", () => {
  it("signs a function call for the vault account with the function-call key", async () => {
    const { sender, sent, urls } = senderWith(agentKey, {
      respond: () => ({
        status: { SuccessValue: b64({ spend_id: 1, status: "paid" }) },
        transaction: { hash: "SentHash" },
      }),
    });
    expect(sender.accountId).toBe(VAULT);
    expect(sender.publicKey).toBe(agentKey.publicKey);
    expect(sender.publicKey).toBe(publicKeyFromSecret(agentKey.secretKey));

    const out = await sender.functionCall({
      receiverId: VAULT,
      methodName: "spend",
      args: { request: { mandate_id: 1 } },
      gas: 200_000_000_000_000n,
      deposit: 0n,
    });

    expect(out).toMatchObject({
      ok: true,
      txHash: "SentHash",
      value: { spend_id: 1, status: "paid" },
    });
    expect(urls).toEqual(["https://rpc.test/key-in-path"]);
    expect(sent).toHaveLength(1);
    const first = sent[0];
    if (first === undefined) throw new Error("nothing sent");
    expect(first.waitUntil).toBe("FINAL");
    const tx = first.signed.transaction;
    expect(tx.signerId).toBe(VAULT);
    expect(tx.receiverId).toBe(VAULT);
    expect(tx.publicKey.toString()).toBe(agentKey.publicKey);
    expect(tx.nonce).toBe(8n);
    expect(tx.actions).toHaveLength(1);
    const call = tx.actions[0]?.functionCall;
    expect(call?.methodName).toBe("spend");
    expect(JSON.parse(Buffer.from(call?.args ?? []).toString("utf8"))).toEqual({
      request: { mandate_id: 1 },
    });
    expect(call?.gas).toBe(200_000_000_000_000n);
    expect(call?.deposit).toBe(0n);
    // The signature is the agent key's over the transaction hash.
    const digest = createHash("sha256").update(encodeTransaction(tx)).digest();
    expect(tx.publicKey.verify(new Uint8Array(digest), first.signed.signature.data)).toBe(true);
  });

  it("signs with the key it was given, not another one", async () => {
    const { sender, sent } = senderWith(ledgerKey);
    expect(sender.publicKey).toBe(ledgerKey.publicKey);
    await sender.functionCall({
      receiverId: VAULT,
      methodName: "anchor",
      args: { seq: 1, root: "ab".repeat(32), count: 3 },
      gas: 30_000_000_000_000n,
      deposit: 0n,
    });
    expect(sent[0]?.signed.transaction.publicKey.toString()).toBe(ledgerKey.publicKey);
  });

  it("returns a contract panic as an outcome with its code (throwOnFailure is off)", async () => {
    const { sender } = senderWith(agentKey, {
      respond: () => ({
        status: {
          Failure: {
            ActionError: {
              index: 0,
              kind: {
                FunctionCallError: {
                  ExecutionError: "Smart contract panicked: PROBARION:DuplicateInvoice",
                },
              },
            },
          },
        },
        transaction: { hash: "PanicHash" },
      }),
    });
    const out = await sender.functionCall({
      receiverId: VAULT,
      methodName: "spend",
      args: {},
      gas: 1n,
      deposit: 0n,
    });
    expect(out).toMatchObject({ ok: false, code: "DuplicateInvoice", txHash: "PanicHash" });
  });

  it("returns an out-of-NEAR outcome when the node rejects the tx for LackBalanceForState", async () => {
    // near-api-js throws this typed error for an INVALID_TRANSACTION answer.
    const thrown = new LackBalanceForStateActionError(
      VAULT,
      4_800_000_000_000_000_000_000n,
      null,
      "",
      "",
    );
    const { sender } = senderWith(agentKey, { failWith: thrown });
    const out = await sender.functionCall({
      receiverId: VAULT,
      methodName: "spend",
      args: {},
      gas: 1n,
      deposit: 0n,
    });
    expect(out).toMatchObject({
      ok: false,
      txHash: null,
      value: null,
      code: "LackBalanceForState",
      failure: OUT_OF_NEAR_DETAIL,
    });
  });

  it("throws TxSendFailed when the transaction cannot be sent, keeping the cause and hiding URLs", async () => {
    const cause = new Error("fetch failed for https://rpc.test/v1/SECRET-API-KEY?x=1 (ECONNRESET)");
    const { sender } = senderWith(agentKey, { failWith: cause });
    const error = await sender
      .functionCall({ receiverId: VAULT, methodName: "spend", args: {}, gas: 1n, deposit: 0n })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProbarionError);
    const failure = error as ProbarionError;
    expect(failure.code).toBe("TxSendFailed");
    expect(failure.message).toContain("spend");
    expect(failure.message).toContain("https://rpc.test");
    expect(failure.message).not.toContain("SECRET-API-KEY");
    expect(failure.cause).toBe(cause);
  });

  it("says a timed-out transaction may still land", async () => {
    class TransactionTimeoutError extends Error {
      override name = "TransactionTimeoutError";
    }
    const { sender } = senderWith(agentKey, {
      failWith: new TransactionTimeoutError("Transaction timed out"),
    });
    const error = await sender
      .functionCall({ receiverId: VAULT, methodName: "spend", args: {}, gas: 1n, deposit: 0n })
      .catch((e: unknown) => e);
    expect((error as ProbarionError).code).toBe("TxSendFailed");
    expect((error as ProbarionError).message).toContain("may still");
  });

  it("resolves the RPC URL on every call", async () => {
    const fake = fakeProvider();
    const urls: string[] = [];
    const endpoints = ["https://rpc1.test", "https://rpc2.test"];
    const sender = new NearApiJsSender({
      accountId: VAULT,
      secretKey: agentKey.secretKey,
      rpcUrl: () => endpoints[urls.length] ?? "https://rpc-extra.test",
      createProvider: (url) => {
        urls.push(url);
        return fake.provider;
      },
    });
    const tx = { receiverId: VAULT, methodName: "spend", args: {}, gas: 1n, deposit: 0n };
    await sender.functionCall(tx);
    await sender.functionCall(tx);
    expect(urls).toEqual(["https://rpc1.test", "https://rpc2.test"]);
  });

  it("rejects a malformed secret key with a ConfigError that does not echo it", () => {
    const bad = "ed25519:not-a-key";
    let thrown: unknown;
    try {
      new NearApiJsSender({ accountId: VAULT, secretKey: bad, rpcUrl: "https://rpc.test" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).not.toContain(bad);
  });

  it("uses near-api-js's JsonRpcProvider on the given URL by default", async () => {
    // No createProvider: the default provider's first request (the access key query) goes through
    // global fetch, which the R20 guard refuses. The refusal names the URL it was sent to.
    const sender = new NearApiJsSender({
      accountId: VAULT,
      secretKey: agentKey.secretKey,
      rpcUrl: "https://default-provider.test/key-in-path",
    });
    const error = await sender
      .functionCall({ receiverId: VAULT, methodName: "spend", args: {}, gas: 1n, deposit: 0n })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProbarionError);
    expect((error as ProbarionError).code).toBe("TxSendFailed");
    expect((error as ProbarionError).message).toContain("https://default-provider.test");
    expect((error as ProbarionError).message).not.toContain("key-in-path");
  });

  it("keeps the secret key out of JSON and inspect output", () => {
    const { sender } = senderWith(agentKey);
    const secretBody = agentKey.secretKey.slice("ed25519:".length);
    expect(JSON.stringify(sender)).not.toContain(secretBody);
    expect(inspect(sender, { depth: 6, showHidden: true })).not.toContain(secretBody);
  });
});
