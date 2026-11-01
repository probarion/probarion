import { inspect } from "node:util";
import { generateKeyPair, publicKeyFromSecret } from "@probarion/core";
import { PublicKey, TypedError } from "near-api-js";
import {
  AccessKeyNotEnoughAllowanceActionError,
  AccessKeyNotFoundActionError,
  InvalidNonceError,
  InvalidSignatureError,
  LackBalanceForStateActionError,
  NotEnoughBalanceError,
  ShardCongestedError,
  TransactionExecutionError,
  TransactionTimeoutError,
  UnknownTransactionError,
} from "near-api-js/rpc-errors";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  ProbarionError,
  TxOutcomeUnknownError,
  TxRejectedError,
} from "../src/errors.js";
import {
  type FunctionCallTx,
  NearApiJsSender,
  OUT_OF_GAS_NEAR_DETAIL,
  OUT_OF_NEAR_DETAIL,
} from "../src/tx.js";
import {
  type FakeProviderOptions,
  fakeProvider,
  txDigest,
  txHashOf,
} from "./helpers/fake-provider.js";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

// Throwaway keys for tests only, derived from fixed seeds. They hold nothing anywhere.
const VAULT = "acme.vaults.probarion.testnet";
const agentKey = generateKeyPair(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const ledgerKey = generateKeyPair(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));

const SECRET_URL = "https://rpc.test/v1/SECRET-API-KEY?token=abc";

const spendTx: FunctionCallTx = {
  receiverId: VAULT,
  methodName: "spend",
  args: { request: { mandate_id: 1 } },
  gas: 200_000_000_000_000n,
  deposit: 0n,
};
const anchorTx: FunctionCallTx = { ...spendTx, methodName: "anchor", args: { seq: 1 } };

function senderWith(
  options: FakeProviderOptions = {},
  extra: { key?: typeof agentKey; sendTimeoutMs?: number } = {},
) {
  const fake = fakeProvider(options);
  const urls: string[] = [];
  const sender = new NearApiJsSender({
    accountId: VAULT,
    secretKey: (extra.key ?? agentKey).secretKey,
    rpcUrl: () => "https://rpc.test/key-in-path",
    createProvider: (url) => {
      urls.push(url);
      return fake.provider;
    },
    ...(extra.sendTimeoutMs === undefined ? {} : { sendTimeoutMs: extra.sendTimeoutMs }),
  });
  return { sender, urls, ...fake };
}

const caught = (promise: Promise<unknown>) => promise.catch((e: unknown) => e);

