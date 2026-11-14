// N1 (outcome proof verifier): checks a NEAR `light_client_proof` answer against one block the caller already
// trusts, so "this receipt ran, with these logs and this status" no longer rests on the word of the RPC node that
// served it. The caller trusts one value, the head's `block_merkle_root`; everything else is recomputed here with
// nearcore's own hashing (near-primitives merkle.rs, ExecutionOutcomeWithId::to_hashes, BlockHeader::compute_hash).
//
// What a proof commits, from the outcome up to the head:
//   1. leaf      = sha256(borsh(Vec<CryptoHash>)) of [id, sha256(borsh(PartialExecutionOutcome)), sha256(log)...]
//   2. shardRoot = outcome_proof.proof folded from the leaf: the chunk's outcome root
//   3. the block's outcome_root = outcome_root_proof folded from sha256(shardRoot)
//   4. the block hash = sha256(sha256(sha256(borsh(inner_lite)) || inner_rest_hash) || prev_block_hash)
//   5. the head's block_merkle_root = block_proof folded from the block hash
// Not committed, so not read into the result: `outcome.metadata` (the gas profile), the Failure reason (the
// Failure tag is hashed, its reason is not), and the JSON `timestamp` number (it went through a float and is off
// by 1 to 125 ns in the recorded proofs; the exact value is `timestamp_nanosec`).
//
// Length domains: a leaf preimage is 4 + 32n bytes with n >= 2 (so at least 68), an inner node preimage is 64 bytes,
// and the outcome_root tree's leaf preimage is the 32-byte shard root, so no value reads as both a leaf and an inner
// node of one tree. Block-tree leaves are block hashes themselves: passing an inner node off as a block would need a
// sha256 preimage that is a 208-byte inner_lite.
//
// What this does not prove: that the head is a real NEAR block. The caller picks it (readCrossCheckedHead in
// proof-rpc.ts reads it from two providers); checking it by validator signatures is not part of this package.
import {
  BorshWriter,
  bytesEqual,
  decodeBase58Hash,
  decodeBase64,
  encodeBase58,
  isAccountId,
  isRecord,
  parseSafeCount,
  parseU64,
  parseU128,
  sha256,
  utf8,
} from "./encoding.js";
import { NearFormatError } from "./errors.js";
import type { MerklePathItem, ProvenOutcome, ProvenStatus, TrustedHead } from "./types.js";

/**
 * The most items a Merkle path in a proof may have. Real paths are far shorter (a chunk's outcomes and a block's
 * chunks need a handful; the recorded mainnet block_proof paths have 23 items at height 224 million, and the
 * block tree grows by one level per doubling), so 64 caps the work a hostile answer can ask for without refusing a
 * real one.
 */
export const MAX_PROOF_PATH = 64;
/** Caps on the lists inside one outcome. */
const MAX_LOGS = 1000;
const MAX_RECEIPT_IDS = 1000;
/** The most proofs verifyTransactionOutcomes takes for one transaction tree (proof-rpc.ts keeps the same cap). */
const MAX_TREE_PROOFS = 256;
/** borsh(BlockHeaderInnerLite): height u64, four 32-byte hashes, timestamp u64, two 32-byte hashes. */
const INNER_LITE_BYTES = 8 + 32 * 4 + 8 + 32 * 2;

export type OutcomeProofCode =
  | "malformed"
  | "path_too_long"
  | "id_mismatch"
  | "executor_mismatch"
  | "status_mismatch"
  | "outcome_root_mismatch"
  | "block_hash_mismatch"
  | "head_mismatch";

/** "success" is SuccessValue or SuccessReceiptId; "failure" is Failure; "any" also takes Unknown. */
export type ExpectedStatus = "success" | "failure" | "any";

/** What the proven outcome must also be. A field left out is not checked, except `status` (default "success"). */
export interface OutcomeExpectation {
  id?: string;
  executorId?: string;
  status?: ExpectedStatus;
}

export type OutcomeProofResult =
  | { ok: true; outcome: ProvenOutcome }
  | { ok: false; code: OutcomeProofCode; detail: string };

export type OutcomeTreeCode =
  | OutcomeProofCode
  | "empty"
  | "too_many"
  | "duplicate"
  | "not_linked"
  | "incomplete";

