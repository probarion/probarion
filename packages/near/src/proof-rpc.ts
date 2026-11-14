// N1 (outcome proof verifier): the online half. These helpers read a head and fetch light_client_proof answers over
// any NearRpc; they sign nothing and decide nothing. Every answer they hand back is checked by the pure verifier in
// outcome-proof.ts, so the RPC that served a proof is not trusted for its content. What stays trusted is the head:
// readCrossCheckedHead reads it from two providers, which lowers that trust without removing it.
//
// RPC methods used: `block`, `tx` and `light_client_proof` (nearcore's EXPERIMENTAL_light_client_proof alias).
import { isAccountId, isBase58Hash, isRecord, parseSafeCount } from "./encoding.js";
import { NearFormatError } from "./errors.js";
import { type OutcomeTreeResult, verifyTransactionOutcomes } from "./outcome-proof.js";
import type { NearRpc } from "./rpc.js";
import type { TrustedHead } from "./types.js";

/** verifyTransactionOutcomes takes at most this many proofs (the transaction's own and its receipts'). */
const MAX_TREE_PROOFS = 256;

/** What to prove: a transaction (by hash and signer) or a receipt (by id and the account that executed it). */
export type ProofTarget =
  | { type: "transaction"; txHash: string; senderId: string }
  | { type: "receipt"; receiptId: string; receiverId: string };

function requireHash(value: unknown, what: string): string {
  if (!isBase58Hash(value)) {
    throw new NearFormatError(
      what,
      `${what} is not a 32-byte base58 hash in its canonical spelling`,
    );
  }
  return value;
}

function requireAccount(value: unknown, what: string): string {
  if (!isAccountId(value)) throw new NearFormatError(what, `${what} is not a NEAR account id`);
  return value;
}

function proofParams(target: ProofTarget, headHash: string): Record<string, string> {
  const head = requireHash(headHash, "headHash");
  if (!isRecord(target)) throw new NearFormatError("target", "target is not an object");
  if (target.type === "transaction") {
    return {
      type: "transaction",
      transaction_hash: requireHash(target.txHash, "target.txHash"),
      sender_id: requireAccount(target.senderId, "target.senderId"),
      light_client_head: head,
    };
  }
  if (target.type === "receipt") {
    return {
      type: "receipt",
      receipt_id: requireHash(target.receiptId, "target.receiptId"),
      receiver_id: requireAccount(target.receiverId, "target.receiverId"),
      light_client_head: head,
    };
  }
  throw new NearFormatError("target.type", 'target.type is not "transaction" or "receipt"');
}

/**
 * Calls `light_client_proof` for `target` under the head block `headHash` (a final block the caller trusts) and
 * returns the raw answer, to be checked with verifyOutcomeProof against that head's block_merkle_root. A node keeps
 * outcomes for a few epochs: use an archival RPC for older ones. Throws NearFormatError for a target or head hash
 * that is not well formed (before any call) and passes the RPC's own error through (NearRpcError for httpJsonRpc).
 */
export async function fetchOutcomeProof(
  rpc: NearRpc,
  target: ProofTarget,
  headHash: string,
): Promise<unknown> {
  const params = proofParams(target, headHash);
  return rpc.call("light_client_proof", params);
}

/** The two providers disagree about the head block (`field` names what differs). */
export class HeadMismatchError extends Error {
  override readonly name = "HeadMismatchError";
  constructor(
    readonly field: "hash" | "height" | "block_merkle_root",
    message: string,
  ) {
    super(message);
  }
}

function headOf(answer: unknown, what: string): Required<TrustedHead> {
  const header = isRecord(answer) ? answer.header : undefined;
  if (!isRecord(header)) throw new NearFormatError(`${what}.header`, `${what} has no header`);
  const height = parseSafeCount(header.height);
  if (height === null) {
    throw new NearFormatError(
      `${what}.header.height`,
      `${what}.header.height is not a non-negative safe integer`,
    );
  }
  return {
    hash: requireHash(header.hash, `${what}.header.hash`),
    height,
    blockMerkleRoot: requireHash(header.block_merkle_root, `${what}.header.block_merkle_root`),
  };
}

/**
 * Reads the latest final block from `primary` (`block {finality: "final"}`), then the same block by hash from
 * `secondary` (`block {block_id: hash}`), and returns it as a TrustedHead once hash, height and block_merkle_root
 * agree. Pass providers run by different operators: a head that two of them serve alike is harder to fake, but it
 * is still their word (checking it by validator signatures is not part of this package). Throws HeadMismatchError
 * when they disagree, NearFormatError for an answer without a well-formed header, and passes RPC errors through (a
 * secondary that has not seen the block yet answers with an error: call again).
 */
