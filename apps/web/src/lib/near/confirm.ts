import "server-only";
import {
  firstReceiptSucceeded,
  isOutOfNearCode,
  LACK_BALANCE_CODE,
  OUT_OF_GAS_NEAR_DETAIL,
  OUT_OF_NEAR_DETAIL,
  parseTxOutcome as parseChainOutcome,
} from "@probarion/sdk";
import {
  type ChainOutcome,
  type ConfirmRequest,
  interpretChain,
  isTxHash,
  type TxResult,
} from "./outcome";
import { getRpc } from "./server";
import { isReadableMethod, type PreparedAction, preparedLabel } from "./tx";
import { isNearAccountId } from "./validate";

/** The one RpcClient method used here, so a test can stand in for the network. */
export interface RpcLike {
  call<T>(method: string, params: unknown): Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknown(txHash: string | null, error: string): TxResult {
  return { status: "unknown", txHash, code: null, error };
}

const U128_MAX = 2n ** 128n - 1n;
const DIGITS = /^(0|[1-9][0-9]*)$/;
const METHOD_NAME = /^[A-Za-z0-9_]{1,128}$/;
const MAX_ACTIONS = 16;
const MAX_ARGS_JSON = 16_384;
const MAX_DEPTH = 32;

/**
 * How many blocks BEFORE the baseline a transaction may still be in and count as this send.
 *
 * The baseline is the final height read when the send begins, and that read races the wallet: the
 * request to the server starts before the wallet is asked, but its answer can come back after a fast
 * approval of an urgent call (a freeze), so the transaction can land at or a few blocks below the
 * height the server saw. At about a block a second, 30 blocks is half a minute: far more than that race,
 * and a replay of an old transaction (hours or days old) is still refused. What really ties the record
 * to this send is the rest of the check: every action, the arguments, the deposits and the signer.
 */
export const BASELINE_TOLERANCE_BLOCKS = 30;

// ---------------------------------------------------------------------------------------------
// The request is untrusted input (it crossed from the browser): check its shape before using it.
// ---------------------------------------------------------------------------------------------

function amount(value: unknown): string | null {
  return typeof value === "string" && DIGITS.test(value) && BigInt(value) <= U128_MAX
    ? value
    : null;
}

function parseAction(value: unknown): PreparedAction | null {
  if (!isRecord(value)) return null;
  const deposit = amount(value.deposit);
  if (deposit === null) return null;
  if (value.type === "Transfer") return { type: "Transfer", deposit };
  if (value.type !== "FunctionCall") return null;
  const { methodName, args } = value;
  const gas = amount(value.gas);
  if (typeof methodName !== "string" || !METHOD_NAME.test(methodName)) return null;
  if (!isRecord(args) || gas === null) return null;
  let size: number;
  try {
    size = JSON.stringify(args).length;
  } catch {
    return null;
  }
  if (size > MAX_ARGS_JSON) return null;
  return { type: "FunctionCall", methodName, args, deposit, gas };
}

/** The `ConfirmRequest` in whatever arrived, or why it is not one. */
export function parseRequest(input: unknown): ConfirmRequest | string {
  if (!isRecord(input)) return "The request was not an object";
  const { hash, signerId, tx, baselineHeight } = input;
  if (!isTxHash(hash)) return "That is not a transaction hash";
  if (typeof signerId !== "string" || !isNearAccountId(signerId)) {
    return "The signer is not an account";
  }
  if (!isRecord(tx) || typeof tx.receiverId !== "string" || !isNearAccountId(tx.receiverId)) {
    return "The receiver is not an account";
  }
  if (!Array.isArray(tx.actions) || tx.actions.length === 0 || tx.actions.length > MAX_ACTIONS) {
    return "The transaction has no actions, or too many";
  }
  const actions: PreparedAction[] = [];
  for (const raw of tx.actions) {
    const action = parseAction(raw);
    if (action === null) return "An action was malformed";
    actions.push(action);
  }
  const last = actions[actions.length - 1];
  if (last === undefined || !isReadableMethod(preparedLabel(last))) {
    return "The last call is not one this console reads";
  }
  if (baselineHeight === undefined) return "The starting block height is missing";
  if (
    baselineHeight !== null &&
    !(
      typeof baselineHeight === "number" &&
      Number.isSafeInteger(baselineHeight) &&
      baselineHeight > 0
    )
  ) {
    return "The starting block height is not a block height";
  }
  return { hash, signerId, tx: { receiverId: tx.receiverId, actions }, baselineHeight };
}

// ---------------------------------------------------------------------------------------------
// The chain's record has to be the transaction the owner was shown, action by action.
// ---------------------------------------------------------------------------------------------

/** Equality of two decoded JSON values, whatever the order of an object's keys. */
export function sameJson(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item: unknown, i) => sameJson(item, b[i], depth + 1))
    );
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return (
    ka.length === kb.length &&
    ka.every(
      (k, i) =>
        k === kb[i] &&
        sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1),
    )
  );
}

