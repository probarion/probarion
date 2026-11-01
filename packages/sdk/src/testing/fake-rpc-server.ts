// TEST DOUBLE: a NEAR JSON-RPC server on 127.0.0.1 backed by FakeChain. It decodes real near-api-js signed
// transactions and answers with the response shapes of a real node (view_account, tx, access keys), which the
// SDK's RpcClient validates strictly. It never listens on anything but loopback.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AccessKeyInfo,
  formatSignature,
  sha256Bytes,
  utf8,
  verifyEd25519,
} from "@probarion/core";
import { baseEncode, decodeSignedTransaction, encodeTransaction } from "near-api-js";
import { type FakeCallResult, type FakeChain, FakePanic, FakeRpcFault } from "./fake-chain.js";

export interface FakeRpcServer {
  readonly url: string;
  readonly chain: FakeChain;
  /** Every JSON-RPC method received, in order (including requests answered with an injected failure). */
  readonly methods: string[];
  /** The next requests are answered with these HTTP statuses instead of being served. */
  failNext(statuses: readonly number[]): void;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function toRpcPermission(info: AccessKeyInfo): unknown {
  if (info.permission === "FullAccess") return "FullAccess";
  return {
    FunctionCall: {
      allowance: info.permission.allowance,
      receiver_id: info.permission.receiver_id,
      method_names: info.permission.method_names,
    },
  };
}

function decodeJson(bytes: Uint8Array | number[] | string | undefined): Record<string, unknown> {
  const text =
    typeof bytes === "string"
      ? Buffer.from(bytes, "base64").toString("utf8")
      : Buffer.from(bytes ?? new Uint8Array()).toString("utf8");
  if (text === "") return {};
  const parsed: unknown = JSON.parse(text);
  return record(parsed);
}

function panicText(message: string): string {
  return `Smart contract panicked: ${message}`;
}

function query(chain: FakeChain, p: Record<string, unknown>): unknown {
  const accountId = String(p.account_id);
  const tail = { block_height: chain.height, block_hash: chain.blockHash };
  switch (p.request_type) {
    case "call_function": {
      try {
        const value = chain.view(
          accountId,
          String(p.method_name),
          decodeJson(typeof p.args_base64 === "string" ? p.args_base64 : ""),
        );
        return { result: [...Buffer.from(JSON.stringify(value ?? null))], logs: [], ...tail };
      } catch (error) {
        if (error instanceof FakePanic) {
          return {
            error: `wasm execution failed with error: FunctionCallError(ExecutionError("${panicText(error.message)}"))`,
            logs: [],
            ...tail,
          };
        }
        throw error;
      }
    }
    case "view_access_key_list": {
      if (!chain.knownAccount(accountId)) throw chain.unknownAccount(accountId);
      return {
        keys: chain.accessKeysOf(accountId).map((k) => ({
          public_key: k.info.public_key,
          access_key: { nonce: k.nonce, permission: toRpcPermission(k.info) },
        })),
        ...tail,
      };
    }
    case "view_access_key": {
      const key = chain.accessKey(accountId, String(p.public_key));
      if (key === undefined) {
        throw new FakeRpcFault(
          "HANDLER_ERROR",
          "UNKNOWN_ACCESS_KEY",
          `access key ${String(p.public_key)} does not exist while viewing`,
          undefined,
          {
            public_key: String(p.public_key),
            block_height: chain.height,
            block_hash: chain.blockHash,
          },
        );
      }
      return { nonce: key.nonce, permission: toRpcPermission(key.info), ...tail };
    }
    case "view_account":
      return { ...chain.accountView(accountId), ...tail };
    default:
      throw new FakeRpcFault(
        "HANDLER_ERROR",
        "UNSUPPORTED",
        `FAKE_UNSUPPORTED:query/${String(p.request_type)}`,
      );
  }
}

type Applied = { ok: true; result: FakeCallResult } | { ok: false; panic: string };

interface SentTx {
  hash: string;
  signerId: string;
  signerPk: string;
  receiverId: string;
  nonce: number;
  method: string;
  argsBase64: string;
  gas: number;
  deposit: string;
  signature: string;
}

const GAS_BURNT = 2_428_000_000_000;
const TOKENS_BURNT = "242800000000000000000";

function encodeValue(value: unknown): string {
  return value === undefined ? "" : Buffer.from(JSON.stringify(value)).toString("base64");
}

/** A 32-byte base58 id, deterministic per transaction and label, like a receipt id. */
function receiptId(hash: string, label: string): string {
  return baseEncode(sha256Bytes(utf8(`probarion/test-double/receipt/${hash}/${label}`)));
}

function buildOutcome(chain: FakeChain, tx: SentTx, applied: Applied): Record<string, unknown> {
  const outcomeOf = (
    id: string,
    executor: string,
    logs: string[],
    status: unknown,
    receiptIds: string[],
  ): Record<string, unknown> => ({
    id,
    block_hash: chain.blockHash,
    proof: [],
    outcome: {
      logs,
      receipt_ids: receiptIds,
      gas_burnt: GAS_BURNT,
      tokens_burnt: TOKENS_BURNT,
      executor_id: executor,
      status,
      metadata: { version: 3, gas_profile: [] },
    },
  });
  const unused = receiptId(tx.hash, "refund");
  const refund = (id: string, to: string) => outcomeOf(id, to, [], { SuccessValue: "" }, []);
  const first = receiptId(tx.hash, "vault");

  let finalStatus: Record<string, unknown>;
  const receiptsOutcome: Record<string, unknown>[] = [];
  if (!applied.ok) {
    finalStatus = {
      Failure: {
        ActionError: {
          index: 0,
          kind: { FunctionCallError: { ExecutionError: panicText(applied.panic) } },
        },
      },
    };
    receiptsOutcome.push(
      outcomeOf(first, tx.receiverId, [], finalStatus, [unused]),
      refund(unused, tx.signerId),
    );
  } else {
    const { result } = applied;
    finalStatus = { SuccessValue: encodeValue(result.value) };
    if (result.receipts.length === 0) {
      receiptsOutcome.push(
        outcomeOf(first, tx.receiverId, result.vaultLogs, finalStatus, [unused]),
        refund(unused, tx.signerId),
      );
    } else {
      // The layout of a real payout tx: the vault receipt returns a promise, so its status names the callback;
      // each payout receipt is followed by its own refund, then the callback and its refund, then the vault receipt's refund.
      const callback = result.receipts[result.receipts.length - 1];
      const payouts = result.receipts.slice(0, -1);
      const payoutIds = payouts.map((_, i) => receiptId(tx.hash, `payout-${i}`));
      const callbackId = receiptId(tx.hash, "callback");
      receiptsOutcome.push(
        outcomeOf(first, tx.receiverId, result.vaultLogs, { SuccessReceiptId: callbackId }, [
          ...payoutIds,
          callbackId,
          unused,
        ]),
      );
      payouts.forEach((r, i) => {
        const id = payoutIds[i] ?? "";
        const refundId = receiptId(tx.hash, `payout-${i}-refund`);
        const status =
          r.failure === undefined
            ? { SuccessValue: encodeValue(r.value) }
            : {
                Failure: {
                  ActionError: {
                    index: 0,
                    kind: { FunctionCallError: { ExecutionError: panicText(r.failure) } },
                  },
                },
              };
        receiptsOutcome.push(
          outcomeOf(id, r.executor, r.logs, status, [refundId]),
          refund(refundId, chain.vaultId),
        );
      });
      if (callback !== undefined) {
        const refundId = receiptId(tx.hash, "callback-refund");
        receiptsOutcome.push(
          outcomeOf(
            callbackId,
            callback.executor,
            callback.logs,
            { SuccessValue: encodeValue(callback.value) },
            [refundId],
          ),
          refund(refundId, tx.signerId),
        );
      }
      receiptsOutcome.push(refund(unused, tx.signerId));
    }
  }

  return {
    final_execution_status: "FINAL",
    status: finalStatus,
    transaction: {
      signer_id: tx.signerId,
      public_key: tx.signerPk,
      nonce: tx.nonce,
      receiver_id: tx.receiverId,
      actions: [
        {
          FunctionCall: {
            method_name: tx.method,
            args: tx.argsBase64,
            gas: tx.gas,
            deposit: tx.deposit,
          },
        },
      ],
      signature: tx.signature,
      hash: tx.hash,
      priority_fee: 0,
    },
    transaction_outcome: {
      id: tx.hash,
      block_hash: chain.blockHash,
      proof: [],
      outcome: {
        logs: [],
        receipt_ids: [first],
        gas_burnt: GAS_BURNT,
        tokens_burnt: TOKENS_BURNT,
        executor_id: tx.signerId,
        status: { SuccessReceiptId: first },
        metadata: { version: 1, gas_profile: null },
      },
    },
    receipts_outcome: receiptsOutcome,
  };
}

function invalidTx(error: Record<string, unknown> | string, text: string): FakeRpcFault {
  return new FakeRpcFault("HANDLER_ERROR", "INVALID_TRANSACTION", text, {
    TxExecutionError: { InvalidTxError: error },
  });
}

function sendTx(chain: FakeChain, params: unknown): unknown {
  const base64 = Array.isArray(params)
    ? String(params[0])
    : String(record(params).signed_tx_base64);
  let bytes: Uint8Array;
  let signed: ReturnType<typeof decodeSignedTransaction>;
  try {
    bytes = new Uint8Array(Buffer.from(base64, "base64"));
    signed = decodeSignedTransaction(bytes);
  } catch {
    throw new FakeRpcFault(
      "REQUEST_VALIDATION_ERROR",
      "PARSE_ERROR",
      "the signed transaction could not be decoded",
      undefined,
      {
        error_message: "the signed transaction could not be decoded",
      },
    );
  }
  const t = signed.transaction;
  const fc = t.actions[0]?.functionCall;
  if (t.actions.length !== 1 || fc === undefined || fc === null) {
    throw new FakeRpcFault(
      "HANDLER_ERROR",
      "FAKE_UNSUPPORTED",
      "the fake chain supports one FunctionCall action per transaction",
    );
  }
  const signerPk = t.publicKey.toString();
  // A node's transaction id is the hash of the unsigned transaction bytes, and the signature is over that hash.
  const digest = sha256Bytes(encodeTransaction(t));
  const hash = baseEncode(digest);
  const signature = signed.signature.ed25519Signature?.data;
  if (
    signature === undefined ||
    !verifyEd25519(formatSignature(new Uint8Array(signature)), digest, signerPk)
  ) {
    throw invalidTx("InvalidSignature", "InvalidSignature");
  }
  if (baseEncode(Uint8Array.from(t.blockHash as ArrayLike<number>)) !== chain.blockHash)
    throw invalidTx("Expired", "Expired: the block hash is not recent");
  const deposit = BigInt(fc.deposit.toString());
  chain.useNonce(t.signerId, signerPk, Number(t.nonce), fc.methodName, t.receiverId, deposit);
  const argBytes = Uint8Array.from(fc.args as ArrayLike<number>);
  const sent: SentTx = {
    hash,
    signerId: t.signerId,
    signerPk,
    receiverId: t.receiverId,
    nonce: Number(t.nonce),
    method: fc.methodName,
    argsBase64: Buffer.from(argBytes).toString("base64"),
    gas: Number(fc.gas),
    deposit: deposit.toString(),
    signature: formatSignature(new Uint8Array(signature)),
  };
  let applied: Applied;
  try {
    applied = {
      ok: true,
      result: chain.applyFunctionCall({
        signerId: t.signerId,
        signerPk,
        receiverId: t.receiverId,
        method: fc.methodName,
        args: decodeJson(argBytes),
        deposit,
      }),
    };
  } catch (error) {
    if (!(error instanceof FakePanic)) throw error;
    applied = { ok: false, panic: error.message };
  }
  const outcome = buildOutcome(chain, sent, applied);
  chain.txs.set(hash, outcome);
  return outcome;
}

function txStatus(chain: FakeChain, params: unknown): unknown {
  const hash = Array.isArray(params) ? String(params[0]) : String(record(params).tx_hash);
  const found = chain.txs.get(hash);
  if (found === undefined) {
    throw new FakeRpcFault(
      "HANDLER_ERROR",
      "UNKNOWN_TRANSACTION",
      `transaction ${hash} not found`,
      undefined,
      { requested_transaction_hash: hash },
    );
  }
  return found;
}

function dispatch(chain: FakeChain, method: string, params: unknown): unknown {
  switch (method) {
    case "query":
      return query(chain, record(params));
    case "block":
      return {
        author: "fake.testnet",
        header: {
          height: chain.height,
          hash: chain.blockHash,
          prev_hash: chain.blockHash,
          timestamp: Number(chain.nowNs()),
          timestamp_nanosec: chain.nowNs().toString(),
          gas_price: "100000000",
          epoch_id: chain.blockHash,
          next_epoch_id: chain.blockHash,
        },
        chunks: [],
      };
    case "send_tx":
    case "broadcast_tx_commit":
      return sendTx(chain, params);
    case "tx":
    case "EXPERIMENTAL_tx_status":
      return txStatus(chain, params);
    default:
      throw new FakeRpcFault(
        "REQUEST_VALIDATION_ERROR",
        "METHOD_NOT_FOUND",
        `FAKE_UNSUPPORTED:${method}`,
        undefined,
        {
          method_name: method,
        },
      );
  }
}

export async function startFakeRpcServer(chain: FakeChain): Promise<FakeRpcServer> {
  const methods: string[] = [];
  const failures: number[] = [];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = record(JSON.parse(await readBody(req)));
    } catch {
      send(res, 400, { error: "bad json" });
      return;
    }
    const method = String(message.method);
    methods.push(method);
    const injected = failures.shift();
    if (injected !== undefined) {
      send(res, injected, { error: `injected HTTP ${injected}` });
      return;
    }
    const id = message.id ?? null;
    try {
      send(res, 200, { jsonrpc: "2.0", id, result: dispatch(chain, method, message.params) });
    } catch (error) {
      if (error instanceof FakeRpcFault) {
        send(res, 200, {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: "Server error",
            name: error.errorName,
            cause: { name: error.causeName, info: error.info },
            data: error.data,
          },
        });
        return;
      }
      // A bug in the double itself: answer at once with a JSON-RPC error instead of an HTTP 500, which clients retry.
      const detail = error instanceof Error ? error.message : String(error);
      send(res, 200, {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: "Server error",
          name: "INTERNAL_ERROR",
          cause: { name: "INTERNAL_ERROR", info: { error_message: `FAKE_BUG: ${detail}` } },
          data: `FAKE_BUG: ${detail}`,
        },
      });
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    chain,
    methods,
    failNext(statuses) {
      failures.push(...statuses);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