/**
 * `index` is the refused proof's position in the list (for `incomplete`, the proof whose outcome created the receipt
 * that has no proof), or -1 when the list or the expectation itself is refused.
 */
export type OutcomeTreeResult =
  | { ok: true; outcomes: readonly ProvenOutcome[] }
  | { ok: false; index: number; code: OutcomeTreeCode; detail: string };

// ---------- strict parsing ----------

/** A path longer than MAX_PROOF_PATH. Still a NearFormatError, so the public helpers keep one error type. */
class PathTooLongError extends NearFormatError {}

interface PathStep {
  hash: Uint8Array;
  left: boolean;
}

type ParsedStatus =
  | { tag: 0 }
  | { tag: 1 }
  | { tag: 2; value: Uint8Array }
  | { tag: 3; receiptId: Uint8Array; text: string };

interface ParsedOutcome {
  id: Uint8Array;
  idText: string;
  executorId: string;
  logs: string[];
  receiptIds: Uint8Array[];
  receiptIdTexts: string[];
  gasBurnt: bigint;
  tokensBurnt: bigint;
  status: ParsedStatus;
}

interface ParsedLite {
  height: number;
  epochId: Uint8Array;
  epochIdText: string;
  nextEpochId: Uint8Array;
  prevStateRoot: Uint8Array;
  outcomeRoot: Uint8Array;
  timestampNs: bigint;
  nextBpHash: Uint8Array;
  blockMerkleRoot: Uint8Array;
  innerRestHash: Uint8Array;
  prevBlockHash: Uint8Array;
}

interface ParsedProof {
  outcome: ParsedOutcome;
  outcomePath: PathStep[];
  claimedBlockHash: Uint8Array;
  outcomeRootPath: PathStep[];
  lite: ParsedLite;
  blockPath: PathStep[];
}

interface ParsedExpectation {
  status: ExpectedStatus;
  id?: string;
  executorId?: string;
}