/** A deposit as the node reports it (a decimal string) equals the one shown, as numbers. */
function sameAmount(onChain: unknown, shown: string): boolean {
  const text =
    typeof onChain === "string"
      ? onChain
      : typeof onChain === "number" && Number.isSafeInteger(onChain)
        ? String(onChain)
        : null;
  return text !== null && DIGITS.test(text) && BigInt(text) === BigInt(shown);
}

/**
 * The arguments a call carried, decoded base64 -> UTF-8 -> JSON. A call with no arguments is sent by
 * some wallets as empty bytes rather than `{}`: those are read as `{}`, so a `freeze` or an
 * `unfreeze` (shown with `{}`) matches either. Empty bytes still do not match any non-empty args.
 */
function decodeArgs(base64: unknown): unknown {
  if (typeof base64 !== "string") return undefined;
  if (base64 === "") return {};
  try {
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Why `chain` is not `shown` (the action at position `i`), or `null` when it is. */
function actionProblem(shown: PreparedAction, chain: unknown, i: number): string | null {
  const at = `action ${i + 1}`;
  if (!isRecord(chain)) return `${at} is not one this console sends`;
  if (shown.type === "Transfer") {
    const transfer = chain.Transfer;
    if (!isRecord(transfer)) return `${at} is not a Transfer`;
    return sameAmount(transfer.deposit, shown.deposit)
      ? null
      : `${at} moves a different amount of NEAR than was shown`;
  }
  const call = chain.FunctionCall;
  if (!isRecord(call)) return `${at} is not a contract call`;
  if (call.method_name !== shown.methodName) {
    return `${at} calls ${String(call.method_name).slice(0, 60)}, not ${shown.methodName}`;
  }
  if (!sameJson(decodeArgs(call.args), shown.args)) {
    return `${at} (${shown.methodName}) has different arguments than were shown`;
  }
  if (!sameAmount(call.deposit, shown.deposit)) {
    return `${at} (${shown.methodName}) attaches a different deposit than was shown`;
  }
  // Gas is not compared: a wallet may adjust it, and it moves no value.
  return null;
}

/**
 * Is `raw` the transaction we asked about, and the one the owner was shown? The wallet gave us a hash;
 * nothing it said is trusted. The chain's own record has to match the signer, the receiver, and every
 * action in order: its type, method, decoded arguments and deposit. Returns the reason it does not.
 */
export function mismatch(raw: Record<string, unknown>, req: ConfirmRequest): string | null {
  const tx = raw.transaction;
  if (!isRecord(tx)) return "The network's answer has no transaction";
  if (tx.hash !== req.hash) return "The network answered about a different transaction";
  if (tx.signer_id !== req.signerId) return `That transaction was not signed by ${req.signerId}`;
  if (tx.receiver_id !== req.tx.receiverId) {
    return "That transaction went to a different account than the one prepared";
  }
  const actions = tx.actions;
  if (!Array.isArray(actions)) return "The network's answer has no actions";
  if (actions.length !== req.tx.actions.length) {
    return `That transaction has ${actions.length} actions, not the ${req.tx.actions.length} that were shown`;
  }
  for (const [i, shown] of req.tx.actions.entries()) {
    const problem = actionProblem(shown, actions[i], i);
    if (problem !== null) return `That transaction differs from the one shown: ${problem}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Freshness: the transaction has to be newer than the moment the send began (no replayed hash).
// ---------------------------------------------------------------------------------------------

function heightOf(block: unknown, expectedHash?: string): number | null {
  if (!isRecord(block) || !isRecord(block.header)) return null;
  const { height, hash } = block.header;
  if (expectedHash !== undefined && hash !== expectedHash) return null;
  return typeof height === "number" && Number.isSafeInteger(height) && height > 0 ? height : null;
}

/** The final block height now, or `null` when the network cannot say. Never throws. */
export async function currentFinalHeight(rpc: RpcLike = getRpc()): Promise<number | null> {
  try {
    return heightOf(await rpc.call<unknown>("block", { finality: "final" }));
  } catch {
    return null;
  }
}

/** The height of the block the transaction was included in, or `null` when that cannot be established. */
async function inclusionHeight(raw: Record<string, unknown>, rpc: RpcLike): Promise<number | null> {
  const outcome = raw.transaction_outcome;
  const blockHash = isRecord(outcome) ? outcome.block_hash : undefined;
  if (typeof blockHash !== "string" || blockHash.length === 0) return null;
  try {
    return heightOf(await rpc.call<unknown>("block", { block_id: blockHash }), blockHash);
  } catch {
    return null;
  }
}

/**
 * Reads the final outcome of a transaction from the chain and says what it means. The owner's wallet
 * is not asked and not believed: this takes only the hash it reported, waits for the transaction to be
 * final, checks it is the transaction that was shown (signer, receiver, and every action's method,
 * decoded arguments and deposit) and that it is newer than the send, and reads its result.
 * Anything that cannot be established (no node, no such transaction, a different transaction, an old
 * one, a status not final, an unreadable answer) is `unknown`, never `ok`.
 *
 * `request` is untrusted input and is validated here.
 */
export async function confirmTx(request: unknown, rpc: RpcLike = getRpc()): Promise<TxResult> {
  const parsed = parseRequest(request);
  if (typeof parsed === "string") {
    const hash = isRecord(request) && isTxHash(request.hash) ? request.hash : null;
    return unknown(hash, `${parsed}; confirm on the explorer.`);
  }
  const { hash } = parsed;
  const last = parsed.tx.actions[parsed.tx.actions.length - 1];
  const method = last === undefined ? "" : preparedLabel(last);
  if (!isReadableMethod(method)) {
    return unknown(hash, "The last call is not one this console reads.");
  }

  let raw: unknown;
  try {
    raw = await rpc.call<unknown>("tx", {
      tx_hash: hash,
      sender_account_id: parsed.signerId,
      wait_until: "FINAL",
    });
  } catch (e) {
    const why = e instanceof Error ? e.message.slice(0, 200) : "no answer";
    return unknown(
      hash,
      `The network could not be asked about this transaction (${why}); confirm on the explorer.`,
    );
  }
  if (!isRecord(raw)) {
    return unknown(hash, "The network's answer could not be read; confirm on the explorer.");
  }

  const wrong = mismatch(raw, parsed);
  if (wrong !== null) return unknown(hash, `${wrong}; confirm on the explorer.`);

  // A transaction from last week that happens to match is still not this send.
  if (parsed.baselineHeight === null) {
    return unknown(
      hash,
      "The network height when the send began could not be read, so this transaction cannot be told from an old one; confirm on the explorer.",
    );
  }
  const height = await inclusionHeight(raw, rpc);
  if (height === null) {
    return unknown(
      hash,
      "The block this transaction is in could not be read; confirm on the explorer.",
    );
  }
  if (height < parsed.baselineHeight - BASELINE_TOLERANCE_BLOCKS) {
    return unknown(
      hash,
      "could not confirm this is the transaction you just approved; check the explorer",
    );
  }

  let chain: ChainOutcome;
  try {
    const o = parseChainOutcome(raw);
    const status = isRecord(raw.status) ? raw.status : {};
    chain = {
      txHash: hash,
      ok: o.ok,
      failed: status.Failure !== undefined,
      value: o.value,
      empty: status.SuccessValue === "",
      code: o.code,
      failure: isOutOfNearCode(o.code)
        ? o.code === LACK_BALANCE_CODE
          ? OUT_OF_NEAR_DETAIL
          : OUT_OF_GAS_NEAR_DETAIL
        : o.failure,
      firstReceiptOk: firstReceiptSucceeded(raw),
      receiptFailed: anyReceiptFailed(raw),
    };
  } catch {
    return unknown(hash, "The network's answer could not be read; confirm on the explorer.");
  }
  if (method === "set_ledger_key" && chain.ok && chain.receiptFailed) {
    if (await isLedgerKeyRecovery(raw, parsed, rpc)) chain = { ...chain, receiptFailed: false };
  }
  return interpretChain(method, chain);
}

/** The failed receipts of a transaction (`outcome.status` is a Failure). */
function failedReceipts(raw: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(raw.receipts_outcome)) return [];
  return raw.receipts_outcome.filter((r: unknown): r is Record<string, unknown> => {
    const status = isRecord(r) && isRecord(r.outcome) ? r.outcome.status : undefined;
    return isRecord(status) && status.Failure !== undefined;
  });
}

/** The bytes of a `call_function` query result, as JSON, or undefined. */
function viewJson(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.result)) return undefined;
  if (!result.result.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return undefined;
  try {
    return JSON.parse(Buffer.from(result.result as number[]).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * W-T10-R3. A vault on the fixed code (3dde545, delete first since 64ac3c0) runs `set_ledger_key` as two
 * independent receipts: DeleteKey(previous ledger key), then AddKey(new key, anchor only). When the
 * previous key was never added (a stuck ledger key), the DeleteKey fails alone with
 * DeleteKeyDoesNotExist and the AddKey lands: that is the recovery, and it succeeded. Only that exact
 * shape counts:
 *  - exactly one receipt failed; it ran on the vault itself (the transaction's receiver), and its error
 *    is exactly `ActionError { index: 0, kind: DeleteKeyDoesNotExist { account_id: vault, public_key } }`;
 *  - that public key is the vault's ledger key BEFORE this call (`get_config` at the block the
 *    transaction is in), and is not the new key;
 *  - the new key (the call's `public_key`) is now on the vault exactly as set_ledger_key adds it: a
 *    plain FunctionCall key, receiver the vault, methods exactly `[anchor]`.
 * Anything else, or any read that fails, is not a recovery (the result stays unknown or failed).
 */
async function isLedgerKeyRecovery(
  raw: Record<string, unknown>,
  req: ConfirmRequest,
  rpc: RpcLike,
): Promise<boolean> {
  const vault = req.tx.receiverId;
  const last = req.tx.actions[req.tx.actions.length - 1];
  if (req.tx.actions.length !== 1 || last?.type !== "FunctionCall") return false;
  if (last.methodName !== "set_ledger_key") return false;
  const newKey = last.args.public_key;
  if (typeof newKey !== "string" || newKey === "") return false;

  const failed = failedReceipts(raw);
  const only = failed[0];
  if (failed.length !== 1 || only === undefined || !isRecord(only.outcome)) return false;
  if (only.outcome.executor_id !== vault) return false;
  const status = only.outcome.status;
  const error = isRecord(status) ? status.Failure : undefined;
  const action = isRecord(error) ? error.ActionError : undefined;
  if (!isRecord(error) || Object.keys(error).length !== 1 || !isRecord(action)) return false;
  if (action.index !== 0 || !isRecord(action.kind) || Object.keys(action.kind).length !== 1)
    return false;
  const missing = action.kind.DeleteKeyDoesNotExist;
  if (!isRecord(missing) || missing.account_id !== vault) return false;
  const previous = missing.public_key;
  if (typeof previous !== "string" || previous === newKey) return false;

  try {
    // The vault's ledger key before this call: state at the end of the block the transaction is in
    // (the call itself runs in a later block).
    const included = isRecord(raw.transaction_outcome) ? raw.transaction_outcome.block_hash : null;
    if (typeof included !== "string" || included === "") return false;
    const before = viewJson(
      await rpc.call<unknown>("query", {
        request_type: "call_function",
        block_id: included,
        account_id: vault,
        method_name: "get_config",
        args_base64: Buffer.from("{}").toString("base64"),
      }),
    );
    if (!isRecord(before) || before.ledger_key !== previous) return false;

    const key = await rpc.call<unknown>("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: vault,
      public_key: newKey,
    });
    const permission = isRecord(key) ? key.permission : undefined;
    const fc = isRecord(permission) ? permission.FunctionCall : undefined;
    return (
      isRecord(permission) &&
      Object.keys(permission).length === 1 &&
      isRecord(fc) &&
      fc.receiver_id === vault &&
      Array.isArray(fc.method_names) &&
      fc.method_names.length === 1 &&
      fc.method_names[0] === "anchor"
    );
  } catch {
    return false;
  }
}

/** Did any receipt of the transaction end in a Failure? (Only `outcome.status` counts, never the logs.) */
function anyReceiptFailed(raw: Record<string, unknown>): boolean {
  if (!Array.isArray(raw.receipts_outcome)) return false;
  return raw.receipts_outcome.some((r: unknown) => {
    const status = isRecord(r) && isRecord(r.outcome) ? r.outcome.status : undefined;
    return isRecord(status) && status.Failure !== undefined;
  });
}