export async function readCrossCheckedHead(
  primary: NearRpc,
  secondary: NearRpc,
): Promise<Required<TrustedHead>> {
  if (primary === secondary) {
    throw new TypeError("readCrossCheckedHead: pass two different providers");
  }
  const head = headOf(await primary.call("block", { finality: "final" }), "primary block");
  const other = headOf(await secondary.call("block", { block_id: head.hash }), "secondary block");
  if (other.hash !== head.hash) {
    throw new HeadMismatchError(
      "hash",
      `the secondary answered block ${other.hash} when asked for ${head.hash}`,
    );
  }
  if (other.height !== head.height) {
    throw new HeadMismatchError(
      "height",
      `block ${head.hash} is at height ${head.height} on the primary and ${other.height} on the secondary`,
    );
  }
  if (other.blockMerkleRoot !== head.blockMerkleRoot) {
    throw new HeadMismatchError(
      "block_merkle_root",
      `block ${head.hash} has block_merkle_root ${head.blockMerkleRoot} on the primary and ${other.blockMerkleRoot} on the secondary`,
    );
  }
  return head;
}

/** The receipts a `tx` answer lists, as proof targets. Untrusted pointers: the proofs say what they really are. */
function receiptTargets(answer: unknown): ProofTarget[] {
  if (!isRecord(answer) || !Array.isArray(answer.receipts_outcome)) {
    throw new NearFormatError("tx.receipts_outcome", "the tx answer has no receipts_outcome list");
  }
  return answer.receipts_outcome.map((entry: unknown, i) => {
    const what = `tx.receipts_outcome[${i}]`;
    const outcome = isRecord(entry) ? entry.outcome : undefined;
    if (!isRecord(entry) || !isRecord(outcome)) {
      throw new NearFormatError(what, `${what} is not an execution outcome`);
    }
    return {
      type: "receipt",
      receiptId: requireHash(entry.id, `${what}.id`),
      receiverId: requireAccount(outcome.executor_id, `${what}.outcome.executor_id`),
    };
  });
}

/**
 * Proves a transaction's outcome tree under `head`: reads `tx` (wait_until "FINAL") for the ids and executors of
 * its receipts, fetches a light_client_proof for the transaction and for each of those receipts, in that order, and
 * returns verifyTransactionOutcomes over them, which requires the whole tree. The `tx` answer says what to fetch and
 * nothing more: a receipt it leaves out leaves a proven receipt id without a proof (`incomplete`), and a receipt it
 * invents does not link (`not_linked`). So an `ok` result proves the transaction and every receipt it led to, and
 * that set does not rest on the list one node chose to serve. Proofs are fetched one at a time, gentle on
 * rate-limited public RPCs. Use an archival RPC for older transactions. Throws NearFormatError for malformed input
 * or a `tx` answer without a receipt list, and passes RPC errors through.
 */
export async function proveTransaction(
  rpc: NearRpc,
  input: { txHash: string; senderId: string; head: Required<TrustedHead> },
): Promise<OutcomeTreeResult> {
  if (!isRecord(input) || !isRecord(input.head)) {
    throw new NearFormatError("input", "input is not { txHash, senderId, head }");
  }
  const txHash = requireHash(input.txHash, "input.txHash");
  const senderId = requireAccount(input.senderId, "input.senderId");
  const headHash = requireHash(input.head.hash, "input.head.hash");
  requireHash(input.head.blockMerkleRoot, "input.head.blockMerkleRoot");
  const answer = await rpc.call("tx", {
    tx_hash: txHash,
    sender_account_id: senderId,
    wait_until: "FINAL",
  });
  const receipts = receiptTargets(answer);
  if (1 + receipts.length > MAX_TREE_PROOFS) {
    return {
      ok: false,
      index: -1,
      code: "too_many",
      detail: `the transaction lists ${receipts.length} receipts; at most ${MAX_TREE_PROOFS - 1} are proven in one tree`,
    };
  }
  const proofs: unknown[] = [
    await fetchOutcomeProof(rpc, { type: "transaction", txHash, senderId }, headHash),
  ];
  for (const target of receipts) proofs.push(await fetchOutcomeProof(rpc, target, headHash));
  return verifyTransactionOutcomes(proofs, input.head, { txHash, signerId: senderId });
}