/** A lone UTF-16 surrogate: TextEncoder turns it into U+FFFD, so two different strings would hash alike. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function describe(value: unknown): string {
  let text: string;
  try {
    text = String(JSON.stringify(value));
  } catch {
    text = typeof value;
  }
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new NearFormatError(what, `${what} is not a JSON object`);
  return value;
}

function hashField(value: unknown, what: string): Uint8Array {
  const bytes = decodeBase58Hash(value);
  if (bytes === null) {
    throw new NearFormatError(
      what,
      `${what} is not a 32-byte base58 hash in its canonical spelling: ${describe(value)}`,
    );
  }
  return bytes;
}

function list(value: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new NearFormatError(what, `${what} is not an array`);
  if (value.length > max) {
    throw new NearFormatError(what, `${what} has ${value.length} items, more than ${max}`);
  }
  return Array.from(value as unknown[]);
}

function parsePath(value: unknown, what: string): PathStep[] {
  if (!Array.isArray(value)) throw new NearFormatError(what, `${what} is not an array`);
  if (value.length > MAX_PROOF_PATH) {
    throw new PathTooLongError(
      what,
      `${what} has ${value.length} items, more than MAX_PROOF_PATH (${MAX_PROOF_PATH})`,
    );
  }
  // Array.from reads holes as undefined, so a sparse array is refused like any other non-object item.
  return Array.from(value as unknown[], (item, i) => {
    const step = record(item, `${what}[${i}]`);
    const direction = step.direction;
    if (direction !== "Left" && direction !== "Right") {
      throw new NearFormatError(
        `${what}[${i}].direction`,
        `${what}[${i}].direction is not "Left" or "Right": ${describe(direction)}`,
      );
    }
    return { hash: hashField(step.hash, `${what}[${i}].hash`), left: direction === "Left" };
  });
}

function parseStatus(value: unknown, what: string): ParsedStatus {
  if (value === "Unknown") return { tag: 0 };
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      // The reason is not hashed (PartialExecutionStatus::Failure has no payload), so it is not read.
      if (keys[0] === "Failure" && value.Failure !== undefined) return { tag: 1 };
      if (keys[0] === "SuccessValue") {
        const bytes = decodeBase64(value.SuccessValue);
        if (bytes === null) {
          throw new NearFormatError(
            `${what}.SuccessValue`,
            `${what}.SuccessValue is not padded base64 in its canonical spelling`,
          );
        }
        return { tag: 2, value: bytes };
      }
      if (keys[0] === "SuccessReceiptId") {
        return {
          tag: 3,
          receiptId: hashField(value.SuccessReceiptId, `${what}.SuccessReceiptId`),
          text: value.SuccessReceiptId as string,
        };
      }
    }
  }
  throw new NearFormatError(
    what,
    `${what} is not "Unknown", {Failure}, {SuccessValue} or {SuccessReceiptId}: ${describe(value)}`,
  );
}

/** An ExecutionOutcomeWithIdView: `{ id, outcome: { logs, receipt_ids, gas_burnt, tokens_burnt, executor_id, status } }`. */
function parseOutcomeWithId(value: unknown, what: string): ParsedOutcome {
  const withId = record(value, what);
  const id = hashField(withId.id, `${what}.id`);
  const outcome = record(withId.outcome, `${what}.outcome`);
  const logs = list(outcome.logs, `${what}.outcome.logs`, MAX_LOGS).map((log, i) => {
    if (typeof log !== "string" || LONE_SURROGATE_RE.test(log)) {
      throw new NearFormatError(
        `${what}.outcome.logs[${i}]`,
        `${what}.outcome.logs[${i}] is not a well-formed string`,
      );
    }
    return log;
  });
  const receiptIdTexts: string[] = [];
  const receiptIds = list(outcome.receipt_ids, `${what}.outcome.receipt_ids`, MAX_RECEIPT_IDS).map(
    (receiptId, i) => {
      const bytes = hashField(receiptId, `${what}.outcome.receipt_ids[${i}]`);
      receiptIdTexts.push(receiptId as string);
      return bytes;
    },
  );
  const gas = parseSafeCount(outcome.gas_burnt);
  if (gas === null) {
    throw new NearFormatError(
      `${what}.outcome.gas_burnt`,
      `${what}.outcome.gas_burnt is not a non-negative safe integer: ${describe(outcome.gas_burnt)}`,
    );
  }
  const tokensBurnt = parseU128(outcome.tokens_burnt);
  if (tokensBurnt === null) {
    throw new NearFormatError(
      `${what}.outcome.tokens_burnt`,
      `${what}.outcome.tokens_burnt is not a canonical U128 decimal string: ${describe(outcome.tokens_burnt)}`,
    );
  }
  if (!isAccountId(outcome.executor_id)) {
    throw new NearFormatError(
      `${what}.outcome.executor_id`,
      `${what}.outcome.executor_id is not a NEAR account id: ${describe(outcome.executor_id)}`,
    );
  }
  return {
    id,
    idText: withId.id as string,
    executorId: outcome.executor_id,
    logs,
    receiptIds,
    receiptIdTexts,
    gasBurnt: BigInt(gas),
    tokensBurnt,
    status: parseStatus(outcome.status, `${what}.outcome.status`),
  };
}

function parseLite(value: unknown, what: string): ParsedLite {
  const lite = record(value, what);
  const inner = record(lite.inner_lite, `${what}.inner_lite`);
  const height = parseSafeCount(inner.height);
  if (height === null) {
    throw new NearFormatError(
      `${what}.inner_lite.height`,
      `${what}.inner_lite.height is not a non-negative safe integer: ${describe(inner.height)}`,
    );
  }
  // The exact timestamp. The JSON `timestamp` number went through a float and is not used.
  const timestampNs = parseU64(inner.timestamp_nanosec);
  if (timestampNs === null) {
    throw new NearFormatError(
      `${what}.inner_lite.timestamp_nanosec`,
      `${what}.inner_lite.timestamp_nanosec is not a canonical U64 decimal string: ${describe(inner.timestamp_nanosec)}`,
    );
  }
  return {
    height,
    epochId: hashField(inner.epoch_id, `${what}.inner_lite.epoch_id`),
    epochIdText: inner.epoch_id as string,
    nextEpochId: hashField(inner.next_epoch_id, `${what}.inner_lite.next_epoch_id`),
    prevStateRoot: hashField(inner.prev_state_root, `${what}.inner_lite.prev_state_root`),
    outcomeRoot: hashField(inner.outcome_root, `${what}.inner_lite.outcome_root`),
    timestampNs,
    nextBpHash: hashField(inner.next_bp_hash, `${what}.inner_lite.next_bp_hash`),
    blockMerkleRoot: hashField(inner.block_merkle_root, `${what}.inner_lite.block_merkle_root`),
    innerRestHash: hashField(lite.inner_rest_hash, `${what}.inner_rest_hash`),
    prevBlockHash: hashField(lite.prev_block_hash, `${what}.prev_block_hash`),
  };
}