describe("NearApiJsSender: a signed, sent call", () => {
  it("signs for the vault account with the function-call key and waits for FINAL", async () => {
    const { sender, sent, urls } = senderWith({
      send: () => ({
        status: { SuccessValue: b64({ spend_id: 1, status: "paid" }) },
        transaction: { hash: "SentHash" },
      }),
    });
    expect(sender.accountId).toBe(VAULT);
    expect(sender.publicKey).toBe(agentKey.publicKey);
    expect(sender.publicKey).toBe(publicKeyFromSecret(agentKey.secretKey));

    const out = await sender.functionCall(spendTx);

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
    // The signature is the agent key's over the transaction digest.
    const digest = new Uint8Array(txDigest(first.signed));
    expect(tx.publicKey.verify(digest, first.signed.signature.data)).toBe(true);
  });

  it("falls back to the hash it computed before sending when the answer has none", async () => {
    const { sender, sent } = senderWith({ send: () => ({ status: { SuccessValue: "" } }) });
    const out = await sender.functionCall(spendTx);
    expect(out.ok).toBe(true);
    const signed = sent[0]?.signed;
    if (signed === undefined) throw new Error("nothing sent");
    expect(out.txHash).toBe(txHashOf(signed));
  });

  it("signs with the key it was given, not another one", async () => {
    const { sender, sent } = senderWith({}, { key: ledgerKey });
    expect(sender.publicKey).toBe(ledgerKey.publicKey);
    await sender.functionCall(anchorTx);
    expect(sent[0]?.signed.transaction.publicKey.toString()).toBe(ledgerKey.publicKey);
  });

  it("returns a contract panic as an outcome with its code", async () => {
    const { sender } = senderWith({
      send: () => ({
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
    const out = await sender.functionCall(spendTx);
    expect(out).toMatchObject({ ok: false, code: "DuplicateInvoice", txHash: "PanicHash" });
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
    await sender.functionCall(spendTx);
    await sender.functionCall(spendTx);
    expect(urls).toEqual(["https://rpc1.test", "https://rpc2.test"]);
  });
});

describe("NearApiJsSender: the vault is out of NEAR (an outcome, R15)", () => {
  const hash = "11111111111111111111111111111111";
  const outOfNear = async (error: unknown) => {
    const { sender, sent } = senderWith({
      send: () => {
        throw error;
      },
    });
    const out = await sender.functionCall(spendTx);
    expect(sent).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, value: null, txHash: null });
    return out;
  };

  it("LackBalanceForState becomes the storage out-of-NEAR outcome", async () => {
    const out = await outOfNear(
      new LackBalanceForStateActionError(VAULT, 4_800_000_000_000_000_000_000n, null, "", ""),
    );
    expect(out).toMatchObject({ code: "LackBalanceForState", failure: OUT_OF_NEAR_DETAIL });
  });

  it("NotEnoughBalance becomes the gas out-of-NEAR outcome, with its own text", async () => {
    const out = await outOfNear(
      new NotEnoughBalanceError(1n, 20_000_000_000_000_000_000_000n, VAULT, hash, hash),
    );
    expect(out).toMatchObject({ code: "NotEnoughBalance", failure: OUT_OF_GAS_NEAR_DETAIL });
  });
});

describe("NearApiJsSender: the node refuses the transaction (definite, not unknown)", () => {
  const hash = "11111111111111111111111111111111";
  /** The error `sender.functionCall` throws for a node refusal, after exactly `sends` sends. */
  const refusal = async (error: unknown, tx: FunctionCallTx = spendTx, sends = 1) => {
    const { sender, sent } = senderWith({
      send: () => {
        throw error;
      },
    });
    const thrown = await caught(sender.functionCall(tx));
    expect(thrown).toBeInstanceOf(TxRejectedError);
    expect(thrown).toBeInstanceOf(ProbarionError);
    expect(thrown).not.toBeInstanceOf(TxOutcomeUnknownError);
    expect(sent).toHaveLength(sends);
    const rejected = thrown as TxRejectedError;
    expect(rejected.code).toBe("TxRejected");
    return rejected;
  };

  it("NotEnoughAllowance says the agent key's allowance is used up and the owner must re-add it", async () => {
    const rejected = await refusal(
      new AccessKeyNotEnoughAllowanceActionError(
        VAULT,
        10n,
        20n,
        PublicKey.from(agentKey.publicKey),
        null,
        hash,
        hash,
      ),
    );
    expect(rejected.kind).toBe("NotEnoughAllowance");
    expect(rejected.message).toContain("agent key's allowance is used up");
    expect(rejected.message).toContain("owner must re-add the key with a new allowance");
    expect(rejected.message).toContain("add_agent");
    expect(rejected.message).toContain("nothing changed");
  });

  it("NotEnoughAllowance on anchor names the ledger key", async () => {
    const rejected = await refusal(
      new AccessKeyNotEnoughAllowanceActionError(
        VAULT,
        10n,
        20n,
        PublicKey.from(ledgerKey.publicKey),
        null,
        hash,
        hash,
      ),
      anchorTx,
    );
    expect(rejected.kind).toBe("NotEnoughAllowance");
    expect(rejected.message).toContain("ledger key's allowance is used up");
    expect(rejected.message).toContain("set_ledger_key");
  });

  it("AccessKeyNotFound says the key is not on the vault", async () => {
    const rejected = await refusal(
      new AccessKeyNotFoundActionError(VAULT, PublicKey.from(agentKey.publicKey), null, hash, hash),
    );
    expect(rejected.kind).toBe("AccessKeyNotFound");
    expect(rejected.message).toContain("not on the vault account");
  });

  it("InvalidSignature, a congested shard and the base execution error are refusals too", async () => {
    expect((await refusal(new InvalidSignatureError(hash, hash))).kind).toBe("InvalidSignature");
    expect((await refusal(new ShardCongestedError(1, 0, hash, hash))).kind).toBe("ShardCongested");
    const base = new TransactionExecutionError("Unknown invalid transaction error", hash, hash);
    expect((await refusal(base)).kind).toBe("TransactionExecution");
  });

  it("keeps a redacted copy of the node's error as the cause", async () => {
    const error = new TransactionExecutionError(`refused by ${SECRET_URL}`, hash, hash);
    const rejected = await refusal(error);
    expect(rejected.cause).not.toBe(error);
    expect(inspect(rejected, { depth: 10 })).not.toContain("SECRET-API-KEY");
  });

  it("InvalidNonce: signs again with a fresh nonce and sends the new transaction", async () => {
    const { sender, sent } = senderWith({
      send: (_signed, call) => {
        if (call === 1) throw new InvalidNonceError(9, 8, "", "");
        return { status: { SuccessValue: "" } };
      },
    });
    const out = await sender.functionCall(spendTx);
    expect(out.ok).toBe(true);
    expect(sent).toHaveLength(2);
    const [first, second] = sent;
    if (first === undefined || second === undefined) throw new Error("expected two sends");
    expect(first.signed.transaction.nonce).toBe(8n);
    expect(second.signed.transaction.nonce).toBe(9n);
    expect(txHashOf(first.signed)).not.toBe(txHashOf(second.signed));
  });

  it("InvalidNonce after ten fresh signatures is a refusal, not an unknown outcome", async () => {
    const rejected = await refusal(new InvalidNonceError(9, 8, "", ""), spendTx, 11);
    expect(rejected.kind).toBe("InvalidNonce");
  });
});

describe("NearApiJsSender: the outcome is unknown after the send", () => {
  const causes: [string, () => unknown][] = [
    [
      "fetch failed (ECONNRESET)",
      () => Object.assign(new TypeError("fetch failed"), { cause: new Error("read ECONNRESET") }),
    ],
    [
      "a ProviderError from a 502",
      () => {
        class ProviderError extends Error {
          override name = "ProviderError";
        }
        return new ProviderError(`${SECRET_URL} Bad Gateway`);
      },
    ],
    ["the node's TIMEOUT_ERROR", () => new TransactionTimeoutError()],
    [
      "retries exhausted",
      () => new TypedError(`Exceeded 12 attempts for ${SECRET_URL}.`, "RetriesExceeded"),
    ],
    ["an unknown transaction", () => new UnknownTransactionError("somehash")],
    ["a non-error throw", () => "boom"],
  ];

  it.each(causes)(
    "%s gives TxOutcomeUnknown with the hash of the signed transaction",
    async (_name, make) => {
      const { sender, sent } = senderWith({
        send: () => {
          throw make();
        },
      });
      const error = await caught(sender.functionCall(spendTx));
      expect(error).toBeInstanceOf(TxOutcomeUnknownError);
      expect(error).toBeInstanceOf(ProbarionError);
      const unknown = error as TxOutcomeUnknownError;
      expect(unknown.code).toBe("TxOutcomeUnknown");
      expect(unknown.signerId).toBe(VAULT);
      expect(sent).toHaveLength(1);
      const signed = sent[0]?.signed;
      if (signed === undefined) throw new Error("nothing sent");
      expect(unknown.txHash).toBe(txHashOf(signed));
      expect(unknown.message).toContain(unknown.txHash);
      expect(unknown.message).toContain("Do not send it again");
      expect(unknown.message).not.toContain("SECRET-API-KEY");
      // The cause is kept for debugging, as a copy with URLs cut to their origin.
      expect(inspect(unknown, { depth: 10 })).not.toContain("SECRET-API-KEY");
    },
  );

  it("the deadline gives TxOutcomeUnknown with the hash", async () => {
    const { sender, sent } = senderWith(
      { send: () => new Promise<never>(() => {}) },
      { sendTimeoutMs: 25 },
    );
    const error = await caught(sender.functionCall(spendTx));
    expect(error).toBeInstanceOf(TxOutcomeUnknownError);
    const signed = sent[0]?.signed;
    if (signed === undefined) throw new Error("nothing sent");
    expect((error as TxOutcomeUnknownError).txHash).toBe(txHashOf(signed));
    expect((error as TxOutcomeUnknownError).message).toContain("timed out after 25 ms");
  });

  it("an answer that is not final yet is unknown, never a result", async () => {
    const answers = [{ status: "Started" }, { status: { SuccessReceiptId: "r" } }, null, "x"];
    for (const answer of answers) {
      const { sender } = senderWith({ send: () => answer });
      const error = await caught(sender.functionCall(spendTx));
      expect(error).toBeInstanceOf(TxOutcomeUnknownError);
    }
  });
});

describe("NearApiJsSender: nothing was sent", () => {
  it("a viewAccessKey failure is TxSendFailed, with the cause redacted", async () => {
    const cause = new Error(`fetch failed for ${SECRET_URL} (ECONNRESET)`);
    const { sender, sent } = senderWith({ accessKeyFails: cause });
    const error = await caught(sender.functionCall(spendTx));
    expect(error).toBeInstanceOf(ProbarionError);
    expect(error).not.toBeInstanceOf(TxOutcomeUnknownError);
    const failure = error as ProbarionError;
    expect(failure.code).toBe("TxSendFailed");
    expect(failure.message).toContain("spend");
    expect(failure.message).toContain("nothing was sent");
    expect(failure.message).toContain("https://rpc.test");
    expect(failure.message).not.toContain("SECRET-API-KEY");
    expect(sent).toHaveLength(0);
    // Not the raw error but a copy of it with the URL cut to its origin.
    expect(failure.cause).not.toBe(cause);
    expect((failure.cause as Error).message).toBe("fetch failed for https://rpc.test (ECONNRESET)");
    expect(inspect(failure, { depth: 10 })).not.toContain("SECRET-API-KEY");
    expect(inspect(failure, { depth: 10 })).not.toContain("token=abc");
  });

  it("a stuck signing step is TxSendFailed after the deadline", async () => {
    const { sender, sent } = senderWith({ blockHangs: true }, { sendTimeoutMs: 25 });
    const error = await caught(sender.functionCall(spendTx));
    expect((error as ProbarionError).code).toBe("TxSendFailed");
    expect((error as ProbarionError).message).toContain("timed out after 25 ms");
    expect(sent).toHaveLength(0);
  });

  it("uses near-api-js's JsonRpcProvider on the given URL by default", async () => {
    // No createProvider: the default provider's first request (the access key query) goes through
    // global fetch, which the R20 guard refuses. Nothing was sent, so it is TxSendFailed.
    const sender = new NearApiJsSender({
      accountId: VAULT,
      secretKey: agentKey.secretKey,
      rpcUrl: "https://default-provider.test/key-in-path",
    });
    const error = await caught(sender.functionCall(spendTx));
    expect((error as ProbarionError).code).toBe("TxSendFailed");
    expect((error as ProbarionError).message).toContain("https://default-provider.test");
    expect((error as ProbarionError).message).not.toContain("key-in-path");
  });
});

describe("NearApiJsSender.lookup", () => {
  it("reads the final status of a transaction by hash and parses it", async () => {
    const { sender, statusCalls } = senderWith({
      status: () => ({
        status: { SuccessValue: b64({ spend_id: 1, status: "paid" }) },
        transaction: { hash: "LookedUp" },
      }),
    });
    const out = await sender.lookup("LookedUp");
    expect(out).toMatchObject({
      ok: true,
      txHash: "LookedUp",
      value: { spend_id: 1, status: "paid" },
    });
    expect(statusCalls).toEqual([{ txHash: "LookedUp", accountId: VAULT, waitUntil: "FINAL" }]);
  });

  it("maps a failed status like any outcome", async () => {
    const { sender } = senderWith({
      status: () => ({
        status: {
          Failure: {
            ActionError: {
              index: null,
              kind: { LackBalanceForState: { account_id: VAULT, amount: "1" } },
            },
          },
        },
      }),
    });
    expect(await sender.lookup("H")).toMatchObject({
      ok: false,
      txHash: "H",
      code: "LackBalanceForState",
    });
  });

  it("is TxOutcomeUnknown when the node cannot say, with the hash", async () => {
    const answers: (() => unknown)[] = [
      () => {
        throw new UnknownTransactionError("H");
      },
      () => ({ status: "Started" }),
      () => {
        throw new Error(`fetch failed ${SECRET_URL}`);
      },
    ];
    for (const status of answers) {
      const { sender } = senderWith({ status });
      const error = await caught(sender.lookup("H"));
      expect(error).toBeInstanceOf(TxOutcomeUnknownError);
      expect((error as TxOutcomeUnknownError).txHash).toBe("H");
      expect((error as TxOutcomeUnknownError).signerId).toBe(VAULT);
      expect(inspect(error, { depth: 10 })).not.toContain("SECRET-API-KEY");
    }
  });
});

describe("NearApiJsSender setup", () => {
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

  it("rejects a send timeout that is not a positive number", () => {
    for (const sendTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new NearApiJsSender({
            accountId: VAULT,
            secretKey: agentKey.secretKey,
            rpcUrl: "https://rpc.test",
            sendTimeoutMs,
          }),
      ).toThrow(ConfigError);
    }
  });

  it("keeps the secret key out of JSON and inspect output", () => {
    const { sender } = senderWith();
    const secretBody = agentKey.secretKey.slice("ed25519:".length);
    expect(JSON.stringify(sender)).not.toContain(secretBody);
    expect(inspect(sender, { depth: 6, showHidden: true })).not.toContain(secretBody);
  });
});
