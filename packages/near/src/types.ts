// Shared data types (S0, integrator-owned and frozen): the shapes the outcome proof verifier (N1), the event
// reader (N2) and the POA check (N4) pass between them.

/** One outcome as RPC `tx` / `EXPERIMENTAL_tx_status` return it (`transaction_outcome`, `receipts_outcome[i]`). */
export interface OutcomeLike {
  id: string;
  block_hash?: string;
  outcome: {
    executor_id: string;
    logs: readonly string[];
    receipt_ids?: readonly string[];
    status?: unknown;
  };
}

/** The parts of an RPC `tx` answer the readers use. A full answer fits as is. */
export interface TxTreeLike {
  transaction?: { hash?: string; signer_id?: string; receiver_id?: string };
  transaction_outcome?: OutcomeLike;
  receipts_outcome: readonly OutcomeLike[];
}

export type ReceiptStatusKind = "success" | "failure" | "unknown";

export type MerkleDirection = "Left" | "Right";

export interface MerklePathItem {
  hash: string;
  direction: MerkleDirection;
}

/** A block the caller already trusts. Only `blockMerkleRoot` is used to verify; `hash`/`height` are for messages. */
export interface TrustedHead {
  blockMerkleRoot: string;
  hash?: string;
  height?: number;
}

export type ProvenStatus =
  | { kind: "success_value"; value: Uint8Array }
  | { kind: "success_receipt_id"; receiptId: string }
  | { kind: "failure" } // the reason is not in the proof
  | { kind: "unknown" };

/** An execution outcome whose every field below was recomputed from a light_client_proof under `head`. */
export interface ProvenOutcome {
  id: string;
  executorId: string;
  logs: readonly string[];
  receiptIds: readonly string[];
  gasBurnt: bigint;
  tokensBurnt: bigint;
  status: ProvenStatus;
  /** The block whose header commits this outcome: outcome_proof.block_hash, recomputed from block_header_lite. */
  block: { hash: string; height: number; timestampNs: bigint; epochId: string };
  head: TrustedHead;
}

/** Where events and burns are read from: an RPC tx answer (trusts that RPC), or proven outcomes (trusts the head). */
export type OutcomeSource = TxTreeLike | readonly ProvenOutcome[];