function parseProof(value: unknown): ParsedProof {
  const proof = record(value, "proof");
  const outcomeProof = record(proof.outcome_proof, "outcome_proof");
  return {
    outcome: parseOutcomeWithId(outcomeProof, "outcome_proof"),
    outcomePath: parsePath(outcomeProof.proof, "outcome_proof.proof"),
    claimedBlockHash: hashField(outcomeProof.block_hash, "outcome_proof.block_hash"),
    outcomeRootPath: parsePath(proof.outcome_root_proof, "outcome_root_proof"),
    lite: parseLite(proof.block_header_lite, "block_header_lite"),
    blockPath: parsePath(proof.block_proof, "block_proof"),
  };
}

/** The caller's head, copied with the fields TrustedHead has and nothing else. */
function parseHead(value: unknown): { root: Uint8Array; head: TrustedHead } {
  const head = record(value, "head");
  const root = hashField(head.blockMerkleRoot, "head.blockMerkleRoot");
  const copy: TrustedHead = { blockMerkleRoot: head.blockMerkleRoot as string };
  if (head.hash !== undefined) {
    hashField(head.hash, "head.hash");
    copy.hash = head.hash as string;
  }
  if (head.height !== undefined) {
    const height = parseSafeCount(head.height);
    if (height === null) {
      throw new NearFormatError("head.height", "head.height is not a non-negative safe integer");
    }
    copy.height = height;
  }
  return { root, head: copy };
}

function parseExpectation(value: unknown): ParsedExpectation {
  if (value === undefined) return { status: "success" };
  const expect = record(value, "expect");
  const status = expect.status ?? "success";
  if (status !== "success" && status !== "failure" && status !== "any") {
    throw new NearFormatError(
      "expect.status",
      `expect.status is not "success", "failure" or "any": ${describe(status)}`,
    );
  }
  const parsed: ParsedExpectation = { status };
  for (const field of ["id", "executorId"] as const) {
    const given = expect[field];
    if (given === undefined) continue;
    if (typeof given !== "string") {
      throw new NearFormatError(`expect.${field}`, `expect.${field} is not a string`);
    }
    parsed[field] = given;
  }
  return parsed;
}

// ---------- hashing ----------

function foldPath(leaf: Uint8Array, path: readonly PathStep[]): Uint8Array {
  let acc = leaf;
  for (const step of path) acc = step.left ? sha256(step.hash, acc) : sha256(acc, step.hash);
  return acc;
}

function leafOf(outcome: ParsedOutcome): Uint8Array {
  // borsh(PartialExecutionOutcome): receipt_ids, gas_burnt, tokens_burnt, executor_id, then the status tag
  // (Unknown 0, Failure 1, SuccessValue 2 + Vec<u8>, SuccessReceiptId 3 + 32 bytes).
  const partial = new BorshWriter().u32(outcome.receiptIds.length);
  for (const receiptId of outcome.receiptIds) partial.fixed(receiptId);
  partial.u64(outcome.gasBurnt).u128(outcome.tokensBurnt).string(outcome.executorId);
  partial.u8(outcome.status.tag);
  if (outcome.status.tag === 2) partial.bytes(outcome.status.value);
  if (outcome.status.tag === 3) partial.fixed(outcome.status.receiptId);
  // ExecutionOutcomeWithId::to_hashes, then CryptoHash::hash_borsh of that Vec<CryptoHash>.
  const hashes = new BorshWriter().u32(2 + outcome.logs.length);
  hashes.fixed(outcome.id).fixed(sha256(partial.toBytes()));
  for (const log of outcome.logs) hashes.fixed(sha256(utf8(log)));
  return sha256(hashes.toBytes());
}

function blockHashOf(lite: ParsedLite): Uint8Array {
  const inner = new BorshWriter()
    .u64(BigInt(lite.height))
    .fixed(lite.epochId)
    .fixed(lite.nextEpochId)
    .fixed(lite.prevStateRoot)
    .fixed(lite.outcomeRoot)
    .u64(lite.timestampNs)
    .fixed(lite.nextBpHash)
    .fixed(lite.blockMerkleRoot)
    .toBytes();
  if (inner.length !== INNER_LITE_BYTES) {
    throw new NearFormatError("inner_lite", `inner_lite is ${inner.length} bytes, not 208`);
  }
  return sha256(sha256(sha256(inner), lite.innerRestHash), lite.prevBlockHash);
}

// ---------- low-level pieces ----------

/**
 * Folds a nearcore Merkle path from `leaf` (the item's hash, 32 bytes): a "Left" item is hashed before the running
 * value, a "Right" item after it (merkle.rs compute_root_from_path). Throws NearFormatError for a leaf that is not
 * 32 bytes, a hash that is not 32 canonical base58 bytes, a direction other than "Left"/"Right", or a path longer
 * than MAX_PROOF_PATH.
 */
export function merkleRootFromPath(leaf: Uint8Array, path: readonly MerklePathItem[]): Uint8Array {
  if (!(leaf instanceof Uint8Array) || leaf.length !== 32) {
    throw new NearFormatError("leaf", "leaf is not a 32-byte hash");
  }
  return foldPath(leaf, parsePath(path, "path"));
}

/**
 * The block hash a `block_header_lite` commits to, in base58: sha256(sha256(sha256(borsh(inner_lite)) ||
 * inner_rest_hash) || prev_block_hash), with the exact `timestamp_nanosec`. Throws NearFormatError for a field that
 * is missing or not in NEAR's canonical spelling.
 */
export function lightBlockHash(blockHeaderLite: unknown): string {
  return encodeBase58(blockHashOf(parseLite(blockHeaderLite, "block_header_lite")));
}

/**
 * The Merkle leaf of one execution outcome: an `outcome_proof`, or an entry of a `tx` answer's
 * `transaction_outcome` / `receipts_outcome`, which carry the same fields. Throws NearFormatError on malformed input.
 */
export function outcomeLeafHash(outcomeWithId: unknown): Uint8Array {
  return leafOf(parseOutcomeWithId(outcomeWithId, "outcome"));
}

// ---------- verification ----------

function refusal(error: unknown): {
  ok: false;
  code: "malformed" | "path_too_long";
  detail: string;
} {
  if (error instanceof PathTooLongError) {
    return { ok: false, code: "path_too_long", detail: error.message };
  }
  if (error instanceof NearFormatError)
    return { ok: false, code: "malformed", detail: error.message };
  // Not expected (the parsers throw NearFormatError); still a refusal, so the verifier stays total.
  return {
    ok: false,
    code: "malformed",
    detail: `the proof could not be read: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function provenStatus(status: ParsedStatus): ProvenStatus {
  switch (status.tag) {
    case 0:
      return { kind: "unknown" };
    case 1:
      return { kind: "failure" };
    case 2:
      return { kind: "success_value", value: status.value };
    case 3:
      return { kind: "success_receipt_id", receiptId: status.text };
  }
}

function statusMatches(status: ProvenStatus, expected: ExpectedStatus): boolean {
  if (expected === "any") return true;
  if (expected === "failure") return status.kind === "failure";
  return status.kind === "success_value" || status.kind === "success_receipt_id";
}

function headName(head: TrustedHead): string {
  const parts: string[] = [];
  if (head.hash !== undefined) parts.push(`block ${head.hash}`);
  if (head.height !== undefined) parts.push(`height ${head.height}`);
  return parts.length === 0 ? "the trusted head" : `the trusted head (${parts.join(", ")})`;
}

function verifyParsed(
  parsed: ParsedProof,
  trusted: { root: Uint8Array; head: TrustedHead },
  expectation: ParsedExpectation,
): OutcomeProofResult {
  const outcome = parsed.outcome;
  const shardRoot = foldPath(leafOf(outcome), parsed.outcomePath);
  const outcomeRoot = foldPath(sha256(shardRoot), parsed.outcomeRootPath);
  if (!bytesEqual(outcomeRoot, parsed.lite.outcomeRoot)) {
    return {
      ok: false,
      code: "outcome_root_mismatch",
      detail: `outcome ${outcome.idText} and its paths give outcome_root ${encodeBase58(outcomeRoot)}, but block_header_lite has ${encodeBase58(parsed.lite.outcomeRoot)}`,
    };
  }
  const blockHash = blockHashOf(parsed.lite);
  if (!bytesEqual(blockHash, parsed.claimedBlockHash)) {
    return {
      ok: false,
      code: "block_hash_mismatch",
      detail: `block_header_lite hashes to ${encodeBase58(blockHash)}, but outcome_proof.block_hash is ${encodeBase58(parsed.claimedBlockHash)}`,
    };
  }
  const merkleRoot = foldPath(blockHash, parsed.blockPath);
  if (!bytesEqual(merkleRoot, trusted.root)) {
    return {
      ok: false,
      code: "head_mismatch",
      detail: `block ${encodeBase58(blockHash)} (height ${parsed.lite.height}) and block_proof give block_merkle_root ${encodeBase58(merkleRoot)}, but ${headName(trusted.head)} has ${trusted.head.blockMerkleRoot}`,
    };
  }

  const status = provenStatus(outcome.status);
  if (expectation.id !== undefined && expectation.id !== outcome.idText) {
    return {
      ok: false,
      code: "id_mismatch",
      detail: `the proof proves outcome ${outcome.idText}, not ${expectation.id}`,
    };
  }
  if (expectation.executorId !== undefined && expectation.executorId !== outcome.executorId) {
    return {
      ok: false,
      code: "executor_mismatch",
      detail: `outcome ${outcome.idText} was executed by ${outcome.executorId}, not ${expectation.executorId}`,
    };
  }
  if (!statusMatches(status, expectation.status)) {
    return {
      ok: false,
      code: "status_mismatch",
      detail: `outcome ${outcome.idText} has status ${status.kind}, expected ${expectation.status}`,
    };
  }
  return {
    ok: true,
    outcome: {
      id: outcome.idText,
      executorId: outcome.executorId,
      logs: outcome.logs,
      receiptIds: outcome.receiptIdTexts,
      gasBurnt: outcome.gasBurnt,
      tokensBurnt: outcome.tokensBurnt,
      status,
      block: {
        hash: encodeBase58(blockHash),
        height: parsed.lite.height,
        timestampNs: parsed.lite.timestampNs,
        epochId: parsed.lite.epochIdText,
      },
      head: trusted.head,
    },
  };
}

/**
 * Verifies one `light_client_proof` answer against `head` (`head.blockMerkleRoot` is the one value it is checked
 * against) and returns the outcome it proves. Checks run in a fixed order and the earliest failure is returned:
 * structure (`malformed`, `path_too_long`), then cryptography (`outcome_root_mismatch`, `block_hash_mismatch`,
 * `head_mismatch`), then the caller's expectations (`id_mismatch`, `executor_mismatch`, `status_mismatch`; the
 * status defaults to "success"). Pure; it does not throw.
 */
export function verifyOutcomeProof(
  proof: unknown,
  head: TrustedHead,
  expect?: OutcomeExpectation,
): OutcomeProofResult {
  try {
    return verifyParsed(parseProof(proof), parseHead(head), parseExpectation(expect));
  } catch (error) {
    return refusal(error);
  }
}

/**
 * Verifies the proofs of one transaction's outcome tree under one head. `proofs[0]` is the transaction's own proof
 * (its id must be `txHash`, its executor `signerId` when given). Every other proof is a receipt's, and its id must be
 * reachable from the transaction through proven `receipt_ids`, in any order of the list, so the proof of an
 * unrelated receipt is `not_linked`. Then the tree must be complete: a receipt id that a proven outcome lists must
 * have its own proof in the list, or the result is `incomplete` (its index is the proof that lists the missing
 * receipt). So a list that leaves out a receipt, a failed one included, is refused rather than read as the whole
 * tree; the tx answer of a finished transaction lists an outcome for each of these ids. `complete: false` proves a
 * subset instead: the outcomes the list holds, each linked to the transaction, with no claim about the receipts it
 * leaves out. At most 256 proofs. Checks run in a fixed order: each proof in list order (its own codes, then
 * `duplicate`), then `not_linked`, then `incomplete`. Statuses are reported, not judged (a failed receipt is in
 * `outcomes` with `status.kind` "failure"). Pure; it does not throw.
 */
export function verifyTransactionOutcomes(
  proofs: readonly unknown[],
  head: TrustedHead,
  expect: { txHash: string; signerId?: string; complete?: boolean },
): OutcomeTreeResult {
  try {
    if (!isRecord(expect) || typeof expect.txHash !== "string") {
      return { ok: false, index: -1, code: "malformed", detail: "expect.txHash is not a string" };
    }
    if (expect.signerId !== undefined && typeof expect.signerId !== "string") {
      return { ok: false, index: -1, code: "malformed", detail: "expect.signerId is not a string" };
    }
    if (expect.complete !== undefined && typeof expect.complete !== "boolean") {
      return {
        ok: false,
        index: -1,
        code: "malformed",
        detail: "expect.complete is not a boolean",
      };
    }
    if (!Array.isArray(proofs)) {
      return { ok: false, index: -1, code: "malformed", detail: "proofs is not an array" };
    }
    if (proofs.length === 0) {
      return {
        ok: false,
        index: -1,
        code: "empty",
        detail: "no proofs: the transaction's own proof comes at index 0",
      };
    }
    if (proofs.length > MAX_TREE_PROOFS) {
      return {
        ok: false,
        index: -1,
        code: "too_many",
        detail: `${proofs.length} proofs, more than ${MAX_TREE_PROOFS}`,
      };
    }

    const outcomes: ProvenOutcome[] = [];
    const indexById = new Map<string, number>();
    for (let i = 0; i < proofs.length; i++) {
      const expectation: OutcomeExpectation =
        i === 0 ? { id: expect.txHash, status: "any" } : { status: "any" };
      if (i === 0 && expect.signerId !== undefined) expectation.executorId = expect.signerId;
      const result = verifyOutcomeProof(proofs[i], head, expectation);
      if (!result.ok) {
        return { ok: false, index: i, code: result.code, detail: `proof ${i}: ${result.detail}` };
      }
      const seen = indexById.get(result.outcome.id);
      if (seen !== undefined) {
        return {
          ok: false,
          index: i,
          code: "duplicate",
          detail: `proof ${i} proves outcome ${result.outcome.id}, which proof ${seen} already proves`,
        };
      }
      indexById.set(result.outcome.id, i);
      outcomes.push(result.outcome);
    }

    // Walk from the transaction through proven receipt_ids; the order of the list does not matter.
    const root = outcomes[0] as ProvenOutcome;
    const reached = new Set<string>([root.id]);
    const queue: ProvenOutcome[] = [root];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      for (const receiptId of next.receiptIds) {
        if (reached.has(receiptId)) continue;
        reached.add(receiptId);
        const index = indexById.get(receiptId);
        if (index !== undefined) queue.push(outcomes[index] as ProvenOutcome);
      }
    }
    for (let i = 1; i < outcomes.length; i++) {
      const outcome = outcomes[i] as ProvenOutcome;
      if (!reached.has(outcome.id)) {
        return {
          ok: false,
          index: i,
          code: "not_linked",
          detail: `proof ${i} proves receipt ${outcome.id}, which no proven outcome of transaction ${expect.txHash} created`,
        };
      }
    }
    if (expect.complete !== false) {
      // Every outcome is linked by now, so a receipt id with no proof is a receipt of this transaction left out.
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i] as ProvenOutcome;
        const missing = outcome.receiptIds.find((receiptId) => !indexById.has(receiptId));
        if (missing !== undefined) {
          return {
            ok: false,
            index: i,
            code: "incomplete",
            detail: `proof ${i} proves that outcome ${outcome.id} created receipt ${missing}, and no proof in the list proves that receipt: the tree of transaction ${expect.txHash} is not complete`,
          };
        }
      }
    }
    return { ok: true, outcomes };
  } catch (error) {
    return { index: -1, ...refusal(error) };
  }
}
